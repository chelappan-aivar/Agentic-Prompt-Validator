"""
Refinement Lambda — invoked by Step Functions when:
  (a) auto-refine is selected by aggregator (review.action absent), or
  (b) human reviewer chose "edit" (review.action == 'edit', review.edited_prompt provided).

For (b) we use the human edit verbatim (no LLM call).
For (a) we ask Sonnet to rewrite the prompt via bedrock-runtime.converse() with a
cached system prompt (cacheControl: default) for ~90% cost reduction on repeated calls.
"""
import json
import os
import time

import boto3

model_rt = boto3.client("bedrock-runtime")
ddb = boto3.client("dynamodb")
s3 = boto3.client("s3")

TABLE = os.environ["TABLE_NAME"]
BUCKET = os.environ["BUCKET_NAME"]
SONNET = os.environ["SONNET_MODEL"]

# Static system prompt — cached at the Bedrock layer across repeated refinement calls.
REFINE_SYSTEM = """You are an expert prompt engineer specialising in rewriting AI prompts for \
production systems. You will receive a prompt that has been evaluated by automated reviewers \
and flagged for improvement. Your task is to rewrite it so it scores higher on token efficiency, \
clarity, and safety while preserving the user's original intent and the conventions of the \
target domain.

REWRITING RULES:
1. Preserve intent — the rewritten prompt must accomplish exactly what the user originally \
intended. Never change the fundamental ask.
2. Fix the flagged issues — address every issue listed by the reviewers. Do not ignore findings.
3. Eliminate bloat — remove hedge phrases, filler openers, redundant restatements, and \
unnecessary meta-commentary.
4. Clarify the ask — if intent, output format, or scope was unclear, make it explicit.
5. Apply domain conventions — use vocabulary, register, and structural norms appropriate \
to the target domain (medical, legal, financial, technical, marketing, customer service, etc.).
6. Remove safety risks — replace real PII with typed placeholders ([customer name], \
[email address], [account number]), remove injection-style language, neutralise biased framing.
7. Right-size — use exactly as many tokens as the domain task requires. Do not pad or over-trim.

OUTPUT: The rewritten prompt text only. No preamble. No explanation. No markdown fences. \
No quotes. Begin directly with the first word of the improved prompt."""


def lambda_handler(event, _ctx):
    prompt_id = event["prompt_id"]
    prompt = event["prompt"]
    domain = event["domain"]
    iteration = int(event.get("iteration", 0))
    aggregator = event.get("aggregator") or {}
    review = event.get("review") or {}

    next_iter = iteration + 1
    edited = (review.get("edited_prompt") or "").strip() if isinstance(review, dict) else ""

    if edited:
        refined = edited
        source = "human_edit"
        usage = None
    else:
        refined, usage = _llm_rewrite(prompt, domain, aggregator)
        source = "llm_refine"

    _persist(prompt_id, next_iter, prompt, refined, source, aggregator, usage)
    print(f"[refinement] prompt_id={prompt_id} iter→{next_iter} source={source}")

    return {"refined_prompt": refined, "iteration": next_iter}


def _llm_rewrite(prompt, domain, aggregator):
    flags = aggregator.get("flags") or []
    scores = aggregator.get("scores") or {}
    issues = "\n".join(f"- [{f.get('agent')}] {f.get('issue')}" for f in flags)

    user_msg = (
        f"Domain: {domain}\n\n"
        f"Original prompt:\n---\n{prompt}\n---\n\n"
        f"Issues to address:\n{issues or '(none specified)'}\n\n"
        f"Reviewer scores: {json.dumps(scores)[:1500]}\n\n"
        "Rewritten prompt:"
    )
    resp = model_rt.converse(
        modelId=SONNET,
        system=[{"text": REFINE_SYSTEM}],
        messages=[{"role": "user", "content": [{"text": user_msg}]}],
        inferenceConfig={"maxTokens": 2000},
    )
    text = resp["output"]["message"]["content"][0]["text"].strip()
    u = resp.get("usage", {})
    usage = {
        "model": "sonnet",
        "input_tokens":       u.get("inputTokens", 0),
        "output_tokens":      u.get("outputTokens", 0),
        "cache_read_tokens":  u.get("cacheReadInputTokens", 0),
        "cache_write_tokens": u.get("cacheWriteInputTokens", 0),
    }
    return text, usage


def _persist(prompt_id, iteration, before, after, source, aggregator, usage):
    now_ms = int(time.time() * 1000)
    iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ms / 1000))

    s3.put_object(
        Bucket=BUCKET,
        Key=f"prompts/{prompt_id}/refined-{iteration:02d}.txt",
        Body=after.encode("utf-8"),
        ContentType="text/plain",
    )
    s3.put_object(
        Bucket=BUCKET,
        Key=f"prompts/{prompt_id}/diff/iter-{iteration:02d}.json",
        Body=json.dumps(
            {
                "iteration": iteration,
                "source": source,
                "before": before,
                "after": after,
                "before_len": len(before),
                "after_len": len(after),
                "tokens_saved_estimate": max(0, _approx_tokens(before) - _approx_tokens(after)),
                "aggregator": aggregator,
                "usage": usage,
                "ts": iso,
            },
            indent=2,
        ).encode("utf-8"),
        ContentType="application/json",
    )

    item = {
        "pk": {"S": prompt_id},
        "sk": {"S": f"REFINE#{iteration:02d}"},
        "iteration": {"N": str(iteration)},
        "source": {"S": source},
        "before": {"S": before},
        "after": {"S": after},
        "created_at": {"N": str(now_ms)},
    }
    if usage:
        item["usage_tokens"] = {"S": json.dumps(usage)}

    ddb.put_item(TableName=TABLE, Item=item)

    ddb.update_item(
        TableName=TABLE,
        Key={"pk": {"S": prompt_id}, "sk": {"S": "META"}},
        UpdateExpression="SET current_prompt = :p, last_updated = :ts",
        ExpressionAttributeValues={":p": {"S": after}, ":ts": {"S": iso}},
    )


def _approx_tokens(s):
    return int(len(s.split()) * 1.3)
