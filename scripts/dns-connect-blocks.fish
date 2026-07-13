#!/usr/bin/env fish
# Create/update connect.blocks.pw → AWS CursorRemote (18.228.116.226)
# Needs Cloudflare API token with Zone.DNS Edit for blocks.pw
#
# Usage:
#   set -x CF_API_TOKEN '...'
#   fish scripts/dns-connect-blocks.fish

set -q CF_API_TOKEN; or begin
  echo "Set CF_API_TOKEN first (Cloudflare → My Profile → API Tokens → Edit zone DNS)"
  echo "https://dash.cloudflare.com/profile/api-tokens"
  exit 1
end

set ZONE_NAME blocks.pw
set RECORD_NAME connect.blocks.pw
set TARGET_IP 18.228.116.226

set ZONE_ID (curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["result"][0]["id"] if d.get("success") and d["result"] else "")')

if test -z "$ZONE_ID"
  echo "Could not resolve zone id for $ZONE_NAME (token/permissions?)"
  exit 1
end

echo "Zone $ZONE_NAME → $ZONE_ID"

set EXISTING (curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$RECORD_NAME&type=A" )

set RECORD_ID (printf '%s' "$EXISTING" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["result"][0]["id"] if d.get("success") and d["result"] else "")')

set PAYLOAD (python3 -c "import json; print(json.dumps({'type':'A','name':'$RECORD_NAME','content':'$TARGET_IP','ttl':1,'proxied':False}))")

if test -n "$RECORD_ID"
  echo "Updating A $RECORD_NAME → $TARGET_IP (DNS only, grey cloud)"
  curl -sS -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' \
    --data "$PAYLOAD" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("OK" if d.get("success") else d)'
else
  echo "Creating A $RECORD_NAME → $TARGET_IP (DNS only, grey cloud)"
  curl -sS -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' \
    --data "$PAYLOAD" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("OK" if d.get("success") else d)'
end

echo "dig:"
dig +short $RECORD_NAME A
