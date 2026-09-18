# ADR-003 — Treasury funding is manual, owner-only

**Status:** Accepted · **Non-negotiable**

## Context

When a merchant is owed GRAM and the treasury is short, an automated system
could buy, swap or bridge to cover the gap. The specification forbids this in
the strongest terms it uses anywhere:

```
❌ Auto Fill   ❌ Auto Buy      ❌ Auto Swap
❌ Auto Funding ❌ Auto Exchange ❌ Auto Bridge
```

Automated acquisition means the platform takes market risk it never agreed to,
executes trades nobody authorised, and can drain itself faster than any human
can react.

## Decision

GRAM enters the treasury only when the owner sends it manually. The system
**detects** an incoming transfer; it never **initiates** one.

Enforced at four levels:

1. **Startup guard.** Any of `AUTO_FUNDING`, `AUTO_BUY`, `AUTO_SWAP`,
   `AUTO_EXCHANGE`, `AUTO_BRIDGE` set true aborts boot with
   `FORBIDDEN_TREASURY_AUTOMATION`.
2. **Schema.** `finance.treasury_transactions.source` has a CHECK constraint
   admitting only `MANUAL`, `PAYOUT`, `NETWORK_FEE`.
3. **Absence.** No table, worker, queue or function named `auto_buy`,
   `auto_fund`, `swap_request` or `exchange_request` exists (SPEC 118).
4. **Four-eyes.** Recording funding requires one admin to request and a
   different admin to approve.

When liquidity is short the payout waits in `WAITING_LIQUIDITY`. It is not
cancelled, not partially paid, not funded by a purchase. The merchant's
liability is untouched — we still owe them; we simply cannot send yet.

## Consequences

Payouts can be delayed by owner inattention. That is the accepted trade: a
delayed payout is recoverable, an unauthorised market position is not.

Funding is idempotent on the on-chain transaction hash, so the same deposit
cannot be credited twice by a re-scan.
