# Architecture Overview

## What this system is

A Telegram-first payment gateway. Money arrives in **Toman** through CubePay and
leaves as **GRAM on TON Mainnet**.

```
Customer → Merchant Bot / Mini App → GRAM Gateway Core → CubePay VIP
→ Payment Verification → Ledger → 48h hold → Rate lock → Liquidity reservation
→ Signing → TON broadcast → Chain confirmation → Merchant wallet
```

## Layering (SPEC 117.41)

```
Presentation → Application → Domain ← Infrastructure Adapters
```

The domain imports no HTTP client, no SQL driver, no Redis, no Telegram SDK and
no TON SDK. Adapters depend on the domain, never the reverse.

`Ledger` depends on none of Telegram, CubePay, TON, Mini App or Admin
(SPEC 117.42). It is the bottom of the dependency graph because everything else
posts into it.

```
Payment Core → PaymentProviderPort   → CubePayAdapter
Payout Core  → BlockchainPayoutPort  → TonAdapter
App Event    → NotificationPort      → Telegram Adapter
```

## Packages

| Package | Responsibility |
|---|---|
| `money` | `Money`, `Percentage`, `Rate`. Integer/bigint only — floats are rejected at construction. |
| `errors` | `AppError` hierarchy and the category → HTTP status mapping. |
| `crypto` | HMAC signing, API key issuance, Telegram `initData` verification. |
| `database` | Connection, transactions, retry on serialization failure, migrations. |
| `ledger` | Chart of accounts and `post()` — the only way to move money. |
| `core` | Domain rules, use cases, ports, admin operations. |
| `config` | Environment loading plus the startup guards. |
| `ton` | Native GRAM transfers and chain queries. |

## Settlement asset

**GRAM is the native currency of TON.** Toncoin was renamed to Gram on
2026-06-15 — ticker only; addresses, balances and history are unchanged. There
is no jetton master, no token contract and no jetton wallet. A transfer is a
plain internal message carrying value, and network fees are paid in GRAM itself.

Amounts are held in **nanogram** (9 decimals).

## Transaction shape

Every financial operation follows SPEC 118:

```
BEGIN → Lock → Validate → Ledger → State Change → Outbox → COMMIT
```

**No HTTP call may happen inside a financial transaction** (SPEC 56.36). The
provider, Telegram and webhook calls all happen after the commit. A payment that
is committed but whose notification failed is correct; a payment rolled back
because Telegram was down is not.

## Money representation

| Value | Storage | Application |
|---|---|---|
| Toman | `NUMERIC(30,0)` | `bigint` via `Money` |
| GRAM | `NUMERIC(40,0)` nanogram | `bigint` via `Money` |
| Rate | `NUMERIC(40,18)` | scaled `bigint` via `Rate` |

`REAL` and `DOUBLE PRECISION` are forbidden for money anywhere in the schema.
Ceilings live in `packages/core/src/limits.ts` so oversized input is rejected as
a 400 instead of surfacing as an opaque numeric-overflow 500.

## Balance is a projection

`finance.balances` is derived from `finance.journal_entries`. The ledger is the
truth; the projection is a cache that must always agree with it. The integrity
sweep verifies this and freezes the platform on `LEDGER_IMBALANCE`.

## Protected modules (SPEC 117.104)

```
ledger · money · payout · treasury · payment-finalization · reconciliation · security
```

Changes here need specialist review. Structural changes need an ADR in
[`adr/`](./adr/).
