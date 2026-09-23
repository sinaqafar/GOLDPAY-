# ADR-005 — CubePay sits behind a port, and its 9% is modelled separately

**Status:** Accepted

## Context

Two distinct problems.

**Coupling.** CubePay is today's provider, not a permanent fact. SPEC 1446
requires `PaymentProviderPort` with CubePay, future and mock implementations
behind it.

**Economics.** CubePay charges roughly 9% of what it collects. The specification
is emphatic that this must never be merged with our 15% into a single headline
number shown to merchants:

> «۱۵٪ کارمزد پلتفرم است. ۹٪ CubePay هزینه زیرساخت پرداخت است. این دو را در پنل
> فروشنده به یک کارمزد تبدیل نمی‌کنیم.»

The merchant's contract is with us. CubePay deducts its cost from **our**
receipts, not from the merchant's credit.

## Decision

### Port

The domain depends on `PaymentProviderPort`. The CubePay adapter converts to and
from the provider's wire format and is the only place that knows about it. A
deterministic in-memory adapter backs tests and sandbox mode, and can simulate
success, failure, pending, timeout, mismatch and duplicate.

### Provider cost in the ledger

`calculateProviderCost()` computes the provider's cut on the **collected**
amount — not the base, since the provider charges on what actually passed
through it. Rounded CEIL: understating a cost we will be charged would flatter
platform margin, and the ledger must not do that.

At payment verification the journal gains two lines:

```
DR PLATFORM_EXPENSE_TOMAN     providerFee
CR PROVIDER_CLEARING_TOMAN    providerFee
```

The merchant's liability is untouched — it was fixed by the invoice fee
snapshot.

Worked example, MERCHANT mode, 1,000,000 base:

| | Toman |
|---|---:|
| customer pays | 1,000,000 |
| provider keeps (9%) | 90,000 |
| we receive | 910,000 |
| merchant credited | 850,000 |
| **platform gross margin** | **60,000** |

The rate comes from `PROVIDER_FEE_PERCENT` (default 9), never a constant buried
in code (SPEC 103.26).

## Consequences

Platform margin in the ledger is real margin. Reporting can show gross revenue,
provider cost and net separately, which SPEC 71.13 requires.

Replacing the provider means writing one adapter and changing one config value.
The financial core does not move.

A caveat worth stating: the 9% is modelled from configuration, not read back
from CubePay per transaction. If the real charge differs, reconciliation against
provider statements will surface the gap — the ledger records what we expect to
be charged, and the exception process handles the difference.
