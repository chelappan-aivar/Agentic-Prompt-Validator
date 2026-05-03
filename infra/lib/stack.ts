import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

const DEFAULT_HAIKU  = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

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

    // ---------------------------------------------------------------- Shared helpers
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

    // ---------------------------------------------------------------- AgentCore Runtime Docker image
    // Built locally targeting linux/arm64, pushed to CDK staging ECR.
    // All dependencies (bedrock-agentcore, boto3) pre-installed at build time — no pip at startup.
    const agentImage = new ecr_assets.DockerImageAsset(this, 'AgentRuntimeImage', {
      directory: path.join(__dirname, '..', '..', 'lambdas', 'agentcore_runtime'),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    // ---------------------------------------------------------------- AgentCore Runtime IAM role
    // Used by the AgentCore Runtime process to call Bedrock, DynamoDB, and S3.
    const agentcoreRuntimeRole = new iam.Role(this, 'AgentCoreRuntimeRole', {
      roleName: 'apv-agentcore-runtime-role',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    agentcoreRuntimeRole.addToPolicy(bedrockPolicy);
    table.grantReadWriteData(agentcoreRuntimeRole);
    promptsBucket.grantReadWrite(agentcoreRuntimeRole);
    // Grant ECR read permissions so the runtime can pull the image
    agentcoreRuntimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:BatchCheckLayerAvailability', 'ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // ---------------------------------------------------------------- AWS::BedrockAgentCore::Runtime
    // ID changed from AgentCoreRuntime → AgentCoreRuntimeV2 to force replacement
    // (artifact type CodeConfiguration→ContainerConfiguration is immutable).
    const agentCoreRuntime = new cdk.CfnResource(this, 'AgentCoreRuntimeV2', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: 'apvPromptValidatorV2',
        Description: 'Agentic Prompt Validator — multi-agent scorer and refiner',
        RoleArn: agentcoreRuntimeRole.roleArn,
        NetworkConfiguration: { NetworkMode: 'PUBLIC' },
        ProtocolConfiguration: 'HTTP',
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: agentImage.imageUri,
          },
        },
        EnvironmentVariables: {
          TABLE_NAME:   table.tableName,
          BUCKET_NAME:  promptsBucket.bucketName,
          HAIKU_MODEL:  haikuModel,
          SONNET_MODEL: sonnetModel,
        },
        LifecycleConfiguration: {
          IdleRuntimeSessionTimeout: 300,
          MaxLifetime: 3600,
        },
      },
    });
    // Ensure the runtime waits for the IAM role AND all its attached policies
    // before attempting ECR URI validation (avoids race on UPDATE).
    agentCoreRuntime.node.addDependency(agentcoreRuntimeRole);

    // ---------------------------------------------------------------- Invoker Lambda
    // Thin SigV4-signed bridge: Step Functions → this Lambda → AgentCore Runtime HTTP endpoint.
    const invokerRole = mkRole('InvokerFnRole', 'apv-invoker-lambda-role');
    invokerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: ['*'],
    }));

    const invokerFn = new lambda.Function(this, 'InvokerFn', {
      functionName: 'apv-invoker-lambda',
      role: invokerRole,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'invoker')),
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      environment: {
        AGENTCORE_RUNTIME_ARN: cdk.Token.asString(agentCoreRuntime.getAtt('AgentRuntimeArn')),
      },
    });
    invokerFn.node.addDependency(agentCoreRuntime);

    // ---------------------------------------------------------------- KB Lambda
    const kbRole = mkRole('KbFnRole', 'apv-kb-lambda-role');
    const kbFn = new lambda.Function(this, 'KbFn', {
      functionName: 'apv-kb-lambda',
      role: kbRole,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'kb')),
      memorySize: 128,
      timeout: cdk.Duration.seconds(15),
      environment: { TABLE_NAME: table.tableName, BUCKET_NAME: promptsBucket.bucketName },
    });
    promptsBucket.grantReadWrite(kbFn);

    // ---------------------------------------------------------------- Intake Lambda
    const intakeRole = mkRole('IntakeFnRole', 'apv-intake-lambda-role');
    const intakeFn = new lambda.Function(this, 'IntakeFn', {
      functionName: 'apv-intake-lambda',
      role: intakeRole,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'intake')),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: { ...coreEnv, STATE_MACHINE_ARN: '' }, // patched below
    });
    table.grantReadWriteData(intakeFn);
    promptsBucket.grantReadWrite(intakeFn);

    // ---------------------------------------------------------------- Step Functions
    const initState = new sfn.Pass(this, 'Init', {
      parameters: {
        'prompt_id.$': '$.prompt_id',
        'prompt.$':    '$.prompt',
        'domain.$':    '$.domain',
        'iteration.$': '$.iteration',
        review: { action: 'none' },
      },
    });

    // Score step: invoker → AgentCore Runtime (action_type=score)
    const aggregatorTask = new tasks.LambdaInvoke(this, 'AgentCoreScoreInvoke', {
      lambdaFunction: invokerFn,
      payload: sfn.TaskInput.fromObject({
        action_type: 'score',
        prompt_id:   sfn.JsonPath.stringAt('$.prompt_id'),
        prompt:      sfn.JsonPath.stringAt('$.prompt'),
        domain:      sfn.JsonPath.stringAt('$.domain'),
        'iteration.$': '$.iteration',
      }),
      resultSelector: {
        'action.$':           '$.Payload.action',
        'composite_score.$':  '$.Payload.composite_score',
        'confidence.$':       '$.Payload.confidence',
        'severity.$':         '$.Payload.severity',
        'scores.$':           '$.Payload.scores',
        'flags.$':            '$.Payload.flags',
        'similar_approved.$': '$.Payload.similar_approved',
      },
      resultPath: '$.aggregator',
    });

    // Refine step: invoker → AgentCore Runtime (action_type=refine)
    const refinementTask = new tasks.LambdaInvoke(this, 'AgentCoreRefineInvoke', {
      lambdaFunction: invokerFn,
      payload: sfn.TaskInput.fromObject({
        action_type: 'refine',
        prompt_id:   sfn.JsonPath.stringAt('$.prompt_id'),
        prompt:      sfn.JsonPath.stringAt('$.prompt'),
        domain:      sfn.JsonPath.stringAt('$.domain'),
        'iteration.$': '$.iteration',
        'aggregator.$': '$.aggregator',
        'review.$':    '$.review',
      }),
      resultSelector: {
        'prompt.$':    '$.Payload.refined_prompt',
        'iteration.$': '$.Payload.iteration',
      },
      resultPath: '$.refinement',
    });

    const reshapeAfterRefinement = new sfn.Pass(this, 'ReshapeAfterRefinement', {
      parameters: {
        'prompt_id.$': '$.prompt_id',
        'domain.$':    '$.domain',
        'prompt.$':    '$.refinement.prompt',
        'iteration.$': '$.refinement.iteration',
        review: { action: 'none' },
      },
    });

    const markApproved = new tasks.CallAwsService(this, 'MarkApproved', {
      service: 'dynamodb', action: 'updateItem',
      parameters: {
        TableName: table.tableName,
        Key: { pk: { S: sfn.JsonPath.stringAt('$.prompt_id') }, sk: { S: 'META' } },
        UpdateExpression: 'SET #s = :s, gsi1pk = :s, gsi1sk = :ts, final_action = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s':  { S: 'approved' },
          ':ts': { S: sfn.JsonPath.stringAt('$$.State.EnteredTime') },
          ':a':  { S: 'approved' },
        },
      },
      iamResources: [table.tableArn],
      resultPath: sfn.JsonPath.DISCARD,
    });

    const markRejected = new tasks.CallAwsService(this, 'MarkRejected', {
      service: 'dynamodb', action: 'updateItem',
      parameters: {
        TableName: table.tableName,
        Key: { pk: { S: sfn.JsonPath.stringAt('$.prompt_id') }, sk: { S: 'META' } },
        UpdateExpression: 'SET #s = :s, gsi1pk = :s, gsi1sk = :ts, final_action = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s':  { S: 'rejected' },
          ':ts': { S: sfn.JsonPath.stringAt('$$.State.EnteredTime') },
          ':a':  { S: 'rejected' },
        },
      },
      iamResources: [table.tableArn],
      resultPath: sfn.JsonPath.DISCARD,
    });

    const waitForReview = new tasks.CallAwsService(this, 'WaitForReview', {
      service: 'dynamodb', action: 'updateItem',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      parameters: {
        TableName: table.tableName,
        Key: { pk: { S: sfn.JsonPath.stringAt('$.prompt_id') }, sk: { S: 'META' } },
        UpdateExpression: 'SET #s = :s, gsi1pk = :s, gsi1sk = :ts, task_token = :tt, agg = :agg',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s':   { S: 'awaiting_review' },
          ':ts':  { S: sfn.JsonPath.stringAt('$$.State.EnteredTime') },
          ':tt':  { S: sfn.JsonPath.taskToken },
          ':agg': { S: sfn.JsonPath.stringAt('States.JsonToString($.aggregator)') },
        },
      },
      iamResources: [table.tableArn],
      resultPath: '$.review',
    });

    const succeed = new sfn.Succeed(this, 'Done');

    markApproved.next(succeed);
    markRejected.next(succeed);
    refinementTask.next(reshapeAfterRefinement).next(aggregatorTask);

    const reviewChoice = new sfn.Choice(this, 'ReviewActionChoice')
      .when(sfn.Condition.stringEquals('$.review.action', 'approve'), markApproved)
      .when(sfn.Condition.stringEquals('$.review.action', 'reject'),  markRejected)
      .when(sfn.Condition.stringEquals('$.review.action', 'edit'),    refinementTask)
      .otherwise(markRejected);

    waitForReview.next(reviewChoice);

    const iterationCheck = new sfn.Choice(this, 'IterationCap')
      .when(sfn.Condition.numberLessThan('$.iteration', 3), refinementTask)
      .otherwise(waitForReview);

    const aggregatorChoice = new sfn.Choice(this, 'AggregatorActionChoice')
      .when(sfn.Condition.stringEquals('$.aggregator.action', 'approve'), markApproved)
      .when(sfn.Condition.stringEquals('$.aggregator.action', 'review'),  waitForReview)
      .when(sfn.Condition.stringEquals('$.aggregator.action', 'refine'),  iterationCheck)
      .otherwise(waitForReview);

    aggregatorTask.next(aggregatorChoice);
    initState.next(aggregatorTask);

    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      roleName: 'apv-state-machine-lambda-role',
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: 'apv-state-machine',
      role: stateMachineRole,
      definitionBody: sfn.DefinitionBody.fromChainable(initState),
      timeout: cdk.Duration.hours(24),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    intakeFn.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);
    stateMachine.grantStartExecution(intakeFn);
    intakeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));

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

    const intakeInteg = new apigw.LambdaIntegration(intakeFn, { proxy: true });
    const kbInteg     = new apigw.LambdaIntegration(kbFn,     { proxy: true });

    const prompts = api.root.addResource('prompts');
    prompts.addMethod('POST', intakeInteg);
    prompts.addMethod('GET',  intakeInteg);
    const promptItem = prompts.addResource('{id}');
    promptItem.addMethod('GET', intakeInteg);
    promptItem.addResource('review').addMethod('POST', intakeInteg);

    const rules = api.root.addResource('rules');
    rules.addMethod('GET', kbInteg);
    const rulesDomain = rules.addResource('{domain}');
    rulesDomain.addMethod('GET', kbInteg);
    rulesDomain.addMethod('PUT', kbInteg);

    // ---------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint',         { value: api.url });
    new cdk.CfnOutput(this, 'TableName',           { value: table.tableName });
    new cdk.CfnOutput(this, 'BucketName',          { value: promptsBucket.bucketName });
    new cdk.CfnOutput(this, 'StateMachineArn',     { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'AgentCoreRuntimeArn', {
      value: cdk.Token.asString(agentCoreRuntime.getAtt('AgentRuntimeArn')),
      description: 'AgentCore Runtime ARN',
    });
  }
}
