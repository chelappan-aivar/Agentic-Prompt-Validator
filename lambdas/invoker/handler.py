"""
Invoker Lambda — SigV4-signed bridge from Step Functions to AgentCore Runtime.

Constructs the invocation URL from the runtime ARN and forwards the payload.
No business logic — pure routing.

Env vars:
  AGENTCORE_RUNTIME_ARN — arn:aws:bedrock-agentcore:us-east-1:<acct>:runtime/<id>
  AWS_REGION            — injected automatically by Lambda runtime
"""
import json
import os
import urllib.parse
import urllib.request
import urllib.error

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

RUNTIME_ARN = os.environ["AGENTCORE_RUNTIME_ARN"]
REGION = os.environ.get("AWS_REGION", "us-east-1")
SERVICE = "bedrock-agentcore"

# Build endpoint once at cold start
_encoded_arn = urllib.parse.quote(RUNTIME_ARN, safe="")
ENDPOINT = f"https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{_encoded_arn}/invocations"


def lambda_handler(event, _ctx):
    session = boto3.session.Session()
    creds = session.get_credentials().get_frozen_credentials()

    body = json.dumps(event).encode("utf-8")

    aws_req = AWSRequest(
        method="POST",
        url=ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    SigV4Auth(creds, SERVICE, REGION).add_auth(aws_req)

    http_req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers=dict(aws_req.headers),
        method="POST",
    )

    try:
        with urllib.request.urlopen(http_req, timeout=290) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        raise RuntimeError(
            f"AgentCore returned HTTP {e.code}: {body_bytes.decode('utf-8', errors='replace')}"
        ) from e
