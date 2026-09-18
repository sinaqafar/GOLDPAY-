# ADR-006 — GRAM is native TON, not a jetton

**Status:** Accepted · **Supersedes an earlier jetton-based implementation**

## Context

The project began targeting USDT-BEP20 on BSC and moved to GRAM on TON. During
that move the settlement asset was initially implemented as a **jetton** — TON's
token standard, the equivalent of an ERC-20 — with a `GRAM_JETTON_MASTER`
address, jetton wallet lookups and jetton transfer messages.

That was wrong.

Toncoin was renamed to **Gram** on 2026-06-15: a ticker change carried by an
81.22% community vote, 1:1, with addresses, balances and transaction history
untouched. The chain is still The Open Network. GRAM is therefore the **native
coin**, in the same position ETH occupies on Ethereum.

The specification says so directly:

> «در این مدل، Gram مستقیماً ارز بومی TON است؛ برای انتقال آن نیاز به قرارداد
> Jetton مثل USDT نیست، هر Wallet می‌تواند Gram دریافت کند، و هزینه‌های شبکه نیز
> با Gram پرداخت می‌شوند.»

## Decision

Treat GRAM as native.

| Removed | Replaced with |
|---|---|
| `GRAM_JETTON_MASTER` config | `GRAM_ASSET` (must equal `GRAM`) |
| jetton transfer payload | native value message, `PAY_GAS_SEPARATELY`, `bounce: false` |
| `/api/v3/jetton/wallets` | `/api/v3/accountStates` |

Units are **nanogram**, 9 decimals, `GRAM_DECIMALS=9`.

Fees are paid in GRAM from the sending wallet's own balance, so the recipient
receives exactly the quoted amount rather than the amount minus gas.

Production invariants now assert `GRAM_ASSET === 'GRAM'` and
`GRAM_DECIMALS === 9` at startup (SPEC 103.7), and the adapter re-checks the
asset and network before every send (SPEC 97.114) — configuration drift must
never reach the chain.

## Consequences

Simpler and cheaper: one message instead of a jetton wallet round-trip, no
contract deployment, no wallet-not-yet-deployed edge case, no separate gas
currency.

The treasury holds a single asset. There is no "enough GRAM but not enough TON
for fees" failure mode, because they are the same thing — though the safety
reserve still matters, since spendable balance must leave room for network fees.

The earlier jetton code has been removed rather than kept behind a flag. It
described an asset that does not exist.
