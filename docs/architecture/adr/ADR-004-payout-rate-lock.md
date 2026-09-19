# ADR-004 — The Toman/GRAM rate is locked per payout

**Status:** Accepted

## Context

A payout is quoted in Toman and settled in GRAM. Between queuing and chain
confirmation the market moves. If the amount were recomputed at each step, the
figure reserved, the figure signed and the figure broadcast could all differ —
and the merchant's liability would never close cleanly.

## Decision

The rate is captured once, in `LockPayoutRateUseCase`, and frozen onto the
payout row:

```
rate · rate_source · quote_id · rate_locked_at · quote_expires_at · gram_amount_atomic
```

Conversion floors, so a merchant is never paid more GRAM than their Toman
liability covers. The remainder stays with the platform rather than being
created from nothing.

Every later stage reads the snapshot. SPEC 5484 forbids a worker recomputing the
amount, and SPEC 97.116 requires the broadcast guard to reject a payout whose
reserved liquidity disagrees with the locked figure
(`PAYOUT_AMOUNT_MISMATCH` → REVIEW).

A quote carries a TTL. An expired quote means the payout returns to
`WAITING_RATE` rather than being sent at a stale price.

## Consequences

The number the merchant is told is the number that lands. Market movement
between lock and confirmation is absorbed by the platform — which is the correct
place for it, since the platform controls the delay.

Rate provider outage surfaces as `WAITING_RATE`, a visible waiting state, rather
than a silent fallback to some default. There is no default: a payout without a
verifiable rate does not move.
