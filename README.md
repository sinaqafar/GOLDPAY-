# GRAM Gateway

A Toman-in / GRAM-on-TON-out payment gateway. A merchant issues an invoice in
Toman, the customer pays through the CubePay provider checkout, and after a
48-hour hold the platform automatically settles the merchant in GRAM on the TON
network.

Merchants onboard through a Telegram bot and Mini App. They never request a
payout — settlement is automatic.

## The rules this system is built around

These are not preferences. They are enforced in code, in the database schema,
and in the test suite.

| Rule | Where it is enforced |
|---|---|
| No verified evidence → no credit | `finalizePayment` re-verifies with the provider before any ledger entry |
| No eligibility → no release | `release_at = verified_paid_at + 48h`, re-checked inside the transaction |
| No full liquidity → no payout | `reservePayoutLiquidity` parks the payout in `WAITING_LIQUIDITY` |
| No liquidity → **WAIT, never BUY** | No auto-buy path exists; `AUTO_*` flags fail startup; DB rejects such a source |
| No chain confirmation → no `SETTLED` | DB `CHECK` requires a `transaction_hash` on `SETTLED` |
| `UNKNOWN` → reconcile, never blind retry | `failPayout` refuses an `UNKNOWN` payout; only `reconcilePayout` resolves it |
| Treasury is funded manually by the owner only | `assertTreasuryManualOnly` fails startup with `FORBIDDEN_TREASURY_AUTOMATION` |
| A balance is a projection, never an editable number | `finance.balances` is derived from the journal; the API reports `editable: false` |
| Money is never a float | `Money` is `bigint`-backed; the DB uses `NUMERIC`; floats throw |

## Money flow

```
INVOICE (Toman, fee snapshot frozen)
   ↓  customer pays via CubePay
PAYMENT VERIFIED  → ledger: DR provider clearing, CR merchant liability (PENDING)
   ↓                                             CR platform revenue
   ↓  48 hours
RELEASED          → ledger: PENDING → AVAILABLE (same account, bucket move)
   ↓  auto-queued, no merchant request
PAYOUT QUEUED     → ledger: AVAILABLE → SETTLING
   ↓
RATE LOCKED       → immutable Toman/GRAM snapshot
   ↓
RESERVED          → full-amount liquidity reservation, or WAITING_LIQUIDITY
   ↓
BROADCASTED       → TON jetton transfer
   ↓  chain confirmation
SETTLED           → close merchant liability, reduce treasury
```

### Fee modes (15% platform fee, snapshotted at invoice creation)

| Mode | Customer pays | Merchant receives |
|---|---|---|
| `CUSTOMER` | 115% | 100% |
| `MERCHANT` | 100% | 85% |
| `SPLIT` | 107.5% | 92.5% |

The identity `customerTotal − platformFee == merchantNet` holds in every mode
for every amount, and is asserted by both the code and a database `CHECK`.

## Layout

```
packages/
  money/       bigint money, percentages, exchange rates    (no dependencies)
  errors/      the typed error hierarchy
  core/        domain: fees, state machines, use cases, ports, outbox, webhooks
  ledger/      double-entry posting — the ONLY way money moves
  database/    driver port (PGlite or PostgreSQL) + transactions + migrator
  config/      validated configuration and the treasury safety guard
  crypto/      HMAC signing, API-key hashing, Telegram initData
  cubepay/     payment provider adapter (sandbox mode built in)
  ton/         TON/GRAM chain adapter (+ in-memory chain for tests)
  telegram/    Bot API client
apps/
  api/         HTTP API
  worker/      the payment → payout pipeline
  scheduler/   integrity sweeps and housekeeping
  bot/         Telegram bot
  mini-app/    Telegram Mini App (static UI + API proxy)
db/migrations/ schema (numbered, checksummed)
tests/         unit, integration and the golden-path end-to-end test
```

Dependencies point inwards: `apps → packages/core → packages/{money,errors}`.
The domain imports no HTTP client, no database driver and no Telegram SDK — only
ports, which are bound to adapters in `packages/core/src/container.ts`.

## Running it

```bash
npm install
cp .env.example .env

npm run db:migrate     # apply migrations
npm run db:seed        # chart of accounts + treasury account
npm run dev            # API      → http://localhost:3000
npm run worker         # pipeline
npm run scheduler      # integrity sweeps
npm run bot            # Telegram bot
npm run mini-app       # Mini App → http://localhost:3002

npm test               # 167 tests
npm run typecheck
```

By default `DATABASE_URL=pglite:.pgdata` runs an embedded PostgreSQL, so no
database server is needed for development. Production requires a real
`postgres://` URL — the config layer refuses to start otherwise.

## API

Every merchant request is signed:

```
Authorization:        Bearer <prefix>.<secret>
X-Gateway-Timestamp:  <unix seconds>
X-Gateway-Nonce:      <unique per request>
X-Gateway-Signature:  HMAC-SHA256(secret, canonical)

canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(raw body)
```

A nonce is accepted once. Timestamps outside the window are rejected. The body
hash is computed over the exact received bytes, so a modified payload can never
carry a valid signature.

| Route | Purpose |
|---|---|
| `POST /v1/invoices` | Create an invoice (honours `Idempotency-Key`) |
| `GET /v1/invoices/:id` | Fetch an invoice |
| `GET /v1/payments/:id` | Payment status and release time |
| `GET /v1/balances` | Available / pending / settling |
| `GET /v1/payouts` | Settlement history |
| `POST /v1/wallets` | Register a TON payout address |
| `POST /v1/integrations/webhooks` | Register a webhook endpoint |
| `POST /v1/webhooks/cubepay` | Inbound provider callback |
| `GET /health/{live,ready,dependencies}` | Health |

### Administration

`/internal/admin/*` uses a separate credential resolved against
`core.admin_users`, so a merchant key can never reach it. Seven roles
(SUPER_ADMIN, FINANCE_ADMIN, OPERATIONS_ADMIN, SUPPORT_AGENT, RISK_AGENT,
DEVELOPER_SUPPORT, READ_ONLY) map to an explicit permission list in
`packages/core/src/admin/rbac.ts` — there is no wildcard and no inheritance.

Two properties are enforced by that matrix and asserted by tests:

- **No role can both request and approve treasury funding.** FINANCE_ADMIN
  requests, SUPER_ADMIN approves, and the database rejects an approval whose
  approver equals the requester. Money moves only on approval.
- **Unfreezing is narrower than freezing.** Several roles can stop the platform
  in an emergency; only SUPER_ADMIN can start it again, and only once every
  CRITICAL reconciliation exception is resolved.

A ledger imbalance engages the freeze automatically, and the worker skips every
money-moving stage while it is on.

Create the first admin with:

```bash
npm run create-admin -- --name "Owner" --email owner@example.com --role SUPER_ADMIN
```

### Mini App

The Mini App authenticates with Telegram `initData` instead of an API key: the
client sends `X-Telegram-Init-Data`, and the server recomputes Telegram's HMAC
over the sorted field list. A forged signature, an altered payload or a stale
`auth_date` is refused. Its routes (`/v1/app/*`, `/v1/me`) call exactly the same
use cases as the merchant API — only the proof of identity differs.

It runs as its own process because the API sends `x-frame-options: DENY` (it
serves machines), while Telegram must embed the Mini App in an iframe. The Mini
App server therefore sets `frame-ancestors` for Telegram only, and proxies
`/v1/*` to the API so the browser never needs to know the API's address.

Outbound webhooks are signed with `X-Gateway-Event-Signature` and carry a stable
`X-Gateway-Event-Id`, so merchants can deduplicate. Delivery is retried with
exponential backoff; a `4xx` is treated as permanent.

## Safety properties, and the tests that prove them

- **Idempotency** — three identical provider callbacks produce exactly one
  credit, including when they arrive concurrently.
- **No double-spend** — a partial unique index allows one in-flight payout per
  merchant; concurrent release workers release a payment exactly once.
- **Immutability** — posted journals and audit rows reject `UPDATE`/`DELETE` at
  the database level, tested with direct SQL.
- **Tenant isolation** — merchant B asking for merchant A's invoice gets `404`,
  which does not even confirm the id exists.
- **Balance conservation** — a global debit/credit check per currency runs in
  the scheduler; an imbalance is recorded as `CRITICAL`.
- **SSRF defence** — webhook URLs resolving to private, loopback or
  cloud-metadata addresses are refused before any request is made.
- **Treasury** — every `AUTO_*` flag fails startup, and the database rejects any
  treasury transaction whose source implies automation.

## Deliberate design decisions

**`node --experimental-strip-types` instead of a build step.** The repository
runs TypeScript directly on Node 22. `tsc` is used purely as a type checker.

**PGlite behind a driver port.** No PostgreSQL server is available in every
environment, so `packages/database` selects between embedded PGlite and a real
`pg` pool from the same `DATABASE_URL`. All SQL is standard PostgreSQL.

**Node's `http` instead of a framework.** Signature verification needs the exact
raw request bytes. Frameworks that parse the body first make that guarantee
awkward, and a payment gateway should not be guessing which bytes were signed.

**The balance projection is updated with two statements.** `INSERT … ON CONFLICT
DO UPDATE` evaluates `CHECK` constraints against the proposed insert tuple
before conflict arbitration, so a debit against a liability would trip the
non-negative check even when the final balance is valid. Ensuring a zero row and
then applying the delta keeps the constraint meaningful: it fires only when the
*resulting* balance would go negative.
