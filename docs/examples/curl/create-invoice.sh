#!/usr/bin/env bash
#
# Create an invoice with a signed request.
#
# Demonstrates the exact canonical string the gateway expects. The two things
# that most often go wrong are signing the path without its query string, and
# hashing a re-serialised body instead of the bytes actually sent.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:?set API_KEY to '<prefix>.<secret>'}"

SECRET="${API_KEY#*.}"

METHOD="POST"
TARGET="/v1/invoices"
BODY='{"amount":"1000000","description":"Order #42"}'

TIMESTAMP="$(date +%s)"
NONCE="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"

# Hash the EXACT bytes that will be sent. printf '%s' avoids the trailing
# newline that echo would add, which would change the hash.
BODY_SHA256="$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $NF}')"

# Fields joined by newlines, in this fixed order.
CANONICAL="$(printf '%s\n%s\n%s\n%s\n%s' "$METHOD" "$TARGET" "$TIMESTAMP" "$NONCE" "$BODY_SHA256")"

SIGNATURE="$(printf '%s' "$CANONICAL" \
  | openssl dgst -sha256 -hmac "$SECRET" -hex \
  | awk '{print $NF}')"

curl -sS -X "$METHOD" "${BASE_URL}${TARGET}" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${API_KEY}" \
  -H "x-gateway-timestamp: ${TIMESTAMP}" \
  -H "x-gateway-nonce: ${NONCE}" \
  -H "x-gateway-signature: ${SIGNATURE}" \
  -H "idempotency-key: inv_${NONCE}" \
  -d "$BODY"
