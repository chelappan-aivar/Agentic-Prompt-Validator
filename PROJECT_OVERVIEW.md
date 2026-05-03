# Agentic Prompt Validator — Project & Deployment Overview

End-to-end agentic prompt validator with human-in-the-loop. Submitted prompts are scored by 3 Bedrock agents in parallel, refined by a 4th agent, and routed for auto-approval, auto-refinement, or human review.

**Live URLs**

| | URL |
|---|---|
| Frontend (Amplify Hosting) | https://main.d1txstjnp1g8rw.amplifyapp.com |
| API (API Gateway REST) | https://gz3qu14x5k.execute-api.us-east-1.amazonaws.com/APV/ |

**AWS account / region:** `455162169375` / `us-east-1`

---

## 1. Project folder structure

```
prompt-validator/
├── README.md                    # Setup prerequisites + redeploy instructions
├── PROJECT_OVERVIEW.md          # This document
├── RENAME.txt                   # Resource-rename worksheet (used pre-deploy)
├── .gitignore
│
├── infra/                       # AWS CDK (TypeScript) — defines all backend infra
│   ├── bin/app.ts               # CDK app entry; sets stack name + qualifier
│   ├── lib/stack.ts             # All AWS resources defined here
│   ├── cdk.json                 # CDK config / feature flags
│   ├── package.json             # CDK dependencies
│   ├── tsconfig.json
│   ├── node_modules/            # gitignored
│   └── cdk.out/                 # gitignored — synth output
│
├── lambdas/                     # Python 3.12 Lambda handlers
│   ├── intake/handler.py        # All API routes (submit, get, list, review-action)
│   ├── aggregator/handler.py    # Invokes 4 Bedrock agents in parallel, scores, decides
│   └── refinement/handler.py    # Rewrites prompt with Sonnet (auto-refine + human-edit paths)
│
└── frontend/                    # Next.js 14 (App Router) — static export
    ├── app/
    │   ├── layout.tsx           # Nav + brand
    │   ├── page.tsx             # Redirects to /submit
    │   ├── globals.css          # Design system (light + dark mode)
    │   ├── submit/page.tsx      # Submit prompt form
    │   ├── status/page.tsx      # Live status, gauge, agent panels, suggestion
    │   ├── review/page.tsx      # Awaiting-review queue
    │   └── review/detail/page.tsx # Review actions (approve/reject/edit + suggestion)
    ├── lib/api.ts               # Typed client for the REST API
    ├── amplify.yml              # Amplify build spec
    ├── next.config.js           # output: 'export' for static deploy
    ├── package.json
    ├── tsconfig.json
    └── .env.example             # NEXT_PUBLIC_API_URL placeholder
```

Generated/transient (all gitignored): `node_modules/`, `cdk.out/`, `.next/`, `out/`, `*.tsbuildinfo`, `.env.local`.

---

## 2. AWS resources deployed

### 2.1 Stacks

| CloudFormation stack | Purpose |
|---|---|
| **`AgenticPromptValidatorStack`** | The application stack — every resource below |
| **`CDKToolkit-apv`** | CDK bootstrap (staging bucket, deploy roles) — qualifier `apv` |

### 2.2 Compute & orchestration

| Resource | Name |
|---|---|
| Step Functions state machine | `apv-state-machine` (`arn:aws:states:us-east-1:455162169375:stateMachine:apv-state-machine`) |
| Lambda — intake | `apv-intake-lambda` (Python 3.12, 512 MB, 30 s) |
| Lambda — aggregator | `apv-aggregator-lambda` (Python 3.12, 1024 MB, 5 min) |
| Lambda — refinement | `apv-refinement-lambda` (Python 3.12, 1024 MB, 3 min) |

### 2.3 Bedrock agents (all alias `live`)

| Agent name | Model | Role |
|---|---|---|
| `apv-token-check` (id `DCUGDZXLCI`) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Scores token efficiency, bloat, domain budget |
| `apv-clarity-check` (id `AD24DPUQHB`) | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Scores intent clarity, format, domain terminology |
| `apv-safety-check` (id `6MGZDUDMCW`) | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Detects PII, prompt injection, bias, domain risk |
| `apv-refinement-suggester` (id `HFLWTPGYEC`) ✨ | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Generates an improved prompt suggestion |

### 2.4 Storage

| Resource | Name |
|---|---|
| S3 bucket | `apv-prompts-storage` (versioned, encrypted, CORS enabled) |
| DynamoDB table | `apv-logs` (single-table; PK = `pk`, SK = `sk`; PAY_PER_REQUEST) |
| DDB GSI | `GSI1_status` (drives the review queue) |

**S3 layout under `apv-prompts-storage`:**
```
prompts/{prompt_id}/original.txt
prompts/{prompt_id}/refined-{NN}.txt
prompts/{prompt_id}/audit/iter-{NN}.json   # full agent output snapshot
prompts/{prompt_id}/diff/iter-{NN}.json    # before/after refinement diff
```

**DDB record shapes (under same `pk = prompt_id`):**

| `sk` | What it is |
|---|---|
| `META` | Main record: status, latest scores, current_prompt, latest_suggestion, task_token (when awaiting review) |
| `AGG#NN#<ts>` | Per-iteration aggregator result (scores JSON, flags, suggestion, composite, severity, confidence) |
| `REFINE#NN` | Refinement diff (before/after, source = `llm_refine` \| `human_edit`) |

### 2.5 API

| Resource | Name / value |
|---|---|
| API Gateway REST API | `agentic-prompt-validator-api` |
| Stage | `APV` (so URL path is `/APV/...`) |
| CORS | Allow all origins (configured per route) |

**Routes (all served by `apv-intake-lambda`):**

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/prompts` | `{ prompt, domain }` | `202 { prompt_id, status: "processing" }` |
| GET | `/prompts?status=...` | — | `{ items: Meta[] }` (default `awaiting_review`) |
| GET | `/prompts/{id}` | — | `{ meta, records }` |
| POST | `/prompts/{id}/review` | `{ action, edited_prompt? }` | `{ ok: true }` (calls `SendTaskSuccess` on the SFN execution) |

### 2.6 IAM roles (all explicit names)

| Role | Trusts | Purpose |
|---|---|---|
| `apv-bedrock-agent-role` | `bedrock.amazonaws.com` | Lets Bedrock agents invoke their foundation models |
| `apv-intake-lambda-role` | `lambda.amazonaws.com` | Intake Lambda execution |
| `apv-aggregator-lambda-role` | `lambda.amazonaws.com` | Aggregator Lambda execution |
| `apv-refinement-lambda-role` | `lambda.amazonaws.com` | Refinement Lambda execution |
| `apv-state-machine-lambda-role` | `states.amazonaws.com` | Step Functions execution |

### 2.7 Frontend hosting

| Resource | Value |
|---|---|
| Amplify app name | `apv-frontend` |
| Amplify app ID | `d1txstjnp1g8rw` |
| Default domain | `https://main.d1txstjnp1g8rw.amplifyapp.com` |
| Build mode | Static export (Next.js `output: 'export'`), uploaded as ZIP |

### 2.8 What this stack does NOT create

- No GitHub connection (Amplify deploy is manual via zip upload)
- No CloudFront in front of API Gateway (uses default endpoint)
- No Cognito / auth (open API)
- No WebSocket API (frontend polls REST every 2.5 s)
- No CloudWatch alarms / dashboards
- No CI/CD pipeline (CodePipeline/CodeBuild)

---

## 3. End-to-end flow

```
User submits prompt + domain
        │
        ▼
   POST /prompts   ───────►  apv-intake-lambda
                              │
                              ├── PutObject  → S3 (original.txt)
                              ├── PutItem    → DDB (META, status=processing)
                              └── StartExecution → apv-state-machine
                                                    │
                                                    ▼
                                            ┌─── Init (set review=null) ───┐
                                            │                              │
                                            ▼                              │
                                   apv-aggregator-lambda                   │
                                   (parallel threads)                      │
                                       ├── Bedrock agent: token-check     │
                                       ├── Bedrock agent: clarity-check   │  loop
                                       ├── Bedrock agent: safety-check    │  (max
                                       └── Bedrock agent: suggester ✨    │   3x)
                                       + Haiku self-confidence            │
                                       + DDB scan: similar-approved       │
                                            │                              │
                                            ▼                              │
                                       Choice: action?                     │
                                       ├── approve → DDB UpdateItem (status=approved) → Done
                                       ├── refine  → apv-refinement-lambda → loop ─┘
                                       └── review  → DDB UpdateItem (.waitForTaskToken)
                                                          │ (pauses)
                                                          ▼
                          POST /prompts/{id}/review ──► apv-intake-lambda
                                                          │
                                                          └── SendTaskSuccess(action, edited_prompt)
                                                                    │
                                                                    ▼
                                                            Choice: review action?
                                                            ├── approve → Done
                                                            ├── reject  → Done
                                                            └── edit    → apv-refinement-lambda → back to aggregator
```

### Decision logic in the aggregator

- `composite_score >= 0.85` AND `severity == LOW` AND `confidence >= 0.7` → **approve**
- `composite_score < 0.5` OR `severity == HIGH` OR `confidence < 0.7` → **review** (human-in-the-loop)
- Otherwise → **refine** (auto-loop, capped at 3 iterations; then forced to **review**)

### Composite score weighting

```
composite = 0.25 * token + 0.35 * clarity + 0.40 * safety
```

Tunable in `lambdas/aggregator/handler.py` (constant `WEIGHTS`).

---

## 4. How each piece is built

### Backend (`infra/`)

- **CDK qualifier:** `apv` (drives bootstrap bucket/role names)
- **Bootstrap stack:** `CDKToolkit-apv`
- **Synthesizer:** custom `DefaultStackSynthesizer` in `bin/app.ts` so this stack uses our isolated bootstrap, not any pre-existing one in the account

To redeploy the backend after editing `infra/lib/stack.ts` or any Lambda:

```bash
cd infra
npm install              # first time only
npx cdk deploy --require-approval never
```

### Frontend (`frontend/`)

- **Next.js App Router**, all client components (no SSR needed)
- **`output: 'export'`** for static deploy — produces `out/` directory
- **Dynamic routes converted to query params** (`/status?id=…`, `/review/detail?id=…`) since static export can't enumerate unknown IDs
- **Polling** (every 2.5 s) for live status updates — no WebSocket

To rebuild + redeploy the frontend:

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL="https://gz3qu14x5k.execute-api.us-east-1.amazonaws.com/APV" npm run build
cd out && zip -qr /tmp/frontend.zip .
DEPLOY=$(aws amplify create-deployment --app-id d1txstjnp1g8rw --branch-name main --output json)
JOB_ID=$(echo "$DEPLOY" | jq -r .jobId)
URL=$(echo "$DEPLOY" | jq -r .zipUploadUrl)
curl -s -X PUT --upload-file /tmp/frontend.zip "$URL"
aws amplify start-deployment --app-id d1txstjnp1g8rw --branch-name main --job-id $JOB_ID
```

---

## 5. Cost & operations

### Idle cost (when nothing is running)

- Bedrock agents: **$0** at rest (pay per invocation only)
- DynamoDB: **$0** (PAY_PER_REQUEST)
- S3: **$0** for empty bucket; pennies/month at low volume
- Lambda: **$0** at rest
- Step Functions Standard: **$0** at rest
- API Gateway: **$0** at rest
- CDK bootstrap KMS key: **~$1/month**
- Amplify Hosting: **$0** for the app shell (you pay for serving requests)

**~$1–2/month idle.**

### Per-prompt cost (rough)

Each iteration invokes:
- 4 Bedrock agents in parallel (3 scoring + 1 suggester)
- 1 Haiku inline call (self-confidence)

Total ≈ 5 LLM calls per iteration. At Bedrock pricing:
- Haiku 4.5: ~$1/M input, ~$5/M output
- Sonnet 4.5: ~$3/M input, ~$15/M output

For a 200-token prompt with 200-token outputs, single iteration ≈ **$0.005–0.015**.

### Logs

| Resource | Where to look |
|---|---|
| Lambdas | CloudWatch Logs → `/aws/lambda/apv-intake-lambda`, `/aws/lambda/apv-aggregator-lambda`, `/aws/lambda/apv-refinement-lambda` |
| State machine | CloudWatch Logs (auto-created by CDK with the SFN log destination) |
| API Gateway | not enabled (account-level CloudWatch role wasn't set up to keep deploy minimal) |
| Bedrock agents | CloudTrail data events (off by default) |
| Audit trail per prompt | S3 `apv-prompts-storage/prompts/{id}/audit/` |

### Tear down

```bash
cd infra
npx cdk destroy            # removes AgenticPromptValidatorStack
# Optional, removes bootstrap (saves the KMS dollar):
#   1) Empty cdk-apv-assets-455162169375-us-east-1
#   2) aws cloudformation delete-stack --stack-name CDKToolkit-apv
# Frontend:
aws amplify delete-app --app-id d1txstjnp1g8rw
```

---

## 6. Quick API smoke test

```bash
API="https://gz3qu14x5k.execute-api.us-east-1.amazonaws.com/APV"

# 1. Submit a prompt
curl -X POST "$API/prompts" -H 'Content-Type: application/json' -d '{
  "prompt": "kindly help me write a really really detailed marketing plan",
  "domain": "marketing"
}'
# -> { "prompt_id": "...", "status": "processing" }

# 2. Poll status (replace ID)
curl "$API/prompts/<prompt_id>" | jq '.meta'
# -> latest_composite, latest_severity, latest_action, latest_suggestion, status

# 3. List awaiting-review queue
curl "$API/prompts?status=awaiting_review" | jq '.items[].pk'

# 4. Take a review action
curl -X POST "$API/prompts/<prompt_id>/review" -H 'Content-Type: application/json' -d '{
  "action": "approve"
}'
# -> { "ok": true }
```
