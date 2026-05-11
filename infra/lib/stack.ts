import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';

const DEFAULT_HAIKU  = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/**
 * Agentic Prompt Validator — 2-Lambda architecture.
 *
 * IntakeFn (apv-intake-lambda)  : all REST routes (prompts + rules).
 * WorkerFn (apv-worker-lambda)  : full scoring + refinement loop. Invoked async by IntakeFn.
 *
 * The previous Step Functions state machine, AgentCore Runtime, Invoker / Aggregator /
 * Refinement / KB Lambdas have been removed; their logic is consolidated into the
 * worker, and the human-in-the-loop "pause" is handled by writing
 * status=awaiting_review to DDB rather than by SFN waitForTaskToken.
 */
export class PromptValidatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const haikuModel  = (this.node.tryGetContext('haikuModel')  as string) || DEFAULT_HAIKU;
    const sonnetModel = (this.node.tryGetContext('sonnetModel') as string) || DEFAULT_SONNET;

    // ---------------------------------------------------------------- S3
    const promptsBucket = new s3.Bucket(this, 'PromptsBucket', {
      bucketName: 'apv-prompts-storage',
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{ allowedMethods: [s3.HttpMethods.GET], allowedOrigins: ['*'], allowedHeaders: ['*'] }],
    });

    new s3deploy.BucketDeployment(this, 'DomainRulesDeploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'lambdas', 'domain_rules'))],
      destinationBucket: promptsBucket,
      destinationKeyPrefix: 'domain_rules',
      prune: false,
    });

    // ---------------------------------------------------------------- DynamoDB
    const table = new dynamodb.Table(this, 'PromptTable', {
      tableName: 'apv-logs',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1_status',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---------------------------------------------------------------- IAM helpers
    const basicExec = iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole');
    const mkRole = (id: string, name: string) => new iam.Role(this, id, {
      roleName: name,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [basicExec],
    });
    const bedrockPolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    });

    const coreEnv: Record<string, string> = {
      TABLE_NAME:                table.tableName,
      BUCKET_NAME:               promptsBucket.bucketName,
      HAIKU_MODEL:               haikuModel,
      SONNET_MODEL:              sonnetModel,
      MAX_REFINEMENT_ITERATIONS: '3',
    };

    // ---------------------------------------------------------------- Worker Lambda
    // Runs the entire scoring + refinement loop. Invoked async by the API Lambda.
    const workerRole = mkRole('WorkerFnRole', 'apv-worker-lambda-role');
    workerRole.addToPolicy(bedrockPolicy);

    const workerFn = new lambda.Function(this, 'WorkerFn', {
      functionName: 'apv-worker-lambda',
      role: workerRole,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'worker')),
      memorySize: 1024,
      timeout: cdk.Duration.minutes(10),
      environment: coreEnv,
    });
    table.grantReadWriteData(workerFn);
    promptsBucket.grantReadWrite(workerFn);

    // ---------------------------------------------------------------- Intake (API) Lambda
    // Handles every REST route. Invokes the worker asynchronously.
    // Logical ID kept as `IntakeFn` to minimise CFN churn against the existing stack;
    // physical name kept as `apv-intake-lambda` for the same reason.
    const intakeRole = mkRole('IntakeFnRole', 'apv-intake-lambda-role');

    const intakeFn = new lambda.Function(this, 'IntakeFn', {
      functionName: 'apv-intake-lambda',
      role: intakeRole,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'api')),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME:           table.tableName,
        BUCKET_NAME:          promptsBucket.bucketName,
        WORKER_FUNCTION_NAME: workerFn.functionName,
      },
    });
    table.grantReadWriteData(intakeFn);
    promptsBucket.grantReadWrite(intakeFn);
    workerFn.grantInvoke(intakeFn);

    // ---------------------------------------------------------------- API Gateway
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'agentic-prompt-validator-api',
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: { stageName: 'APV' },
      cloudWatchRole: false,
    });

    const apiInteg = new apigw.LambdaIntegration(intakeFn, { proxy: true });

    const prompts = api.root.addResource('prompts');
    prompts.addMethod('POST', apiInteg);
    prompts.addMethod('GET',  apiInteg);
    const promptItem = prompts.addResource('{id}');
    promptItem.addMethod('GET',    apiInteg);
    promptItem.addMethod('DELETE', apiInteg);
    promptItem.addResource('review').addMethod('POST', apiInteg);

    const rules = api.root.addResource('rules');
    rules.addMethod('GET', apiInteg);
    const rulesDomain = rules.addResource('{domain}');
    rulesDomain.addMethod('GET', apiInteg);
    rulesDomain.addMethod('PUT', apiInteg);

    // ---------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint',         { value: api.url });
    new cdk.CfnOutput(this, 'TableName',           { value: table.tableName });
    new cdk.CfnOutput(this, 'BucketName',          { value: promptsBucket.bucketName });
    new cdk.CfnOutput(this, 'IntakeFunctionName',  { value: intakeFn.functionName });
    new cdk.CfnOutput(this, 'WorkerFunctionName',  { value: workerFn.functionName });
  }
}
