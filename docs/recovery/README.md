# Recovery & Reconciliation

## The recovery criterion

After any crash the real state must be reconstructible from:

```
Database + Ledger + Provider State + TON Blockchain + Audit Logs + Event Logs
```

Every design decision in the financial core exists to keep that true.

## Restore ordering (SPEC 121.98)

```
1. Database
2. Ledger verification
3. Outbox
4. Queue
5. Provider reconciliation
6. Blockchain reconciliation
7. Resume workers
8. Resume traffic
```

**Do not broadcast immediately after a restore.** A restored database may
predate transactions that are already on chain; broadcasting before
reconciliation can double-send. Verify first, then resume.

## UNKNOWN is not FAILED

The most important distinction in the system.

A timeout means we do not know whether the network received the transaction. It
does **not** mean the transaction failed.

```
Payout            = UNKNOWN
Treasury reservation = PRESERVED
Merchant SETTLING    = PRESERVED
Reconciliation case  = OPEN
```

Funds stay committed. The money is not returned to `AVAILABLE`, because it may
already be gone. `failPayout()` refuses to act on an UNKNOWN payout — only
reconciliation resolves it.

Backoff: 1m → 2m → 5m → 10m → 30m → 1h → 3h → 6h. A payout unknown for too long
goes to `REVIEW` for a human. It is never failed on a timer.

## Crash points

Each must be recoverable (SPEC 121.104):

| Crash point | Recovery |
|---|---|
| Before commit | Rolled back; nothing happened |
| After commit, before outbox dispatch | Outbox worker picks it up |
| Before reservation | Payout retries from `RATE_LOCKED` |
| After reservation | Reservation is found; no second one is made |
| After signing, before broadcast | `SIGNED` state; existing signature reused |
| After broadcast, before confirmation | `BROADCASTED`; confirmation worker resumes |
| After confirmation | Settlement is idempotent; a second call moves nothing |

## Reconciliation exceptions

```
AMOUNT_MISMATCH · MISSING_PROVIDER · MISSING_INTERNAL · MISSING_CHAIN
DUPLICATE · UNKNOWN · STATE_MISMATCH · LEDGER_IMBALANCE
```

Severity LOW / MEDIUM / HIGH / CRITICAL. `LEDGER_IMBALANCE` is always CRITICAL
and triggers an automatic financial freeze — if the books do not balance, no
further money moves until a human has looked.

## Reconciling a payout

```
Query chain → Compare evidence → SUCCESS | FAILURE | STILL_UNKNOWN | MISMATCH
```

- **SUCCESS** → settle, close the reservation, resolve the exception.
- **FAILURE / not found on chain** → return funds to `AVAILABLE`, release the
  reservation.
- **STILL_UNKNOWN** → back off and retry; keep funds committed.
- **MISMATCH** → review. Never auto-correct a discrepancy.

## Overpayment and mismatch

Never auto-credited. The resolution is one of
`REVIEW | REFUND | EXTRA_CREDIT | MANUAL_RESOLUTION`, and it is a decision, not
a default.

## Integrity sweep

The scheduler continuously verifies that:

- every journal balances (debits == credits);
- the balance projection agrees with the journal entries;
- no payout is `SETTLED` without a transaction hash;
- no reservation is active past its expiry.

A failure raises a reconciliation exception. `LEDGER_IMBALANCE` freezes the
platform.

## Correction

Never edit. A correction is a **new compensating journal**, audited, with a
reason. The original entry stays exactly as it was posted — including when it
was wrong. That is the point of an audit trail.
