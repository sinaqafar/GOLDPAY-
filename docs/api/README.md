# API Contract

Base path `/v1`. Admin lives under `/internal/admin`.

## Authentication

| Caller | Mechanism |
|---|---|
| Merchant API | API key + HMAC-SHA256 signature |
| Mini App | Telegram `initData`, verified server-side |
| Admin | `Bearer <id|email>.<secret>` over a separate credential store |

`initDataUnsafe` is never trusted on its own (SPEC 1468).

### Signing

Canonical string, fixed order (SPEC 97.23):

```
METHOD \n PATH \n TIMESTAMP \n NONCE \n BODY_SHA256
```

The body hash is over the **raw** bytes, before any parsing. A request outside
the timestamp window is rejected; a replayed nonce is rejected.

## Response envelope

```json
{ "data": {}, "meta": { "request_id": "..." } }
```

```json
{ "error": { "code": "...", "message": "...", "request_id": "..." } }
```

`error.code` is stable and machine-readable. Never parse `message`.

Lists use cursor pagination:

```json
{ "data": [], "pagination": { "next_cursor": "...", "has_more": true } }
```

## Status mapping

| Category | HTTP |
|---|---|
| VALIDATION | 400 |
| AUTH | 401 |
| SECURITY | 403 |
| NOT_FOUND | 404 |
| CONFLICT | 409 |
| FINANCIAL | 422 |
| RATE_LIMITED | 429 |

## Error codes

```
INVALID_ARGUMENT · UNAUTHENTICATED · PERMISSION_DENIED · NOT_FOUND
CONFLICT · RATE_LIMITED · INTERNAL_ERROR

INVOICE_EXPIRED · INVOICE_CANCELLED · INVOICE_NOT_PAYABLE
PAYMENT_MISMATCH · PAYMENT_REVIEW · PAYMENT_UNKNOWN
PAYOUT_WAITING_LIQUIDITY · PAYOUT_WAITING_RATE · PAYOUT_REVIEW
PAYOUT_FAILED · PAYOUT_UNKNOWN · PAYOUT_NOT_SIGNABLE
PAYOUT_NOT_BROADCASTABLE · PAYOUT_AMOUNT_MISMATCH · DESTINATION_MISMATCH
WALLET_INVALID · WALLET_CHANGE_PENDING
MERCHANT_SUSPENDED · MERCHANT_FROZEN
INVALID_SIGNATURE · INVALID_NONCE · REQUEST_EXPIRED · IDEMPOTENCY_CONFLICT
AMOUNT_TOO_LARGE · AMOUNT_NEGATIVE
```

## Idempotency

Creating endpoints accept `Idempotency-Key`. The key is bound to a hash of the
request body:

- same key, same body → the original response, replayed;
- same key, different body → `409 IDEMPOTENCY_CONFLICT`.

An SDK must not blind-retry a financial POST without one (SPEC 1779).

## Amounts

Always **strings** of integer minor units. Never JSON numbers — a float cannot
represent large Toman values exactly, and a silently rounded amount is a
financial bug.

```json
{ "base_amount": "1000000", "customer_total": "1150000" }
```

## Hard rules

There is no endpoint that writes a ledger entry or sets a balance directly.
`POST /ledger/entries` and `PUT /balance` do not exist and must not be added
(SPEC 56.57/56.58).

A customer returning from checkout does not make a payment `PAID`
(SPEC 101378). Only verified provider evidence does.

## Webhooks

Headers:

```
X-Gateway-Event-Timestamp
X-Gateway-Event-Signature     HMAC-SHA256 over the canonical payload
```

Events: `payment.paid`, `payment.releasable`, `payout.queued`,
`payout.waiting_liquidity`, `payout.processing`, `payout.completed`,
`payout.failed`.

Delivery retries with exponential backoff
(10s → 30s → 1m → 5m → 15m → 1h → 3h → 12h → 24h) then dead-letters. Merchants
deduplicate on event id. A replay is a new delivery of an existing event, never
a new financial fact.

Endpoint registration is SSRF-checked: scheme, host, port, **resolved IP**, and
redirects. Private, loopback and link-local addresses are blocked after DNS
resolution, and rebinding is guarded against.
