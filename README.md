# Prompt Validator

Agentic prompt validator on AWS with human-in-the-loop review, powered by Amazon Bedrock AgentCore Runtime.

## Architecture

```
            ┌─────────────────────────┐
            │  Amplify (Next.js UI)   │  submit · status · review queue · rules editor
            └────────────┬────────────┘
                         │ HTTPS
                  ┌──────▼──────┐
                  │ API Gateway │  REST
                  └──────┬──────┘
                         │
              ┌──────────┼──────────┐
              │                     │
       ┌──────▼──────┐       ┌──────▼──────┐
       │   Intake    │       │     KB      │  GET/PUT /rules/{domain}
       │   Lambda    │       │   Lambda    │  (domain rule JSON files in S3)
       └──────┬──────┘       └─────────────┘
              │
     POST /prompts → S3 + DDB → start SFN
     POST /prompts/{id}/review → SendTaskSuccess
              │
       ┌──────▼──────────────────────┐
       │ Step Functions state machine │
       └──────┬──────────────────────┘
              │
       ┌──────▼──────┐
       │   Invoker   │  SigV4-signed HTTP bridge
       │   Lambda    │
       └──────┬──────┘
              │  POST /invocations
       ┌──────▼──────────────────────────────────┐
       │  Bedrock AgentCore Runtime              │
       │  (Docker container — arm64)             │
       │                                         │
       │  action_type=score:                     │
       │    parallel threads:                    │
       │    ├─ token check   (Haiku 4.5)         │
       │    ├─ clarity check (Sonnet 4.5)        │
       │    ├─ safety check  (Sonnet 4.5)        │
       │    └─ suggestion    (Sonnet 4.5)        │
       │    + verify_fix     (Haiku 4.5)         │
       │                                         │
       │  action_type=refine:                    │
       │    LLM rewrite (Sonnet) or human edit   │
       └──────┬──────────────────────────────────┘
              │
       ┌──────▼─────────────┐
       │   Choice           │
       │ approve / refine / │
       │ review             │
       └──┬───────┬───────┬─┘
approve ──┘       │       └────── review (waitForTaskToken)
                  │                      │
            ┌─────▼─────┐               │ human action
            │  Invoker  │◄──── edit ────┘
            │  (refine) │ (AgentCore human-edit path)
            └─────┬─────┘
                  │
                  ▼ loop back to score (max 3 iterations)
```

**AWS resources created**

- 1 S3 bucket (originals · refined · audit JSON · domain rules)
- 1 DynamoDB table with one GSI on status
- 1 Bedrock AgentCore Runtime (Docker container, arm64, ECR-hosted image)
- 3 Lambdas (intake · invoker · kb)
- 1 Step Functions state machine
- 1 API Gateway (REST)
- CloudWatch log groups

Frontend hosting is set up separately in the Amplify console (one-click git connect).

## Prerequisites

- Node.js 20+
- Python 3.12 (only needed if you want to run/test handlers locally)
- AWS CLI v2, configured with credentials for `us-east-1`
- AWS CDK v2 (`npm i -g aws-cdk`)
- **Docker** — the CDK deploy builds a Docker image for the AgentCore Runtime and pushes it to ECR; Docker daemon must be running
- **Bedrock model access** in your account, region `us-east-1`, for:
  - `us.anthropic.claude-haiku-4-5-20251001-v1:0` (cross-region inference profile)
  - `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference profile)
  Check via console: Bedrock → Model access. If unavailable, request it.

## 1. Configure AWS credentials

```bash
aws configure --profile prompt-validator
# AWS Access Key ID: ...
# AWS Secret Access Key: ...
# Default region: us-east-1

export AWS_PROFILE=prompt-validator
export AWS_REGION=us-east-1
```

## 2. Deploy infrastructure

```bash
cd infra
npm install
npx cdk bootstrap --qualifier apv   # one-time per account/region
npx cdk deploy
```

The deploy builds the AgentCore Runtime Docker image locally and pushes it to the CDK staging ECR. Docker must be running before you deploy.

If your account uses different Bedrock model IDs, override:

```bash
npx cdk deploy \
  --context haikuModel=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --context sonnetModel=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

The deploy prints these outputs — save them:

- `ApiEndpoint` — the REST API base URL
- `BucketName`, `TableName`, `StateMachineArn` — for debugging
- `AgentCoreRuntimeArn` — the AgentCore Runtime ARN

## 3. Configure & run the frontend

```bash
cd ../frontend
cp .env.example .env.local
# edit .env.local and set NEXT_PUBLIC_API_URL to the ApiEndpoint above
npm install
npm run dev          # http://localhost:3000
```

## 4. Deploy the frontend on Amplify Hosting

1. Push this repo to GitHub.
2. Open the AWS Amplify console → **Create new app** → **Host web app** → **GitHub** → pick the repo and branch.
3. Amplify auto-detects Next.js and reads `frontend/amplify.yml`.
4. **Environment variables**: add `NEXT_PUBLIC_API_URL` with the `ApiEndpoint` value.
5. **Save and deploy**.

Subsequent pushes auto-redeploy. The Amplify-generated domain (e.g. `https://main.dxxxx.amplifyapp.com`) is your live UI.

## API reference

### Prompts

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| POST | `/prompts` | `{ prompt, domain }` | `{ prompt_id, status }` (202) |
| GET | `/prompts?status=...` | — | `{ items: Meta[] }` |
| GET | `/prompts/{id}` | — | `{ meta, records }` |
| POST | `/prompts/{id}/review` | `{ action: approve\|reject\|edit, edited_prompt? }` | `{ ok: true }` |

### Domain rules

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET | `/rules` | — | `{ domains: DomainSummary[] }` |
| GET | `/rules/{domain}` | — | full rule JSON for the domain |
| PUT | `/rules/{domain}` | rule JSON | `{ ok: true }` |

Valid domains: `medical`, `legal`, `financial`, `marketing`, `technical`, `general`.

## DynamoDB layout

Single-table: `pk = prompt_id`, `sk` distinguishes record types:

- `META` — main prompt record (status, scores, current_prompt, task_token)
- `AGG#NN#<ts>` — per-iteration AgentCore score output
- `REFINE#NN` — refinement diff (before/after, source = `llm_refine` | `human_edit`)

GSI `GSI1_status` on (status, updated_at) → drives the review queue.

## Step Functions decision logic

The AgentCore Runtime returns an `action` field on every `score` call:

- `composite_score >= 0.85` AND `severity = LOW` AND `confidence >= 0.7` → **approve**
- `composite_score < 0.5` OR `severity = HIGH` OR `confidence < 0.7` → **review**
- otherwise → **refine** (auto-loop, capped at 3 iterations; then forced to **review**)

Composite weights: token 0.25 · clarity 0.35 · safety 0.40 (tunable in `lambdas/agentcore_runtime/agent.py`, constant `WEIGHTS`).

## AgentCore Runtime

The runtime runs in a Docker container (`lambdas/agentcore_runtime/`) on `AWS::BedrockAgentCore::Runtime` with `ContainerConfiguration`. All dependencies (`bedrock-agentcore`, `boto3`) are pre-installed at Docker build time — no pip at container startup.

The container uses `BedrockAgentCoreApp` (Starlette ASGI) which handles the initialization handshake required by the AgentCore control plane. It exposes two action types:

- **`score`** — runs token/clarity/safety checks + suggestion + verify_fix in parallel threads; persists to DDB and S3; returns scoring decision
- **`refine`** — rewrites the prompt with Sonnet (LLM path) or applies a human-supplied edit; persists the diff; returns refined prompt and updated iteration counter

## Costs to watch

- Bedrock Converse API calls dominate per-prompt cost (5 parallel calls per iteration: token check, clarity check, safety check, suggestion, verify_fix).
- AgentCore Runtime: charged while active; idle sessions time out after 5 minutes.
- DynamoDB and S3 charges are negligible at this scale (PAY_PER_REQUEST + S3 standard).
- API Gateway and Step Functions Standard are flat-rate per request / per state transition.

Rough per-prompt cost (single iteration, ~200-token prompt):
- Haiku calls (token check + verify_fix): ~$0.000002
- Sonnet calls (clarity + safety + suggestion): ~$0.000012
- **Total: ~$0.000014 per run**

## Tear down

```bash
cd infra && npx cdk destroy
```

Empties the S3 bucket on destroy (`autoDeleteObjects: true`). The ECR image in the CDK staging ECR is not automatically deleted — remove it manually from the `cdk-apv-assets-*` ECR repository if needed.
