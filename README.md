# Prompt Validator

Agentic prompt validator on AWS with human-in-the-loop review, powered by Amazon Bedrock.

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
                  ┌──────▼──────────────────────────────┐
                  │  Intake (API) Lambda                │
                  │  apv-intake-lambda                  │
                  │                                     │
                  │  POST /prompts        → S3 + DDB +  │
                  │                         async-invoke│
                  │  POST /prompts/{id}/review → invoke │
                  │  GET  /prompts                      │
                  │  GET  /prompts/{id}                 │
                  │  DELETE /prompts/{id}               │
                  │  GET/PUT /rules/{domain}            │
                  └──────┬──────────────────────────────┘
                         │ Lambda Invoke (Event)
                  ┌──────▼──────────────────────────────────┐
                  │  Worker Lambda                          │
                  │  apv-worker-lambda                      │
                  │                                         │
                  │  Loop (up to 3 iterations):             │
                  │   1. score                              │
                  │       parallel threads:                 │
                  │       ├─ token check   (Haiku 4.5)      │
                  │       ├─ clarity check (Sonnet 4.5)     │
                  │       └─ safety check  (Sonnet 4.5)     │
                  │       then:                             │
                  │       ├─ suggestion    (Sonnet 4.5)     │
                  │       └─ verify_fix    (Haiku 4.5)      │
                  │   2. decide approve / refine / review   │
                  │   3a. approve → DDB status=approved     │
                  │   3b. review  → DDB status=awaiting_    │
                  │                 review, exit            │
                  │   3c. refine  → LLM rewrite (Sonnet),   │
                  │                 next iteration          │
                  └──────────┬──────────────────────────────┘
                             │
              ┌──────────────▼───────────────┐
              │  DDB status drives queue;    │
              │  human review action POSTs   │
              │  back through the API        │
              │  → re-invokes Worker with    │
              │     review_resume (edit      │
              │     restarts the loop)       │
              └──────────────────────────────┘
```

**AWS resources created**

- 1 S3 bucket (originals · refined · audit JSON · domain rules)
- 1 DynamoDB table with one GSI on status
- 2 Lambdas (intake/API · worker)
- 1 API Gateway (REST)
- CloudWatch log groups

There is **no** Step Functions state machine, no AgentCore Runtime, no ECR Docker image, no Invoker / Aggregator / Refinement / KB Lambdas. All orchestration is plain Python in the worker; the human-in-the-loop "pause" is handled by writing `status = awaiting_review` to DDB and re-invoking the worker when the reviewer acts.

Frontend hosting is set up separately on Amplify (manual zip deploy or one-click git connect).

## Prerequisites

- Node.js 20+
- Python 3.12 (only needed if you want to run/test handlers locally)
- AWS CLI v2, configured with credentials for `us-east-1`
- AWS CDK v2 (`npm i -g aws-cdk`)
- **Bedrock model access** in your account, region `us-east-1`, for:
  - `us.anthropic.claude-haiku-4-5-20251001-v1:0` (cross-region inference profile)
  - `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference profile)
  Check via console: Bedrock → Model access. If unavailable, request it.

> No Docker daemon required — the 2-Lambda architecture has no container builds.

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

If your account uses different Bedrock model IDs, override:

```bash
npx cdk deploy \
  --context haikuModel=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --context sonnetModel=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

The deploy prints these outputs — save them:

- `ApiEndpoint` — the REST API base URL
- `BucketName`, `TableName` — for debugging
- `IntakeFunctionName`, `WorkerFunctionName` — the two Lambdas

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
| POST | `/prompts` | `{ prompt, domain, target_model? }` | `{ prompt_id, status }` (202) |
| GET | `/prompts?status=...` | — | `{ items: Meta[] }` |
| GET | `/prompts/{id}` | — | `{ meta, records }` |
| DELETE | `/prompts/{id}` | — | `{ ok: true, deleted_records, deleted_objects }` |
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

- `META` — main prompt record (status, scores, current_prompt, domain, target_model)
- `AGG#NN#<ts>` — per-iteration score output (scores, flags, suggestion, usage tokens)
- `REFINE#NN` — refinement diff (before/after, source = `llm_refine` | `human_edit`)

GSI `GSI1_status` on (status, updated_at) → drives the review queue and approved library.

## Decision logic (in worker Lambda)

After each scoring iteration the worker decides:

- `composite_score >= 0.85` AND `severity = LOW` AND `confidence >= 0.7` → **approve** → DDB `status=approved`, return
- `composite_score < 0.5` OR `severity = HIGH` OR `confidence < 0.7` → **review** → DDB `status=awaiting_review`, return (worker exits)
- otherwise → **refine** → LLM rewrite, continue loop

After 3 iterations without an `approve`, the prompt is forced to `awaiting_review`.

Composite weights: token 0.25 · clarity 0.35 · safety 0.40 (tunable in `lambdas/worker/handler.py`, constant `WEIGHTS`).

## Human-in-the-loop

When a prompt lands in `awaiting_review`, the UI's review queue picks it up. A reviewer's action `POST /prompts/{id}/review` triggers the intake Lambda to async-invoke the worker with `action: review_resume`:

- `approve` / `reject` → worker writes the final status; done.
- `edit` → worker treats the edited text as a `human_edit` refinement, then re-enters the scoring loop from the next iteration.

No SFN task tokens, no waitForTaskToken: state lives in DDB.

## Worker Lambda

The single worker (`lambdas/worker/handler.py`) contains:

- Cached system prompts for **token**, **clarity**, **safety**, **suggestion**, **verify**, and **refine** roles
- A `ThreadPoolExecutor` running the 3 scorers in parallel, followed by the suggester
- A `verify_fix` Haiku call producing a consistency-confidence score
- Decision logic + persistence to DDB (META + AGG#NN + REFINE#NN) and S3 (audit JSON + diff JSON + refined-NN.txt)
- An orchestration loop that runs up to `MAX_REFINEMENT_ITERATIONS` (default 3) before forcing review

Memory: 1024 MB · Timeout: 10 min · Runtime: Python 3.12.

## Intake (API) Lambda

The single API handler (`lambdas/api/handler.py`) handles every REST route. On work-triggering routes (`POST /prompts`, `POST /prompts/{id}/review`) it invokes the worker asynchronously (`InvocationType=Event`) and returns immediately. All other routes are synchronous reads/writes against DDB and S3.

Memory: 512 MB · Timeout: 30 s · Runtime: Python 3.12.

## Costs to watch

- Bedrock Converse API calls dominate per-prompt cost (5 calls per scoring iteration: token check, clarity check, safety check, suggestion, verify_fix).
- Lambda compute: ~$0.0001 per scoring iteration at 1 GB / 15 s.
- DynamoDB and S3 charges are negligible at this scale (PAY_PER_REQUEST + S3 standard).
- API Gateway is flat-rate per request.

Rough per-prompt cost (single iteration, ~200-token prompt):
- Haiku calls (token check + verify_fix): ~$0.000002
- Sonnet calls (clarity + safety + suggestion): ~$0.000012
- Lambda compute: ~$0.0001
- **Total: ~$0.00012 per run**

Removing Step Functions Standard and the AgentCore Runtime saved both per-execution charges and the always-on idle cost of the AgentCore session.

## Tear down

```bash
cd infra && npx cdk destroy
```

Empties the S3 bucket on destroy (`autoDeleteObjects: true`).
