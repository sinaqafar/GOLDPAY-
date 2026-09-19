# ADR-008 — Queue and signer boundaries

**Status:** Accepted

## Context

Two infrastructure dependencies were stubbed: the payout signer produced a
fabricated reference, and the worker polled PostgreSQL instead of consuming a
queue. Both needed a permanent decision rather than another placeholder.

## Decision

### QueuePort with BullMQ behind it

`QueuePort` is the permanent boundary; `BullMqQueue` is the production
implementation and `InMemoryQueue` serves tests and single-process development.

Redis must run with `maxmemory-policy=noeviction` and AOF persistence. Eviction
would silently drop jobs, and a dropped payout job is money that never moves
while every dashboard reports the work as queued. Workers use
`maxRetriesPerRequest: null` so a reconnect does not kill an in-flight job.

Critically, **the queue is not the source of truth** (SPEC 121.67):

```
PostgreSQL → ledger · balances · payment state · payout state
Redis      → jobs · retries · scheduling
```

Job payloads carry identifiers only. Handlers re-read committed state and decide
from that, which is what makes at-least-once delivery safe: a replayed job is a
no-op, and a lost job is recoverable by scanning state.

### SignerPort with KMS/HSM behind it

`SignerPort` is likewise permanent. Key material never enters this process, so
the application's side is always "describe the transfer, receive a reference".

`KmsSigner` is the production implementation. `StubSigner` is development-only
and throws if constructed in production. A local mnemonic or keystore file is
explicitly **not** production architecture: it puts the key on the same disk as
the application, which is the exact failure the boundary exists to prevent.

The signer re-validates asset, network, sending wallet and amount itself
(SPEC 5567/7567) rather than trusting its caller, and refuses to produce a
second signature for a sign request id it has already consumed (SPEC 5569/5570).

## Consequences

Production now fails fast without `REDIS_URL`, `SIGNER_ENDPOINT` and
`TON_SIGNER_REFERENCE`. That is deliberate: each of those silently missing is
worse than a refused startup.

Swapping BullMQ for another broker, or a KMS for an HSM, is an adapter change.
The financial core does not move.
