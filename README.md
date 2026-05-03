# Prompt Validator

Agentic prompt validator on AWS with human-in-the-loop review.

## Architecture

```
            ┌─────────────────────────┐
            │  Amplify (Next.js UI)   │  submit · status · review queue
            └────────────┬────────────┘
                         │ HTTPS
                  ┌──────▼──────┐
                  │ API Gateway │  REST
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │   Intake    │  POST /prompts → S3 + DDB → start SFN
                  │   Lambda    │  POST /prompts/{id}/review → SendTaskSuccess
                  └──────┬──────┘
                         │
                  ┌──────▼──────────────────────┐
                  │ Step Functions state machine │
                  └──────┬──────────────────────┘
                         │
                  ┌──────▼──────┐    parallel internal threads:
                  │ Aggregator  │ ─→ ┌─ Token check  (Haiku 4.5 agent)
                  │  Lambda     │ ─→ ├─ Clarity check (Sonnet 4.5 agent)
                  └──────┬──────┘ ─→ └─ Safety check  (Sonnet 4.5 agent)
                         │            + self-confidence (Haiku InvokeModel)
                  ┌──────▼─────────────┐
                  │   Choice           │
                  │ approve / refine / │
                  │ review             │
                  └──┬───────┬───────┬─┘
       approve ──────┘       │       └────── review (wait task token)
                             │                          │
                       ┌─────▼─────┐                    │ human action
                       │Refinement │◄───────── edit ────┘
                       │  Lambda   │ (Sonnet rewrite, max 3 iterations)
                       └─────┬─────┘
                             │
                             ▼ loop back to Aggregator
```

**AWS resources created**

- 1 S3 bucket (originals · refined · audit JSON)
- 1 DynamoDB table with one GSI on status
- 3 Bedrock Agents (token / clarity / safety) + IAM role
- 3 Lambdas (intake · aggregator · refinement)
- 1 Step Functions state machine
- 1 API Gateway (REST)
- CloudWatch log groups

Frontend hosting is set up separately in the Amplify console (one-click git connect).

## Prerequisites

- Node.js 20+
- Python 3.12 (Lambda runtime — only needed if you want to run/test handlers locally)
- AWS CLI v2, configured with credentials for `us-east-1`
- AWS CDK v2 (`npm i -g aws-cdk`)
- **Bedrock model access** in your account, region `us-east-1`, for:
  - `anthropic.claude-haiku-4-5-*`
  - `anthropic.claude-sonnet-4-5-*`
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
npx cdk bootstrap          # one-time per account/region
npx cdk deploy
```

If your account uses different Bedrock model IDs (the defaults assume cross-region inference profiles), override:

```bash
npx cdk deploy \
  --context haikuModel=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --context sonnetModel=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

The deploy prints these outputs — save them:

- `ApiEndpoint` — the REST API base URL
- `BucketName`, `TableName`, `StateMachineArn` — for debugging
- `TokenAgentId`, `ClarityAgentId`, `SafetyAgentId` — Bedrock agent IDs

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

| Method | Path                       | Body                                       | Returns |
| ------ | -------------------------- | ------------------------------------------ | ------- |
| POST   | `/prompts`                 | `{ prompt, domain }`                       | `{ prompt_id, status }` (202) |
| GET    | `/prompts?status=...`      | —                                          | `{ items: Meta[] }` |
| GET    | `/prompts/{id}`            | —                                          | `{ meta, records }` |
| POST   | `/prompts/{id}/review`     | `{ action: approve\|reject\|edit, edited_prompt? }` | `{ ok: true }` |

## DynamoDB layout

Single-table: `pk = prompt_id`, `sk` distinguishes record types:

- `META`              — main prompt record (status, scores, current_prompt, task_token)
- `AGG#NN#<ts>`       — per-iteration aggregator output
- `REFINE#NN`         — refinement diff (before/after, source = llm_refine | human_edit)

GSI `GSI1_status` on (status, updated_at) → drives the review queue.

## Step Functions decision logic

- `composite_score >= 0.85` AND `severity = LOW` AND `confidence >= 0.7` → **approve**
- `composite_score < 0.5` OR `severity = HIGH` OR `confidence < 0.7` → **review**
- otherwise → **refine** (auto-loop, capped at 3 iterations; then forced to **review**)

Composite weights: token 0.25 · clarity 0.35 · safety 0.40 (tweak in `aggregator/handler.py`).

## Costs to watch

- Bedrock Agent invocations dominate per-prompt cost (≈4 LLM calls per iteration: 3 agents + self-confidence).
- DynamoDB and S3 charges are negligible at this scale (PAY_PER_REQUEST + S3 standard).
- API Gateway and Step Functions Standard are flat-rate per request / per state transition.

## Tear down

```bash
cd infra && npx cdk destroy
```

Empties the S3 bucket on destroy (`autoDeleteObjects: true`).
