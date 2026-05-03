#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PromptValidatorStack } from '../lib/stack';

const app = new cdk.App();

new PromptValidatorStack(app, 'AgenticPromptValidatorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Agentic prompt validator with Bedrock Agents + human-in-the-loop',
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: 'apv',
    fileAssetsBucketName: 'cdk-apv-assets-${AWS::AccountId}-${AWS::Region}',
    bucketPrefix: '',
    bootstrapStackVersionSsmParameter: '/cdk-bootstrap/apv/version',
  }),
});
