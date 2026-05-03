"""
KB Lambda — serves and saves domain rule JSON files via S3.

Routes:
  GET  /rules              → list all available domains (summary)
  GET  /rules/{domain}     → full rule set for a domain (falls back to general)
  PUT  /rules/{domain}     → overwrite rule set for a domain back to S3
"""
import json
import os

import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET_NAME"]

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
}

KNOWN_DOMAINS = ["medical", "legal", "financial", "marketing", "technical", "general"]

REQUIRED_FIELDS = [
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
    method   = event.get("httpMethod", "GET")
    resource = event.get("resource") or ""
    pp       = event.get("pathParameters") or {}
    raw_body = event.get("body") or ""

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": CORS, "body": ""}

    try:
        if resource == "/rules":
            return list_domains()
        if resource == "/rules/{domain}":
            domain = pp.get("domain", "general")
            if method == "PUT":
                body = json.loads(raw_body) if raw_body else {}
                return update_rules(domain, body)
            return get_rules(domain)
        return _resp(404, {"error": "not found"})
    except Exception as e:  # noqa: BLE001
        print(f"[kb] error: {e!r}")
        return _resp(500, {"error": str(e)})


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


def get_rules(domain: str):
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


def update_rules(domain: str, body: dict):
    domain = domain.lower().strip()
    if domain not in KNOWN_DOMAINS:
        return _resp(400, {"error": f"unknown domain '{domain}'. Valid: {', '.join(KNOWN_DOMAINS)}"})

    missing = [f for f in REQUIRED_FIELDS if f not in body]
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

    # Preserve domain + display_name fields; merge the rest from body
    body["domain"] = domain
    body.setdefault("display_name", domain.title())

    # Remove frontend-only fallback flags before saving
    body.pop("_fallback", None)
    body.pop("_requested_domain", None)

    s3.put_object(
        Bucket=BUCKET,
        Key=f"domain_rules/{domain}.json",
        Body=json.dumps(body, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    return _resp(200, {"ok": True, "domain": domain})
