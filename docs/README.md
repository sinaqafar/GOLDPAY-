# GRAM Gateway — Documentation

Structure mandated by SPEC 117.100.

| Directory | Contents |
|---|---|
| [`architecture/`](./architecture/) | System design and Architecture Decision Records |
| [`api/`](./api/) | HTTP contract, error codes, idempotency, webhooks |
| [`operations/`](./operations/) | Runbooks, treasury funding, daily operations |
| [`security/`](./security/) | Threat model, incident runbooks, key handling |
| [`recovery/`](./recovery/) | Disaster recovery and reconciliation ordering |

Project-wide knowledge distilled from the original specification conversations
lives in [`../siktir.md`](../siktir.md). Read that first.

## The rules that outrank everything else

```
LEDGER      → FINANCIAL TRUTH
PRIVATE KEY → SIGNER/KMS/HSM ONLY

no verified evidence  → no credit
no eligibility        → no release
no full liquidity     → no payout
no chain confirmation → no SETTLED
no liquidity          → WAIT, never BUY
UNKNOWN               → RECONCILE, never blind retry
UI                    ≠ truth
balance               ≠ editable
```
