"""
API Lambda — single REST handler for all routes.

Replaces the previous Intake Lambda + KB Lambda. Talks to the Worker Lambda
asynchronously (instead of Step Functions) for any work that takes time.

Routes:
  POST   /prompts                    submit a new prompt → invoke worker(action=score)
  GET    /prompts?status=...         list prompts (default: awaiting_review)
  GET    /prompts/{id}               get one prompt with all sub-records
  DELETE /prompts/{id}               permanently delete a prompt + S3 artifacts
  POST   /prompts/{id}/review        human review action → invoke worker(action=review_resume)
  GET    /rules                      list configured domains
  GET    /rules/{domain}             get domain rule pack
  PUT    /rules/{domain}             update domain rule pack
"""
import json
import os
import time
import uuid

import boto3

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")
lam = boto3.client("lambda")

TABLE = os.environ["TABLE_NAME"]
BUCKET = os.environ["BUCKET_NAME"]
WORKER_FN = os.environ["WORKER_FUNCTION_NAME"]

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
}

KNOWN_DOMAINS = ["medical", "legal", "financial", "marketing", "technical", "general"]
REQUIRED_RULE_FIELDS = [
    "token_budget", "pii_risks", "compliance",
    "clarity_requirements", "tone", "good_patterns", "bad_patterns",
]


def _resp(code, body):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json", **CORS},
        "body": json.dumps(body),
    }


def lambda_handler(event, _ctx):
    method = event.get("httpMethod", "GET")
    resource = event.get("resource") or ""
    pp = event.get("pathParameters") or {}
    qs = event.get("queryStringParameters") or {}
    body = json.loads(event["body"]) if event.get("body") else {}

    try:
        if method == "OPTIONS":
            return {"statusCode": 200, "headers": CORS, "body": ""}

        # Prompts routes
        if method == "POST" and resource == "/prompts":
            return submit(body)
        if method == "GET" and resource == "/prompts":
            return list_prompts(qs)
        if method == "GET" and resource == "/prompts/{id}":
            return get_prompt(pp["id"])
        if method == "DELETE" and resource == "/prompts/{id}":
            return delete_prompt(pp["id"])
        if method == "POST" and resource == "/prompts/{id}/review":
            return review(pp["id"], body)

        # Rules routes
        if method == "GET" and resource == "/rules":
            return list_domains()
        if method == "GET" and resource == "/rules/{domain}":
            return get_rules(pp.get("domain", "general"))
        if method == "PUT" and resource == "/rules/{domain}":
            return update_rules(pp.get("domain", "general"), body)

        return _resp(404, {"error": "not found"})
    except Exception as e:  # noqa: BLE001
        print(f"api error: {e!r}")
        return _resp(500, {"error": str(e)})


# ================================================================== prompt routes

def submit(body):
    prompt = (body.get("prompt") or "").strip()
    domain = (body.get("domain") or "").strip()
    if not prompt or not domain:
        return _resp(400, {"error": "prompt and domain required"})

    target_model = (body.get("target_model") or "").strip()
    prompt_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)
    iso = _ms_to_iso(now_ms)

    s3.put_object(
        Bucket=BUCKET,
        Key=f"prompts/{prompt_id}/original.txt",
        Body=prompt.encode("utf-8"),
        ContentType="text/plain",
    )

    item = {
        "pk":              {"S": prompt_id},
        "sk":              {"S": "META"},
        "status":          {"S": "processing"},
        "gsi1pk":          {"S": "processing"},
        "gsi1sk":          {"S": iso},
        "domain":          {"S": domain},
        "original_prompt": {"S": prompt},
        "current_prompt":  {"S": prompt},
        "created_at":      {"N": str(now_ms)},
    }
    if target_model:
        item["target_model"] = {"S": target_model}

    ddb.put_item(TableName=TABLE, Item=item)

    lam.invoke(
        FunctionName=WORKER_FN,
        InvocationType="Event",
        Payload=json.dumps({
            "action": "score",
            "prompt_id": prompt_id,
            "prompt": prompt,
            "domain": domain,
            "target_model": target_model,
            "iteration": 0,
        }).encode("utf-8"),
    )

    return _resp(202, {"prompt_id": prompt_id, "status": "processing"})


def get_prompt(prompt_id):
    items = []
    paginator = ddb.get_paginator("query")
    for page in paginator.paginate(
        TableName=TABLE,
        KeyConditionExpression="pk = :p",
        ExpressionAttributeValues={":p": {"S": prompt_id}},
    ):
        items.extend(page["Items"])
    if not items:
        return _resp(404, {"error": "not found"})

    meta = next((_unmarshal(i) for i in items if i.get("sk", {}).get("S") == "META"), None)
    sub = [_unmarshal(i) for i in items if i.get("sk", {}).get("S") != "META"]
    return _resp(200, {"meta": meta, "records": sub})


def list_prompts(qs):
    status = (qs.get("status") if qs else None) or "awaiting_review"
    res = ddb.query(
        TableName=TABLE,
        IndexName="GSI1_status",
        KeyConditionExpression="gsi1pk = :s",
        ExpressionAttributeValues={":s": {"S": status}},
        ScanIndexForward=False,
        Limit=50,
    )
    items = [_unmarshal(i) for i in res.get("Items", [])]
    return _resp(200, {"items": items})


def delete_prompt(prompt_id):
    paginator = ddb.get_paginator("query")
    items = []
    for page in paginator.paginate(
        TableName=TABLE,
        KeyConditionExpression="pk = :p",
        ExpressionAttributeValues={":p": {"S": prompt_id}},
    ):
        items.extend(page["Items"])
    if not items:
        return _resp(404, {"error": "not found"})

    for i in range(0, len(items), 25):
        batch = items[i:i + 25]
        ddb.batch_write_item(
            RequestItems={
                TABLE: [
                    {"DeleteRequest": {"Key": {"pk": it["pk"], "sk": it["sk"]}}}
                    for it in batch
                ]
            }
        )

    s3_paginator = s3.get_paginator("list_objects_v2")
    s3_keys = []
    for page in s3_paginator.paginate(Bucket=BUCKET, Prefix=f"prompts/{prompt_id}/"):
        for obj in page.get("Contents", []) or []:
            s3_keys.append({"Key": obj["Key"]})
    for i in range(0, len(s3_keys), 1000):
        chunk = s3_keys[i:i + 1000]
        if chunk:
            s3.delete_objects(Bucket=BUCKET, Delete={"Objects": chunk, "Quiet": True})

    return _resp(200, {"ok": True, "deleted_records": len(items), "deleted_objects": len(s3_keys)})


def review(prompt_id, body):
    action = body.get("action")
    if action not in ("approve", "reject", "edit"):
        return _resp(400, {"error": "action must be approve|reject|edit"})

    edited = (body.get("edited_prompt") or "").strip()
    if action == "edit" and not edited:
        return _resp(400, {"error": "edited_prompt required for edit"})

    res = ddb.get_item(
        TableName=TABLE, Key={"pk": {"S": prompt_id}, "sk": {"S": "META"}}
    )
    if not res.get("Item"):
        return _resp(404, {"error": "prompt not found"})

    payload = {
        "action": "review_resume",
        "prompt_id": prompt_id,
        "review_action": action,
    }
    if action == "edit":
        payload["edited_prompt"] = edited

    lam.invoke(
        FunctionName=WORKER_FN,
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    return _resp(200, {"ok": True})


# ================================================================== rules routes

def list_domains():
    domains = []
    for domain in KNOWN_DOMAINS:
        try:
            resp = s3.get_object(Bucket=BUCKET, Key=f"domain_rules/{domain}.json")
            rules = json.loads(resp["Body"].read())
            domains.append({
                "domain": domain,
                "display_name": rules.get("display_name", domain.title()),
                "token_budget": rules.get("token_budget", {}),
                "rule_counts": {
                    "pii_risks":            len(rules.get("pii_risks", [])),
                    "compliance":           len(rules.get("compliance", [])),
                    "clarity_requirements": len(rules.get("clarity_requirements", [])),
                    "good_patterns":        len(rules.get("good_patterns", [])),
                    "bad_patterns":         len(rules.get("bad_patterns", [])),
                },
            })
        except Exception:
            pass
    return _resp(200, {"domains": domains})


def get_rules(domain):
    domain = domain.lower().strip()
    key = f"domain_rules/{domain}.json"
    try:
        resp = s3.get_object(Bucket=BUCKET, Key=key)
        return _resp(200, json.loads(resp["Body"].read()))
    except s3.exceptions.NoSuchKey:
        resp = s3.get_object(Bucket=BUCKET, Key="domain_rules/general.json")
        rules = json.loads(resp["Body"].read())
        rules["_fallback"] = True
        rules["_requested_domain"] = domain
        return _resp(200, rules)


def update_rules(domain, body):
    domain = domain.lower().strip()
    if domain not in KNOWN_DOMAINS:
        return _resp(400, {"error": f"unknown domain '{domain}'. Valid: {', '.join(KNOWN_DOMAINS)}"})

    missing = [f for f in REQUIRED_RULE_FIELDS if f not in body]
    if missing:
        return _resp(400, {"error": f"missing required fields: {', '.join(missing)}"})

    budget = body.get("token_budget", {})
    if not isinstance(budget.get("min"), (int, float)) or not isinstance(budget.get("max"), (int, float)):
        return _resp(400, {"error": "token_budget must have numeric min and max"})
    if budget["min"] >= budget["max"]:
        return _resp(400, {"error": "token_budget.min must be less than max"})

    for field in ["pii_risks", "compliance", "clarity_requirements", "good_patterns", "bad_patterns"]:
        if not isinstance(body.get(field), list):
            return _resp(400, {"error": f"{field} must be an array"})

    body["domain"] = domain
    body.setdefault("display_name", domain.title())
    body.pop("_fallback", None)
    body.pop("_requested_domain", None)

    s3.put_object(
        Bucket=BUCKET,
        Key=f"domain_rules/{domain}.json",
        Body=json.dumps(body, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    return _resp(200, {"ok": True, "domain": domain})


# ================================================================== helpers

def _ms_to_iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))


def _unmarshal(item):
    return {k: _from_attr(v) for k, v in item.items()}


def _from_attr(v):
    if "S" in v:
        return v["S"]
    if "N" in v:
        n = v["N"]
        return float(n) if "." in n else int(n)
    if "BOOL" in v:
        return v["BOOL"]
    if "NULL" in v:
        return None
    if "M" in v:
        return {k: _from_attr(x) for k, x in v["M"].items()}
    if "L" in v:
        return [_from_attr(x) for x in v["L"]]
    return None
