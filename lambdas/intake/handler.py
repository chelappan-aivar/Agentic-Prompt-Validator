"""
Intake Lambda — handles all REST API routes:
  POST /prompts                    submit a new prompt
  GET  /prompts?status=...         list prompts (default: awaiting_review)
  GET  /prompts/{id}               get one prompt with all sub-records
  POST /prompts/{id}/review        human review action (approve|reject|edit)
"""
import json
import os
import time
import uuid

import boto3

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")
sfn = boto3.client("stepfunctions")

TABLE = os.environ["TABLE_NAME"]
BUCKET = os.environ["BUCKET_NAME"]
SM_ARN = os.environ["STATE_MACHINE_ARN"]

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
}


def _resp(code, body):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json", **CORS},
        "body": json.dumps(body),
    }


def lambda_handler(event, _ctx):
    method = event.get("httpMethod")
    resource = event.get("resource") or ""
    pp = event.get("pathParameters") or {}
    qs = event.get("queryStringParameters") or {}
    body = json.loads(event["body"]) if event.get("body") else {}

    try:
        if method == "OPTIONS":
            return _resp(200, {})
        if method == "POST" and resource == "/prompts":
            return submit(body)
        if method == "GET" and resource == "/prompts":
            return list_prompts(qs)
        if method == "GET" and resource == "/prompts/{id}":
            return get_prompt(pp["id"])
        if method == "POST" and resource == "/prompts/{id}/review":
            return review(pp["id"], body)
        return _resp(404, {"error": "not found"})
    except Exception as e:  # noqa: BLE001
        print(f"intake error: {e!r}")
        return _resp(500, {"error": str(e)})


def submit(body):
    prompt = (body.get("prompt") or "").strip()
    domain = (body.get("domain") or "").strip()
    if not prompt or not domain:
        return _resp(400, {"error": "prompt and domain required"})

    prompt_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)

    s3.put_object(
        Bucket=BUCKET,
        Key=f"prompts/{prompt_id}/original.txt",
        Body=prompt.encode("utf-8"),
        ContentType="text/plain",
    )

    ddb.put_item(
        TableName=TABLE,
        Item={
            "pk": {"S": prompt_id},
            "sk": {"S": "META"},
            "status": {"S": "processing"},
            "gsi1pk": {"S": "processing"},
            "gsi1sk": {"S": _ms_to_iso(now_ms)},
            "domain": {"S": domain},
            "original_prompt": {"S": prompt},
            "current_prompt": {"S": prompt},
            "created_at": {"N": str(now_ms)},
        },
    )

    sfn.start_execution(
        stateMachineArn=SM_ARN,
        name=prompt_id,
        input=json.dumps(
            {"prompt_id": prompt_id, "prompt": prompt, "domain": domain, "iteration": 0}
        ),
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
    # Don't leak the task token to the frontend
    if meta and "task_token" in meta:
        meta.pop("task_token", None)
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
    for it in items:
        it.pop("task_token", None)
    return _resp(200, {"items": items})


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
    item = res.get("Item")
    if not item:
        return _resp(404, {"error": "prompt not found"})

    task_token = item.get("task_token", {}).get("S")
    if not task_token:
        return _resp(409, {"error": "no pending review for this prompt"})

    sfn.send_task_success(
        taskToken=task_token,
        output=json.dumps({"action": action, "edited_prompt": edited or None}),
    )

    ddb.update_item(
        TableName=TABLE,
        Key={"pk": {"S": prompt_id}, "sk": {"S": "META"}},
        UpdateExpression="REMOVE task_token",
    )
    return _resp(200, {"ok": True})


# ----- helpers -----
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
    if "SS" in v:
        return list(v["SS"])
    if "NS" in v:
        return [float(n) if "." in n else int(n) for n in v["NS"]]
    return None
