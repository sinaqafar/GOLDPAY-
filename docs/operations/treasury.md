# Treasury Operations

## The rule

**GRAM enters the treasury only when the owner sends it manually.** The system
detects deposits; it never initiates acquisition. See
[ADR-003](../architecture/adr/ADR-003-manual-treasury-funding.md).

## Spendable balance

```
Spendable = Confirmed − Active Reservations − Safety Reserve
```

The safety reserve (`safety_reserve_atomic`) is untouchable working capital. It
exists so network fees and in-flight rounding never push the wallet to zero.

## Funding procedure

1. **Send.** The owner transfers GRAM to `TREASURY_ADDRESS` from their own
   wallet. The system is not involved.
2. **Confirm on chain.** Wait for finality. Note the transaction hash.
3. **Request.** An admin with `treasury:fund` submits amount, tx hash and a
   reason.
4. **Approve.** A *different* admin approves. Four-eyes is enforced by
   `ck_approval_four_eyes` — the same person cannot do both.
5. **Posted.** The ledger records:

   ```
   DR TREASURY_GRAM             amount
   CR TREASURY_FUNDING_EQUITY   amount
   ```

   Against **equity**, never revenue. Owner capital is not income
   (SPEC 119.22).

6. **Queue resumes.** Payouts in `WAITING_LIQUIDITY` are re-evaluated on the
   next worker pass.

Recording is idempotent on the transaction hash, so a re-scan cannot credit the
same deposit twice.

## When liquidity runs short

The payout waits. It is not cancelled, not partially paid, not covered by a
purchase.

```
Treasury short → WAITING_LIQUIDITY → owner funds manually
→ deposit detected → reconciled → queue reactivated
```

The merchant's liability is unchanged throughout — we still owe them.

### Partial payouts are refused

A payout of 100 GRAM against 90 spendable does not send 90. Either the full
amount goes or nothing does (SPEC 124.42).

### Selection when several payouts compete

The worker looks for a combination that fits rather than taking the oldest
blindly:

```
Spendable 1000 · A=900 · B=600 · C=400  →  B+C fills it exactly
```

Anti-starvation must stop A being deferred forever. The policy is configurable.

## Monitoring

| Signal | Meaning |
|---|---|
| `WAITING_LIQUIDITY` count rising | Treasury needs funding |
| Spendable near the safety reserve | Fund before the next payout cycle |
| `UNKNOWN` payouts | Reconciliation is falling behind |
| Any `LEDGER_IMBALANCE` | Critical — the platform auto-freezes |

## What operators cannot do

- Set a balance. Adjustments go through request → approval → journal.
- Delete a financial record. Corrections are compensating entries.
- Fund from an automated source. The schema rejects it.
- Mark a payout `SETTLED` without a transaction hash. The database rejects it.
