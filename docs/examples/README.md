# Integration examples

Every request to `/v1/*` is signed. The TypeScript SDK
(`packages/sdk`) does this for you; the examples here show the same
computation by hand for other languages (SPEC 1777).

## The canonical request

```
METHOD \n TARGET \n TIMESTAMP \n NONCE \n BODY_SHA256
```

| Field | Meaning |
|---|---|
| `METHOD` | Uppercase verb: `GET`, `POST` |
| `TARGET` | Path **including the query string** — `/v1/payments?limit=10` |
| `TIMESTAMP` | Unix seconds. Rejected outside the allowed window |
| `NONCE` | Unique per request. A replayed nonce is rejected |
| `BODY_SHA256` | SHA-256 hex of the **raw** body; empty string for GET |

The signature is `HMAC-SHA256(secret, canonical)` in lowercase hex.

Two mistakes to avoid:

- **Signing only the pathname.** The query string is part of the target. Leave
  it out and filters, limits and cursors are unauthenticated.
- **Re-serialising the body.** Hash exactly the bytes you send. Parsing and
  re-stringifying can reorder keys and change the hash.

## Headers

```
Authorization: Bearer <prefix>.<secret>
X-Gateway-Timestamp: <unix seconds>
X-Gateway-Nonce: <uuid>
X-Gateway-Signature: <hex hmac>
Idempotency-Key: <your key>        # required to safely retry a POST
Content-Type: application/json
```

## Idempotency

Send `Idempotency-Key` on every money-moving POST.

- Same key, same body → the original response, replayed.
- Same key, different body → `409 IDEMPOTENCY_CONFLICT`.

Without a key, a retry after a timeout can create a second invoice. **Never
blind-retry a financial POST** (SPEC 1779).

## Response envelope

```json
{ "data": { }, "meta": { "request_id": "..." } }
```

```json
{ "error": { "code": "...", "message": "...", "request_id": "..." } }
```

Branch on `error.code`, never on the message text — codes are stable, messages
are for humans.

## Amounts

Always integer strings of minor units. Never a JSON number: a float cannot hold
large Toman values exactly, and a silently rounded amount is a financial bug.

```json
{ "amount": "1000000" }
```

## Verifying our webhooks

```
X-Gateway-Event-Timestamp
X-Gateway-Event-Signature     HMAC-SHA256 of "<timestamp>.<raw body>"
```

Compare in constant time, reject anything outside a few minutes, and
deduplicate on the event id — delivery is at-least-once.

## Files

| File | |
|---|---|
| [`curl/create-invoice.sh`](./curl/create-invoice.sh) | Signing in shell |
| [`php/GramGateway.php`](./php/GramGateway.php) | Minimal PHP client |
| [`python/gram_gateway.py`](./python/gram_gateway.py) | Minimal Python client |
