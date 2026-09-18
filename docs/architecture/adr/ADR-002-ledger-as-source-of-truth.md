# ADR-002 — The ledger is the source of financial truth

**Status:** Accepted

## Context

The tempting design is a `balance` column that operations increment and
decrement. It is fast, obvious, and unrecoverable: when it disagrees with
reality there is no way to discover which of a thousand updates was wrong.

SPEC 118 is explicit — balances are a projection, the ledger wins, and
`LedgerService.post()` is the only posting path.

## Decision

Double-entry, append-only.

- `finance.journals` and `finance.journal_entries` are immutable. A database
  trigger rejects `UPDATE` and `DELETE`.
- Every journal must balance: total debits equal total credits, enforced in
  application code and by constraint.
- `finance.balances` is a projection maintained inside the same transaction.
- Corrections are **compensating entries**, never edits.
- `post()` is idempotent on `operation_id`, so a retried use case cannot post
  twice.
- Merchant money lives in a `LIABILITY` account; the PENDING → AVAILABLE →
  SETTLING bucket is a property of the entry, so the 48-hour release moves a
  bucket rather than changing value.

## Consequences

Any balance can be reconstructed by replaying entries, which makes the
reconciliation sweep meaningful: it recomputes from journals and compares to the
projection. A mismatch is `LEDGER_IMBALANCE`, severity CRITICAL, and it freezes
the platform automatically.

Admins cannot set a balance. The only route is
`Adjustment Request → Approval → Journal → Projection Update`. This is
deliberate friction on the most dangerous operation in the system.

The cost is verbosity — crediting a merchant is several lines rather than one
`UPDATE` — and the projection must be maintained transactionally. Both are worth
it for a system that has to survive an audit.
