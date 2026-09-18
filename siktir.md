# SIKTIR.MD — خروجی کامل هفت چت ChatGPT

> **این فایل حافظهٔ دائمی پروژه است.**
> هر مدل/توسعه‌دهنده‌ای که روی این مخزن کار می‌کند باید **اول این فایل را بخواند**.
> محتوای این فایل از هفت چت اشتراکی ChatGPT استخراج شده است. چت‌ها ممکن است حذف شوند
> (چت ۷ یک‌بار حذف شد و با لینک جدید بازیابی شد) — این فایل تنها نسخهٔ پایدار است.
>
> آخرین شمارهٔ آیتم در مشخصات اصلی: **104185** — `PART 125 → MASTER SPECIFICATION COMPLETE`

---

## فهرست

1. [منابع و وضعیت خواندن](#۱-منابع-و-وضعیت-خواندن)
2. [سازوکار سانسور در خروجی چت‌ها](#۲-سازوکار-سانسور-در-خروجی-چتها)
3. [هویت محصول](#۳-هویت-محصول)
4. [قوانین غیرقابل تغییر](#۴-قوانین-غیرقابل-تغییر)
5. [اقتصاد کارمزد](#۵-اقتصاد-کارمزد)
6. [دارایی GRAM — تصمیم قطعی](#۶-دارایی-gram--تصمیم-قطعی)
7. [ماشین حالت‌ها](#۷-ماشین-حالتها)
8. [دستورهای تراکنش مالی](#۸-دستورهای-تراکنش-مالی-part-90)
9. [ماتریس حسابداری](#۹-ماتریس-حسابداری-part-119)
10. [دیتابیس](#۱۰-دیتابیس-part-118--part-43--part-89)
11. [معماری و ساختار مخزن](#۱۱-معماری-و-ساختار-مخزن-part-117)
12. [Use Caseها](#۱۲-use-caseها-با-ترتیب-دقیق-گامها)
13. [رویدادها، صف‌ها، Webhook](#۱۳-رویدادها-صفها-webhook)
14. [API](#۱۴-api-part-77--part-97)
15. [امنیت](#۱۵-امنیت-part-19-part-97-part-48)
16. [ادمین و RBAC](#۱۶-ادمین-و-rbac-part-25)
17. [ربات تلگرام و Mini App](#۱۷-ربات-تلگرام-و-mini-app)
18. [پیکربندی](#۱۸-پیکربندی-part-56--part-103--part-117)
19. [تست](#۱۹-تست)
20. [سناریوهای کسب‌وکار](#۲۰-سناریوهای-کسبوکار-part-124)
21. [قوانین طلایی](#۲۱-قوانین-طلایی)
22. [وضعیت پیاده‌سازی فعلی](#۲۲-وضعیت-پیادهسازی-فعلی)
23. [شکاف‌های شناسایی‌شده](#۲۳-شکافهای-شناساییشده)
24. [دام‌های فنی محیط](#۲۴-دامهای-فنی-محیط)

---

## ۱. منابع و وضعیت خواندن

روش بازیابی: `fetch_page` روی `https://chatgpt.com/backend-api/share/<id>` با پارامتر `chunkIndex`.
لینک `chatgpt.com/share/<id>` فقط پوستهٔ HTML برمی‌گرداند. `r.jina.ai` خالی است.
**از bash هیچ دسترسی شبکه‌ای وجود ندارد** (`SSL_ERROR_SYSCALL` / `fetch failed`).

| # | شناسه | تکه | عنوان | وضعیت |
|---|---|---|---|---|
| ۱ | `6aac3de4-f724-83ed-b023-ac3746736ef3` | ۷۴۲ | پرداخت خودکار تتر | کدنویسی v0.3 — تمام تکه‌های محتوایی خوانده شد |
| ۲ | `6aac4740-6fb4-83eb-8a2f-e15b9138d318` | ۱۹۹ | پرداخت خودکار تتر (1) | معماری مادر v3 — کامل |
| ۳ | `6aacd5ca-90d8-83eb-acfb-44ae347994f2` | ۲۷۳ | — | PART 37–48 |
| ۴ | `6aacd60b-005c-83eb-b8b3-70a5f7a85b8b` | ۲۵۹ | — | PART 56–90 |
| ۵ | `6aacd63c-a488-83eb-bd4d-773f680675bb` | ۲۲۰ | — | PART 97–117 |
| ۶ | `6aacd58c-0804-83ed-a574-6e19f9b61a8a` | ۷۴۲ | — | کدنویسی v0.6 + چرخش به GRAM |
| ۷ | `6aacd66b-12fc-83eb-bc26-755a8d88979c` | ۹۶ | پرداخت خودکار تتر (5) | PART 117–125 — **کامل خوانده شد تا انتها** |

> شناسهٔ قدیمی چت ۷ (`6aacd66b-1b4c-83eb-9d29-e8a1bbc1e3c5`) **حذف شده** —
> `{"reason":"not_found","code":"shared_conversation_deleted"}`. لینک بالا جایگزین است.

**توزیع محتوا:** حدود ۶۰٪ تکه‌ها متادیتای JSON تکراری (`{"id":"fa75i5","edited":false,...}`)،
۲۰٪ نتایج جست‌وجوی وب، ۸٪ متن سانسورشده، و تنها **~۱۲٪ محتوای واقعی** است.
تمام آن ۱۲٪ در این فایل خلاصه شده است.

فهرست PARTها: 6 (DB)، 9 (Security)، 14 (Fees)، 19 (Security)، 20 (Deployment)، 25 (Admin)،
30 (Security)، 31 (Analytics)، 33 (Journeys)، 34 (State Machines)، 37 (Project Structure)،
38 (API Contract)، 43 (DB Schema)، 48 (Security)، 56 (Config)، 70 (Refund/Dispute)،
71 (Analytics/Export)، 77 (API)، 89 (SQL/Indexes)، 90 (Transaction Recipes)، 97 (Edge Security)،
103 (Config Governance)، 117 (Repo Blueprint)، 118 (SQL)، 119 (Accounting)، 120 (Backend Impl)،
121 (Final Contract)، 123 (Operations)، 124 (150 Scenarios)، 125 (Requirement→Test Matrix).

---

## ۲. سازوکار سانسور در خروجی چت‌ها

در چت‌های ۱ و ۶ (کدنویسی) هر **خروجی ابزار** با این رشته جایگزین شده:

```json
{"content":{"parts":["The output of this plugin was redacted."]},
 "metadata":{"is_redacted":true}}
```

| باقی می‌ماند | حذف می‌شود |
|---|---|
| پیام‌های کاربر | خروجی `container.exec` (stdout/stderr) |
| متن دستیار | نتایج `web.run` |
| استدلال/`thoughts` دستیار | خروجی `tsc` و لاگ تست |
| **دستورهای bash و heredocها** (`content_type:"code"`) | |
| عنوان نتایج جست‌وجو | |

**نتیجهٔ مهم:** چون heredocها سالم‌اند، **تمام سورس‌کد نوشته‌شده قابل بازیابی است**؛
فقط نتیجهٔ اجرا از دست رفته. دور زدن سانسور ممکن نیست — داده در خروجی وجود ندارد.

---

## ۳. هویت محصول

**GRAM Gateway / CubePay VIP** — درگاه پرداخت Telegram-First:
ورودی **تومان**، خروجی **GRAM روی TON Mainnet**.

عنوان چت‌ها «پرداخت خودکار تتر» است اما **محصول طراحی‌شده تتر نیست**؛
مسیر از USDT-BEP20 شروع شد و به GRAM/TON رسید.

```
Customer → Merchant Bot/Website → Telegram Mini App → GRAM Gateway Core
→ CubePay VIP → Payment Verification → Ledger Engine → 48h Settlement
→ Rate Engine → GRAM Payout Engine → TON Mainnet → Merchant Wallet
```

نقش‌ها: Customer، Merchant، Admin، Finance Operator، Developer.

---

## ۴. قوانین غیرقابل تغییر

```
کارمزد پلتفرم:        15%
دارایی تسویه:          GRAM
شبکه:                  TON Mainnet
Hold:                  48 ساعت
خزانه:                 فقط دستی توسط مالک
```

**ممنوعیت مطلق اتوماسیون خزانه:**

```
❌ Auto Fill   ❌ Auto Buy   ❌ Auto Swap
❌ Auto Funding   ❌ Auto Exchange   ❌ Auto Bridge
```

اگر هر کدام `true` باشد:

```
APPLICATION START = FAILED
REASON = FORBIDDEN_TREASURY_AUTOMATION
```

هیچ جدول/Workerی به نام `auto_buy`، `auto_fund`، `swap_request`، `exchange_request` نباید وجود داشته باشد.

**اگر GRAM کافی نباشد، پرداخت حذف نمی‌شود → `WAITING_LIQUIDITY`.**

---

## ۵. اقتصاد کارمزد

### مدل نهایی ۱۵٪ (PART 700 / v0.6) — مبلغ پایه ۱٬۰۰۰٬۰۰۰ تومان

| حالت | پرداخت مشتری | کارمزد خریدار | کارمزد فروشنده | اعتبار فروشنده |
|---|---:|---:|---:|---:|
| CUSTOMER | 1,150,000 | 150,000 | 0 | 1,000,000 |
| MERCHANT | 1,000,000 | 0 | 150,000 | 850,000 |
| SPLIT (7.5/7.5) | 1,075,000 | 75,000 | 75,000 | 925,000 |

### تاریخچه — مدل منسوخ ۱۲٪ (ch450، فقط برای مرجع)

| حالت | پرداخت مشتری | اعتبار فروشنده |
|---|---:|---:|
| خریدار | 1,120,000 | 1,000,000 |
| فروشنده | 1,000,000 | 880,000 |
| نصف‌نصف (6/6) | 1,060,000 | 940,000 |

### فرمول‌های پایه (مستقل از نرخ)

```
Base Amount + Customer Fee + Merchant Fee = Invoice Amount
Invoice Amount − CubePay Fee            = CubePay Net
Base Amount − Merchant Fee              = Merchant Credit
CubePay Net − Merchant Credit           = Platform Gross Margin
```

### 🔴 کارمزد ۹٪ CubePay — تصمیم طراحی قفل‌شده

> **«۱۵٪ کارمزد پلتفرم است. ۹٪ CubePay هزینهٔ زیرساخت پرداخت است.
> این دو را در پنل فروشنده به یک کارمزد ۲۴٪ تبدیل نمی‌کنیم.»**

فروشنده فقط قرارداد مالی خود با پلتفرم ما را می‌بیند. CubePay پشت صحنه هزینه‌اش را
از **دریافتی ما** کم می‌کند. مثال در حالت MERCHANT با ۱۲٪ (ch450):

```
مشتری → 1,000,000
     ↓ CubePay کسر 9% → 90,000
     ↓
  910,000  ← دریافتی ما
     ├── 880,000 → موجودی فروشنده
     └──  30,000 → حاشیهٔ پلتفرم
```

ثبت‌های Ledger که مشخصات می‌خواهد:

```
invoice_created   |  cube_payment_received
cube_pay_fee      |  platform_fee
merchant_credit
```

### Snapshot اجباری فاکتور

```
base_amount, fee_rate_snapshot, fee_payer_snapshot,
customer_fee, merchant_fee, invoice_amount
```

تغییر بعدی نرخ **هرگز** روی فاکتور قدیمی اثر ندارد. Fee Config به‌جای UPDATE،
رکورد جدید با `effective_from`/`effective_until` می‌گیرد.

جدول تنظیمات: `merchant_payment_settings(merchant_id, fee_rate, fee_payer,
fee_split_buyer_percent, fee_split_merchant_percent, minimum_charge, maximum_charge)`

نرخ به **BPS صحیح**: `15% = 1500 BPS`، `7.5% = 750 BPS`.

---

## ۶. دارایی GRAM — تصمیم قطعی

**GRAM ارز بومی TON است، نه Jetton.** سه تأیید مستقل:

۱. **چت ۶، تکه ۱۵۰** (نقل مستقیم):
> «در این مدل، Gram مستقیماً ارز بومی TON است؛ **برای انتقال آن نیاز به قرارداد Jetton
> مثل USDT نیست**، هر Wallet می‌تواند Gram دریافت کند، و هزینه‌های شبکه نیز با Gram
> پرداخت می‌شوند.»

۲. **چت ۶، تکه ۵۳۰**:
> «طبق تغییر رسمی سال ۲۰۲۶، **Toncoin (TON) به Gram (GRAM) تغییر نام داده است**؛
> این فقط تغییر نام است و نه مهاجرت توکن: آدرس‌ها، موجودی‌ها و تراکنش‌های قبلی همان
> هستند. خود شبکه همچنان **The Open Network (TON)** نام دارد.»

۳. جست‌وجوی وب: تغییر نام ۲۰۲۶-۰۶-۱۵، رأی ۸۱٫۲۲٪، نسبت ۱:۱، بدون مهاجرت.

**پیامدها:** واحد کوچک **nanogram** (`GRAM_DECIMALS=9`)؛ بدون jetton wallet؛ بدون
token contract؛ کارمزد شبکه با خود GRAM؛ نیاز به fee پویا، safety reserve، اعتبارسنجی
آدرس mainnet و لاگ تراکنش.

```
TON  = نام بلاکچین
GRAM = ارز بومی همان بلاکچین
TON Wallet = حساب روی شبکه TON
CubePay VIP = درگاه ریالی
```

---

## ۷. ماشین حالت‌ها

### Payment
```
PENDING → VERIFYING → PAID | FAILED | EXPIRED | MISMATCH | REVIEW | UNKNOWN
```

### Payout (زنجیرهٔ کامل با مرحلهٔ SIGNED — **پیاده‌سازی‌شده**)
```
CREATED → QUEUED → RATE_LOCKED → RESERVED → SIGNED → BROADCASTED → SETTLED
                        ↘ WAITING_LIQUIDITY    ↘ FAILED | UNKNOWN
```
حالت‌های انتظار: `WAITING_LIQUIDITY`، `WAITING_RATE`، `WAITING_NETWORK`، `WAITING_WALLET`

### Balance Bucket
```
PENDING → AVAILABLE → SETTLING → SETTLED    (+ HOLD)
```

### Wallet
```
PENDING → VERIFIED → ACTIVE
```
تغییر Wallet نیاز به Security Hold + 2FA + Cooldown دارد.
`activation_available_at = now() + 24h`

### Reservation
```
NONE → ACTIVE → CONSUMED | EXPIRED | RELEASED
```

### گذارهای ممنوع
```
CREATED → SETTLED     PENDING → SETTLED
FAILED  → SETTLED     SETTLED → PENDING
```

---

## ۸. دستورهای تراکنش مالی (PART 90)

### Verify Payment
```
BEGIN → Lock Payment → Check Status → Check Provider Event
→ Validate Provider Result → Validate Amount → Validate Currency
→ Validate Order → Check Duplicate → Set VERIFIED
→ Set verified_paid_at → Post Ledger Journal → Create Outbox → COMMIT
```
**ثابت:** `Payment VERIFIED ⇔ Required Ledger Posting Exists`

### 48H Release
```
BEGIN → Lock Payment → Check VERIFIED → Check verified_paid_at
→ Check now >= verified_paid_at + 48H → Check not already released
→ Post PENDING → AVAILABLE → Create Outbox → COMMIT
```

### Reserve Payout
```
BEGIN → Lock Merchant Financial State → Recheck Available
→ Recheck Eligibility → Recheck Treasury Liquidity
→ Reserve Merchant → Reserve Treasury → Create Payout
→ Create Journals → Create Outbox → COMMIT
```

حساب‌داری رزرو:
```
AVAILABLE -= payout_amount        SPENDABLE -= gram_amount
SETTLING  += payout_amount        RESERVED  += gram_amount
```

### Finalize Success
```
Settling -= Amount        Treasury Reserved -= GRAM
Settled  += Amount        Treasury Consumed += GRAM
```

### Finalize Definitive Failure
```
Settling  -= Amount       Treasury Reserved  -= GRAM
Available += Amount       Treasury Spendable += GRAM
```

### UNKNOWN (حیاتی)
```
Payout = UNKNOWN
Treasury Reservation = PRESERVED
Merchant Settling    = PRESERVED
Reconciliation Case  = OPEN
```

### Manual Treasury Deposit
```
Detect Deposit → Validate Wallet → Validate Amount → Validate Tx
→ Confirm Chain → Post Treasury Journal → Update Spendable → Create Event
```
این مسیر **هرگز** Buy/Swap/Exchange را Trigger نمی‌کند.

**قانون مرزی:** هیچ فراخوانی HTTP داخل تراکنش مالی. اول COMMIT، بعد Provider/Telegram/Webhook.

### Backoff برای UNKNOWN
```
1m → 2m → 5m → 10m → 30m → 1h → 3h → 6h
```

### Backoff برای Webhook
```
10s → 30s → 1m → 5m → 15m → 1h → 3h → 12h → 24h → DEAD_LETTER
```

---

## ۹. ماتریس حسابداری (PART 119)

| رویداد | اثر |
|---|---|
| Payment Verified | Clearing Asset ↑ ، Merchant Liability(PENDING) ↑ ، Platform Revenue ↑ |
| Released | Liability: PENDING → AVAILABLE |
| Payout Queued | AVAILABLE → SETTLING |
| Payout Confirmed | بستن Merchant Liability + کاهش Treasury GRAM |
| Payout Failed | SETTLING → AVAILABLE ، Reservation ACTIVE → RELEASED |
| Refund | ژورنال معکوس جدا — هرگز ویرایش ژورنال اصلی |
| Network/Provider Cost | Platform Expense |
| Manual Treasury Funding | Treasury Asset ↑ در برابر **Equity** (نه Revenue) |

`Total Refunds <= Refundable Amount` — هم در اپ، هم در DB.

**Mismatch/Overpayment:** `REVIEW | REFUND | EXTRA_CREDIT | MANUAL_RESOLUTION` — هرگز اعتبار خودکار.

**استثناهای مغایرت:** `AMOUNT_MISMATCH`، `MISSING_PROVIDER`، `MISSING_INTERNAL`،
`MISSING_CHAIN`، `DUPLICATE`، `UNKNOWN`، `STATE_MISMATCH`، `LEDGER_IMBALANCE`
شدت: LOW / MEDIUM / HIGH / CRITICAL — ledger imbalance = CRITICAL → انجماد مالی.

**قوانین نهایی:**
```
REFUND     ≠ BALANCE EDIT
ADJUSTMENT = NEW AUDITED JOURNAL
DISPUTE    = CASE + EVIDENCE + DECISION
Revenue    = Posted Ledger Revenue   (نه SUM(invoice.fee))
```

---

## ۱۰. دیتابیس (PART 118 / PART 43 / PART 89)

### انواع
```
Money تومان      NUMERIC(30,0)
GRAM atomic      NUMERIC(40,0)   (nanogram)
Rate             NUMERIC(40,18)
REAL/DOUBLE      ممنوع مطلق
PK               UUID (UUIDv7/ULID)
Timestamp        TIMESTAMPTZ
metadata         JSONB
FK               ON DELETE RESTRICT
Soft delete      deleted_at
```

### Schemaها
```
public/core → موجودیت‌های اصلی
financial   → ledger / payouts / treasury
integration → integrations / webhooks
security    → sessions / audit
analytics   → گزارش
system      → jobs / outbox / reconciliation
```

### الگوی تراکنش
```
BEGIN → Lock → Validate → Ledger → State Change → Outbox → COMMIT
```

به‌روزرسانی شرطی: `WHERE id=$1 AND status='QUEUED'` — اگر `rows_affected=0` یعنی قبلاً منتقل شده.
صف Payout: `FOR UPDATE SKIP LOCKED ORDER BY created_at`.
کاندیدای ۴۸ ساعت: `WHERE status='VERIFIED' AND release_at <= NOW()` (در تراکنش دوباره اعتبارسنجی شود).
`Spendable = Confirmed − Active Reservations − Operational Reserve`.

### ایندکس‌های حیاتی
```sql
CREATE INDEX idx_payments_eligible_scan ON payments (verified_paid_at)
  WHERE status = 'VERIFIED';

CREATE INDEX idx_payout_queue ON payouts (created_at)
  WHERE status IN ('QUEUED', 'WAITING_LIQUIDITY');

CREATE INDEX idx_unknown_payouts ON payouts (updated_at)
  WHERE status = 'UNKNOWN';

CREATE INDEX idx_review_queue ON review_cases (created_at)
  WHERE status IN ('OPEN','INVESTIGATING','DECISION_PENDING');

CREATE INDEX idx_reconciliation_open ON reconciliation_items (created_at)
  WHERE status IN ('OPEN','INVESTIGATING');
```

### قیدهای یکتا
```
merchant_id + merchant_order_id
merchant_id + idempotency_key
provider + provider_reference
tx_hash
api_key_identifier
reservation_id
UNIQUE(event_id)                      -- outbox
UNIQUE(source, external_event_id)     -- inbox
UNIQUE(update_id)                     -- telegram_updates
```

### ممنوعیت حذف
```
DELETE FROM ledger_entries    ❌
DELETE FROM payouts           ❌
DELETE FROM payment_events    ❌
```
اصلاح فقط با **Compensating Entry**. Trigger دفاعی باید UPDATE/DELETE را Reject کند.

Balance یک **projection** است — Ledger حقیقت است.
Secrets به‌صورت `secret_reference`؛ API Key به‌صورت `key_prefix` + `secret_hash`.

### ثوابت پایانی PART 89
```
NO DUPLICATE PROVIDER EVENT     NO DUPLICATE PROVIDER TX
NO DUPLICATE IDEMPOTENCY KEY    NO MULTIPLE ACTIVE WALLET
NO ORPHAN FINANCIAL RECORD      NO SILENT LEDGER MUTATION
```

---

## ۱۱. معماری و ساختار مخزن (PART 117)

```
cubepay-gateway/
├── apps/       api · bot · mini-app · admin · worker · scheduler
├── packages/   config · types · contracts · errors · money · validation
│               database · queue · logger · crypto · observability
│               sdk · telegram · cubepay · ton
├── infra/      docker · nginx · postgres · redis · monitoring
├── scripts/    migrate · seed · health-check · reconcile
├── tests/      unit · integration · contract · e2e · security · chaos · financial
├── docs/       architecture · api · integrations · operations · security · recovery
└── .github/workflows/
```

### لایه‌بندی
```
Presentation → Application → Domain ← Infrastructure Adapters
```

Domain نباید اینها را import کند:
`NestJS Controller`، `PostgreSQL Driver`، `Redis`، `Axios`، `Telegram SDK`، `TON SDK`، `CubePay SDK`

**Ledger** نباید به `Telegram`، `CubePay`، `TON`، `Mini App`، `Admin` وابسته باشد.

```
Payment Core → PaymentProviderPort → CubePayAdapter
Payout Core  → BlockchainPayoutPort → TONAdapter
App Event    → NotificationPort     → Telegram Adapter
```

### ترتیب پیاده‌سازی (اجباری)
```
Repository → Config → Database → Money → Ledger → Merchant → Invoice
→ Payment → Release → Payout → Treasury → TON → API → Bot
→ Mini App → Admin → Integrations → Observability → Full Tests
```
**UI عمداً بعد از Financial Core است.** دلیل: `Payment/Payout/Refund/Correction/Treasury → Ledger`.

### ماژول‌های محافظت‌شده
```
ledger · money · payout · treasury · payment-finalization · reconciliation · security
```

### قواعد نام‌گذاری
```
payment.entity.ts · payment.repository.ts · finalize-payment.use-case.ts
```
ممنوع: `utils.ts`، `helpers.ts`، `service.ts`، `manager.ts`

### منطق مالی پنهان ممنوع
```
amount * 0.15            ❌ در UI/Controller
now - createdAt > 48h    ❌ در UI/Controller
```
Config = `PAYOUT_HOLD_HOURS=48` اما Business Rule = `eligibility = verified_paid_at + holdDuration`

SQL در Controller/Telegram Handler/Worker Handler/Domain/Frontend **ممنوع** — فقط در Repository.

تغییر ساختار باید با **ADR** ثبت شود: `docs/architecture/adr/ADR-00X-*.md`

---

## ۱۲. Use Caseها با ترتیب دقیق گام‌ها

**FinalizePaymentUseCase**
`Load Payment → Check Idempotency → Verify Provider Evidence → Validate Amount
→ Validate Invoice → Calculate Snapshot Financials → Post Ledger → Update Payment
→ Create Outbox Events → Commit`

**ReleasePaymentUseCase**
`Find eligible → Lock → Validate 48h → Validate holds → PENDING→AVAILABLE
→ Post ledger transition → Create event → Commit`

**QueuePayoutUseCase**
`Find merchant liability → Validate wallet → Validate eligibility → Validate risk
→ Snapshot amount → Create payout → AVAILABLE→SETTLING → Commit → Enqueue worker`

**LockPayoutRateUseCase**
`Load payout → Acquire valid quote → Validate quote TTL → Calculate GRAM
→ Persist immutable rate snapshot → Commit`

**ReservePayoutLiquidityUseCase**
`Load treasury → Calculate spendable → Validate full amount → Reserve → Commit`

**BroadcastPayoutUseCase**
`Validate payout → Validate reservation → Build immutable transaction
→ Call TON adapter → Persist tx hash/evidence → Change state → Commit`

**ReconcilePayoutUseCase**
`Load unresolved payout → Query chain → Match transaction → Determine state
→ Update evidence → Finalize or recover → Emit event`

### قرارداد سرویس‌ها
```ts
transaction.run(async (tx) => { /* domain · ledger · state · outbox */ });

interface LedgerService {
  post(entry: JournalDraft, tx: TransactionContext): Promise<...>;
  getBalance(accountId: AccountId): Promise<...>;
}
```
`post()` **تنها** مسیر مجاز Posting است.

---

## ۱۳. رویدادها، صف‌ها، Webhook

### رویدادها
```
user.created
merchant.created · merchant.activated · merchant.suspended
invoice.created · invoice.expired · invoice.cancelled
payment.created · payment.detected · payment.verified · payment.failed · payment.released
ledger.posted · ledger.released
payout.created · payout.queued · payout.settling · payout.broadcasted
payout.confirming · payout.completed · payout.failed · payout.unknown
wallet.created · wallet.changed · wallet.disabled
treasury.deposit.detected · treasury.deposit.confirmed · treasury.funded
webhook.created · webhook.delivered · webhook.failed
reconciliation.mismatch
```

### پاکت رویداد
```json
{ "event_id":"EVT_...", "event_type":"payment.verified", "version":1,
  "occurred_at":"...", "aggregate_type":"payment", "aggregate_id":"PAY_...",
  "merchant_id":"MER_...", "correlation_id":"COR_...", "causation_id":"EVT_...",
  "actor":"...", "payload":{} }
```

### صف‌ها
```
queue.payment.verification · queue.payment.release
queue.payout.selection · queue.payout.broadcast · queue.payout.reconciliation
queue.webhook.delivery · queue.notification.telegram
queue.reconciliation · queue.maintenance
```

### Webhook خروجی
رویدادها: `payment.paid`، `payment.releasable`، `payout.queued`،
`payout.waiting_liquidity`، `payout.processing`، `payout.completed`، `payout.failed`

هدرها: `X-Gateway-Event-Timestamp`، `X-Gateway-Event-Signature` (HMAC-SHA256)
جایگزین پیشنهادی PART 77: `X-Webhook-Id`، `X-Webhook-Timestamp`، `X-Webhook-Signature`

Replay یک **Delivery جدید** است و نباید رویداد مالی جدید بسازد.
Webhook Worker نباید State مالی را با پاسخ Merchant تغییر دهد.

### الگوهای Outbox/Inbox
```
Ledger Update + Payment Update + Outbox Event = یک تراکنش
```
Inbox برای Provider Webhook، External Bot Events، Telegram Events.

### طبقه‌بندی خطای Worker
```
VALIDATION_ERROR · BUSINESS_RULE_ERROR · TRANSIENT_ERROR
EXTERNAL_PROVIDER_ERROR · NETWORK_ERROR · AUTH_ERROR
SECURITY_ERROR · CONCURRENCY_ERROR · DATABASE_ERROR · UNKNOWN_ERROR
```

---

## ۱۴. API (PART 77 / PART 97)

### مسیرها
```
/v1/auth/* · /v1/merchants/* · /v1/invoices/* · /v1/payments/*
/v1/balances/* · /v1/payouts/* · /v1/wallets/* · /v1/integrations/*
/v1/webhooks/* · /v1/developer/* · /v1/support/*
/internal/admin/*
/health/live · /health/ready · /health/dependencies
/checkout/{invoice_public_id}
```

### کدهای خطا
```
INVALID_ARGUMENT · UNAUTHENTICATED · PERMISSION_DENIED · NOT_FOUND
CONFLICT · RATE_LIMITED · INTERNAL_ERROR
INVOICE_EXPIRED · INVOICE_CANCELLED
PAYMENT_MISMATCH · PAYMENT_REVIEW · PAYMENT_UNKNOWN
PAYOUT_WAITING_LIQUIDITY · PAYOUT_WAITING_RATE · PAYOUT_REVIEW
PAYOUT_FAILED · PAYOUT_UNKNOWN
WALLET_INVALID · WALLET_CHANGE_PENDING
MERCHANT_SUSPENDED · MERCHANT_FROZEN
INVALID_SIGNATURE · INVALID_NONCE · REQUEST_EXPIRED
IDEMPOTENCY_CONFLICT · DESTINATION_MISMATCH · PAYOUT_AMOUNT_MISMATCH
```

### پاکت پاسخ
```json
{ "data": {}, "meta": { "request_id": "..." } }
{ "error": { "code": "...", "message": "...", "request_id": "..." } }
```
صفحه‌بندی: `{ "data":[], "pagination":{"next_cursor":"...","has_more":true} }`

### Idempotency
رکورد: `merchant · key · request_hash · response · resource_id · status`
همان کلید + همان بدنه → همان پاسخ. همان کلید + بدنهٔ متفاوت → `IDEMPOTENCY_CONFLICT` (409).

### امضای درخواست
```
METHOD \n PATH \n TIMESTAMP \n NONCE \n BODY_SHA256
```
ترتیب ثابت؛ تغییر whitespace نباید ابهام ایجاد کند.

### قواعد PART 97
مبالغ همیشه **رشته**، هرگز float. رد فیلدهای ناشناخته در عملیات حساس.
`405` برای متد نامجاز، `415` برای Content-Type اشتباه.
IDOR — همیشه tenant-scope. SSRF — اعتبارسنجی scheme/host/port/**IP حل‌شده**/redirect،
مسدودسازی private+loopback+link-local پس از DNS، محافظت در برابر DNS rebinding.
Webhook با timeout و سقف اندازهٔ پاسخ.

**نکتهٔ تعارض:** PART 77 §43 آرایهٔ `scopes` دارد ولی PART 118.38 ندارد —
پیاده‌سازی از PART 118 پیروی می‌کند (بدون scopes).

### ماتریس API
| حوزه | Endpoint | Auth | مالی |
|---|---|---|---|
| Invoice | Create | API/Session | ایجاد تعهد |
| Payment | Verify | Internal/Admin | بله |
| Payout | Create | API/Session | بله |
| Wallet | Change | API/Session | بله |
| Ledger Adjustment | Admin | Admin | بله |

**بدون Endpoint مستقیم:** `POST /ledger/entries` ❌ ، `PUT /balance` ❌

`Redirect ≠ API Truth` — بازگشت مشتری از Checkout هرگز Payment را PAID نمی‌کند.

---

## ۱۵. امنیت (PART 19, PART 97, PART 48)

### هفت لایه
```
User → API → Payment → Financial → Blockchain → Infrastructure → Audit
```

```
Every Important Action = Authentication + Authorization + Audit
```

### احراز هویت
- Merchant → Telegram Authentication (اعتبارسنجی سمت سرور `initData`)
- Admin → Username + Password + 2FA
- API → API Key + Secret + Signature

`initDataUnsafe` هرگز نباید به‌تنهایی مبنای احراز هویت باشد.

### 2FA اجباری برای
```
Admin Login · Treasury Change · Wallet Change · Large Transfer · API Secret Reveal
```

### Risk Engine
امتیاز 0–100 → LOW (0–30) خودکار · MEDIUM (30–70) تأیید اضافی · HIGH (70–100) بررسی دستی
خروجی: `ALLOW | CHALLENGE | DELAY | REVIEW | FREEZE | BLOCK`
**Risk Engine خودش نباید Ledger را تغییر دهد.**

### سه گارد Broadcast (PART 97 §113–116)
| گارد | شرط | خطا |
|---|---|---|
| شبکه | `GRAM_ASSET != GRAM` یا `GRAM_NETWORK != TON_MAINNET` | توقف Broadcast |
| مقصد | آدرس ≠ Wallet Snapshot | `DESTINATION_MISMATCH` |
| مبلغ | مبلغ ≠ Rate Lock | `PAYOUT_AMOUNT_MISMATCH` → REVIEW |

Production Broadcast به Testnet باید با Guard مسدود شود.
Production Signer هرگز نباید تراکنش Testnet امضا کند.

### ایزوله‌سازی Signer
Signer بیشترین Network Isolation را دارد و خودش Verify می‌کند:
`GRAM · TON_MAINNET · authorized payout · authorized destination · authorized amount`

درخواست امضا: `request_id · payout_id · asset · network · destination · amount · nonce`
Sign Request نباید دوبار اجرا شود. Private Key هرگز در logs/database/queue/Redis/frontend/Git.

### هدرهای امنیتی
```
Content-Security-Policy · X-Content-Type-Options: nosniff
Referrer-Policy · Permissions-Policy · Strict-Transport-Security
```
CORS با `*` برای API حساس ممنوع. Wildcard + Credentials ممنوع.
Bearer Token هرگز در URL.

### Runbookها
Wallet Compromise: `توقف Dispatcher → Disable Signer → Emergency Mode
→ Reconcile Balance/Reservations → بررسی تراکنش‌های Unknown
→ حفظ Audit → جایگزینی Wallet`

Admin Compromise · API Key Leak · Webhook Attack · DB Compromise · Provider Compromise

### Incident
```
DETECT → CONTAIN → INVESTIGATE → ROTATE SECRETS → VERIFY SYSTEM
→ RECONCILE FINANCIAL STATE → RESUME
```
بدون Reconciliation، Resume کامل نیست.

`SECURITY_FREEZE` و `PAYOUT_BROADCAST_PAUSED` دو Flag مستقل‌اند.

### ده قانون پذیرش امنیتی
```
1. هیچ عملیات مالی بدون Authentication معتبر
2. هیچ عملیات مالی بدون Authorization معتبر
3. هیچ Payout بدون Reservation
4. هیچ Payout نامشخص با Blind Retry
5. هیچ Private Key خارج از Signer
6. هیچ Balance مستقیم از Admin UI
7. هیچ Callback بدون Verification اعتبار مالی نسازد
8. هیچ Request حساس بدون Replay Protection
9. هیچ Secret در Git/Log/Frontend
10. هیچ Merchant بدون Audit، Freeze/Unfreeze نشود
```

---

## ۱۶. ادمین و RBAC (PART 25)

```
SUPER_ADMIN · FINANCE_ADMIN · OPERATIONS_ADMIN · SUPPORT_AGENT
RISK_AGENT · DEVELOPER_SUPPORT · READ_ONLY · MERCHANT
```

### مجوزها
```
merchant.read · merchant.suspend      payment.read · payment.review
ledger.read · ledger.reconcile        payout.read · payout.pause · payout.retry
treasury.read · treasury.reconcile    wallet.read · wallet.review
config.read · config.update           audit.read · security.manage
```

### عملیات ممنوع برای ادمین
```
❌ Hard Delete رکورد مالی    ❌ Balance Reset
❌ Ledger Rewrite            ❌ تغییر Payout بدون Audit
```
```
ADMIN CAN CONTROL THE SYSTEM.
ADMIN CANNOT OVERRIDE FINANCIAL TRUTH.
```
اصلاح فقط: `Adjustment Request → Approval → Journal → Projection Update`

### تأیید دو نفره
برای `large financial adjustment`، `write-off`، `critical treasury operation`:
`Creator + Approver` — قابل پیکربندی.

### سطوح Freeze
```
User Freeze · Merchant Freeze · API Freeze · Payout Freeze · Full Freeze
```
دکمهٔ اضطراری `STOP ALL PAYOUTS` — اما Ledger دست‌نخورده می‌ماند.

### Audit Log
```
id · actor_type · actor_id · merchant_id · action · entity_type · entity_id
before_state · after_state · reason · request_id · correlation_id
ip_hash · user_agent_hash · created_at
```
موارد Audit: Login، Logout، API Creation/Revocation، Wallet Change، Fee Change،
Payout Action، Treasury Action، Admin Change، Settings Change.

### Security Events
```
Repeated Login Failure · Invalid Telegram Auth · Invalid API Signature
Replay Attempt · Rapid Wallet Change · Unusual Payout Volume
Repeated Failed Payments · Admin Privilege Change · Large Manual Adjustment
```

---

## ۱۷. ربات تلگرام و Mini App

### دستورات
```
/start /menu /dashboard /panel /invoice /payments /balance /payouts
/settlement /wallet /integrations /bots /api /docs /settings /help
```

### منوی اصلی
```
📊 Dashboard   🧾 Create Invoice   📈 Analytics   💰 Balance
💎 Settlement  👛 Wallet           🤖 Bots        🔑 API
📚 Documentation   ⚙ Settings
```

### وضعیت مکالمه
```
CREATE_INVOICE → ASK_AMOUNT → ASK_TITLE → ASK_DESCRIPTION
→ PREVIEW → CONFIRM → CREATED
```
State در Redis/DB، نه RAM. TTL پیش‌نویس = ۱۰ دقیقه → `DRAFT → EXPIRED`.
`update_id` تکراری نباید دوباره پردازش شود.

### Mini App
مسیرها: `/settlement`، `/wallet`، `/integrations`، `/developer`، `/analytics`،
`/settings`، `/support`

تم: پس‌زمینه `#0B0B0F` · طلایی `#D4AF37` · طلایی تیره `#9A7B20` · فونت Vazirmatn
نویگیشن پایین: خانه / فاکتور / پرداخت / تسویه / بیشتر
Secrets فقط یک‌بار نمایش. Export: `QUEUED → PROCESSING → READY → FAILED → EXPIRED`

### اعلان‌ها
```
PAYMENT_CONFIRMED · SETTLEMENT_AVAILABLE · PAYOUT_QUEUED · PAYOUT_RESERVED
PAYOUT_SENT · PAYOUT_CONFIRMED · PAYOUT_FAILED · PAYOUT_UNKNOWN
WAITING_LIQUIDITY · WALLET_INVALID · SECURITY_ALERT
```
**شکست Notification نباید Payment را Fail یا Payout را Rollback کند.**
Bot نباید خودش وضعیت مالی را محاسبه کند.

### API پورتال v0.3 (چت ۱، ch300)
```
POST /api/telegram/auth          GET /api/telegram/me
GET  /api/telegram/dashboard     GET /api/telegram/analytics
GET/POST /api/telegram/wallets   GET/PATCH /api/telegram/settings
POST /api/telegram/invoices      POST /webhooks/telegram
```
هدر وب‌هوک: `x-telegram-bot-api-secret-token`
Wallet: `asset='GRAM'`، `network='TON_MAINNET'`، `PENDING`، `activation_available_at=now()+24h`
`treasury = SUM(±gram_nano)` · `spendable = treasury − TON_SAFETY_RESERVE_NANO`

---

## ۱۸. پیکربندی (PART 56 / PART 103 / PART 117)

```env
NODE_ENV=            APP_NAME=       APP_ENV=       APP_URL=      API_URL=
DATABASE_URL=        REDIS_URL=
TELEGRAM_BOT_TOKEN=  TELEGRAM_WEBAPP_URL=
CUBEPAY_BASE_URL=    CUBEPAY_API_KEY=   CUBEPAY_WEBHOOK_SECRET=
TON_NETWORK=TON_MAINNET
GRAM_ASSET=GRAM      GRAM_NETWORK=TON_MAINNET      GRAM_DECIMALS=9
TREASURY_ADDRESS=    PAYOUT_WALLET_ADDRESS=
AUTO_FUNDING=false   AUTO_BUY=false   AUTO_SWAP=false
AUTO_EXCHANGE=false  AUTO_BRIDGE=false
PLATFORM_FEE_PERCENT=15
PAYOUT_HOLD_HOURS=48
```

### ثوابت Production
```
GRAM_ASSET = GRAM
GRAM_NETWORK = TON_MAINNET
AUTO_* = false
```

### چرخهٔ Config
```
CONFIGURATION → VALIDATION → VERSION → AUDIT → ACTIVATION → MONITORING → ROLLBACK
```
اولویت منبع: `Secret Manager → Secure Environment → Versioned Config → Safe Defaults`
برای Config مالی، **Default ناامن ممنوع**. مقدار غایب نباید به مقدار خطرناک تبدیل شود.

### Feature Flags
```
ENABLE_PAYOUT · ENABLE_EXTERNAL_BOTS · ENABLE_SANDBOX
ENABLE_ADMIN_DUAL_APPROVAL · ENABLE_RISK_ENGINE · ENABLE_NEW_CHECKOUT
AUTO_PAYOUT · NEW_PAYOUT_ENGINE · NEW_RATE_ENGINE · EMERGENCY_MODE
```
Kill Switch بدون Deploy: `Payouts OFF`، `Payments OFF`، `External API OFF`، `Integrations OFF`

### چرخش Secret
```
CREATE NEW → VALIDATE → SWITCH → REVOKE OLD
```
Rotation ثبت می‌شود ولی **مقدار Secret هرگز در Audit قرار نمی‌گیرد**.

### ترتیب راه‌اندازی
```
PostgreSQL → Redis → Migration → API → Worker → Scheduler → Bot → Admin → Mini App
```

### کارمزد Provider
```
Provider Fee نباید عدد ثابت در کد باشد.
منبع: provider API | provider dashboard | contract/configuration
```

---

## ۱۹. تست

### Golden Path
```
CREATE INVOICE → VERIFY PAYMENT → POST LEDGER → WAIT 48H → RELEASE → PAYOUT
```
اگر این تست سالم نباشد، ساخت UI نباید جلو برود.

### Golden End-to-End کامل
```
Merchant → Invoice → Customer Payment → Provider Callback → Verification
→ Ledger → 48h → Available → Payout → Rate Lock → Liquidity
→ GRAM Broadcast → Chain Confirmation → Settled → Notification → Audit
```

### Golden Failure
```
Provider Failure    → No Double Posting
RPC Timeout         → UNKNOWN → Reconciliation
Liquidity Shortage  → WAITING_LIQUIDITY
Invalid Wallet      → WAITING_WALLET / BLOCK
Duplicate Callback  → No Duplicate Effect
```

### Golden Treasury
```
Treasury Shortage → WAITING_LIQUIDITY → Operator Manually Funds GRAM
→ Incoming Transaction Detected → Reconciled → Queue Reactivated
```
**هیچ خرید/Swap خودکار در این مسیر نباید باشد.**

### Golden Recovery — Crash در تمام نقاط
```
Before Commit · After Commit · Before Outbox · After Outbox
Before Reservation · After Reservation · After Broadcast
Before Confirmation · After Confirmation
```

### اولین تست‌ها
```
Money arithmetic · Fee calculation · Ledger balancing · Payment idempotency
48h eligibility · Liquidity reservation · Payout state machine
Wallet validation · Signature verification · Treasury manual-only guard
```

### Double Spend Test
```
Request A = 100 · Request B = 100 · Available = 100
→ حداکثر یکی باید موفق شود
```

### Treasury Race Test
`incoming treasury detection` + `payout reservation` همزمان →
**Spendable Balance نباید منفی شود.**

### Security Testing
```
SQLi · XSS · CSRF · SSRF · IDOR · Brute Force · Replay
Oversized Request · Malformed JSON · HTTP Smuggling
Path Traversal · Open Redirect
```

### دروازهٔ کیفیت
`lint → typecheck → unit → integration → contract` همه باید Pass شوند.

---

## ۲۰. سناریوهای کسب‌وکار (PART 124)

قالب هر سناریو:
```
TRIGGER → PRECONDITIONS → SYSTEM DECISION → STATE CHANGE → FINANCIAL EFFECT
→ EXTERNAL EFFECT → NOTIFICATION → AUDIT → RECOVERY IF NEEDED
```

| # | سناریو | نتیجهٔ مورد انتظار |
|---|---|---|
| 01 | ثبت Merchant | `PENDING/REVIEW` — بدون Payout واقعی |
| 03 | Wallet نامعتبر | بدون فعال‌سازی، بدون Payout |
| 06 | مبلغ صفر | REJECT |
| 07 | مبلغ منفی | REJECT |
| 08 | Invoice تکراری (همان Idempotency Key) | یک Invoice، همان نتیجه |
| 10 | `expires_at < now` | EXPIRED |
| 12 | Callback جعلی | Reject + Security Event |
| 13 | Amount کمتر (1000 انتظار / 800 دریافت) | MISMATCH |
| 14 | Overpayment (1000 / 1200) | REVIEW — اعتبار خودکار ممنوع |
| 15 | Callback تکراری ×۳ | فقط یک اثر مالی |
| 17 | Callback خارج از ترتیب | Event قدیمی State جدید را برنگرداند |
| 18 | Provider Down | WAITING_PROVIDER / RETRYABLE |
| 20 | DB Down بعد از Commit | Idempotency → نتیجهٔ موجود |
| 23 | `T + 47:59` | PENDING |
| 24 | `T + 48h` | ELIGIBLE |
| 25 | ۴۸ ساعت + Risk Hold | REVIEW/HOLD |
| 29 | Release Worker دوبار | فقط یکی Transition بگیرد |
| 31 | Liability=1000، Treasury=0 | Liability می‌ماند، Payout = WAITING_LIQUIDITY |
| 33 | نرخ در دسترس نیست | WAITING_RATE |
| 35 | نرخ بعداً تغییر کند | همان `R1` قفل‌شده استفاده شود |
| 36 | Wallet حین Payout نامعتبر شود | WAITING_WALLET / REVIEW |
| 39 | Required=100، Spendable=90 | WAITING_LIQUIDITY |
| 40 | A=90، B=100، Spendable=90 | A انتخاب، B منتظر |
| 41 | درخواست Partial Payout (70 از 100) | REJECT |
| 43 | Funding تکراری | یک Treasury Event |
| 44 | Funding به آدرس اشتباه | به Spendable اضافه نشود |
| 45 | Asset اشتباه (غیر GRAM) | به‌عنوان GRAM حساب نشود |

### الگوریتم Liquidity Fit
Worker نباید فقط اولین Payout را بگیرد؛ باید ترکیبی بیابد که کامل جا شود:
```
Spendable = 1000 · A=900 · B=600 · C=400  →  انتخاب B+C = 1000
```
اما **Anti-Starvation** باید مانع عقب‌افتادن دائمی A شود. قابل پیکربندی.

### طبقات سناریو
```
HAPPY · VALIDATION_FAILURE · FINANCIAL_FAILURE · EXTERNAL_FAILURE
SECURITY_FAILURE · CONCURRENCY · RECOVERY · OPERATIONAL
ADMIN · SUPPORT · DISASTER
```

### قواعد پذیرش PART 124
```
no verified evidence → no credit
no eligibility       → no release
no full liquidity    → no payout
no chain confirmation→ no SETTLED
no liquidity         → WAIT (never BUY)
UNKNOWN              → RECONCILE (never blind retry)
UI                   ≠ truth
balance              ≠ editable
```

---

## ۲۱. قوانین طلایی

```
NO TRUST → VERIFY → AUTHORIZE → EXECUTE → AUDIT

AUTHENTICATION ≠ AUTHORIZATION
FRONTEND       ≠ SOURCE OF TRUTH
CALLBACK       ≠ PAYMENT PROOF
UNKNOWN        ≠ FAILED
RETRY          ≠ BLIND RETRY
ADMIN ACCESS   ≠ UNLIMITED POWER
ANALYTICS      ≠ LEDGER
Scheduler = WHEN · Worker = HOW · Domain = WHAT

LEDGER      → FINANCIAL TRUTH
PRIVATE KEY → SIGNER/KMS/HSM ONLY
```

### اصل شکست نهایی
هیچ خطایی نباید باعث شود سیستم:
```
پول را گم کند
یک Payment را دوبار Credit کند
یک Payout را دوبار ارسال کند
بدون موجودی GRAM پرداخت انجام دهد
بدون تأیید Blockchain وضعیت SETTLED بدهد
برای تأمین نقدینگی خودکار خرید/Swap/Funding کند
```

### معیار Recovery
سیستم باید بتواند از روی
`Database + Ledger + Provider State + TON Blockchain + Audit Logs + Event Logs`
وضعیت واقعی را دوباره تعیین کند.

### ترتیب Recovery
```
1. Database  2. Ledger  3. Outbox  4. Queue
5. Provider Reconciliation  6. Blockchain Reconciliation
7. Resume Workers  8. Resume Traffic
```
بعد از Restore: **فوراً Broadcast نکن.**

### قانون نهایی برای AI کدنویس
```
DO NOT BUILD ONLY THE HAPPY PATH.
BUILD: HAPPY + FAILURE + RECOVERY + SUPPORT + OPERATIONS + AUDIT

A FEATURE IS NOT COMPLETE UNTIL OPERATIONS CAN
MONITOR, SUPPORT, RECOVER AND RECONCILE IT.

اگر Requirement مشخص نیست: DO NOT INVENT A FINANCIAL RULE
```

---

## ۲۲. وضعیت پیاده‌سازی فعلی

شاخه `arena/01a0b327-goldpay` · `tsc --noEmit` تمیز · **۱۱ فایل / ۲۵۰ تست سبز**
· ۷ مهاجرت اعمال‌شده

### بسته‌ها
| مسیر | محتوا |
|---|---|
| `packages/money/src/index.ts` | `Money` (فیلد **`.atomic`**، TOMAN 0dp / GRAM 9dp)، `Percentage` (**`fromPercent(number)`**)، `Rate` (10^18)، `divRound`، `sumMoney` |
| `packages/errors/src/index.ts` | `AppError` + زیرکلاس‌ها؛ VALIDATION 400 · AUTH 401 · SECURITY 403 · NOT_FOUND 404 · CONFLICT 409 · FINANCIAL 422 |
| `packages/core/src/` | `fees.ts` · `states.ts` · `outbox.ts` · `idempotency.ts` · `logger.ts` · `container.ts` · `webhooks.ts` (SSRF guard) |
| `packages/core/src/use-cases/` | `create-invoice.ts` · `finalize-payment.ts` (SERIALIZABLE ×3) · `release-payment.ts` · `payout.ts` |
| `packages/core/src/admin/` | `rbac.ts` (۱۷ مجوز، ۷ نقش، `FOUR_EYES_OPERATIONS`) · `operations.ts` |
| `packages/crypto/src/index.ts` | `safeEqual` · `hmacSha256Hex` · `signRequest(secret,{...})` · `verifyTelegramInitData` · `generateApiKey()` · **`parseApiToken` (throws)** |
| `packages/database/src/client.ts` | **async** `createDatabase({url})` — `pglite:<dir>` \| `pglite:memory` \| `pg`؛ retry 40001/40P01؛ 23514→`NEGATIVE_BALANCE` |
| `packages/ledger/` | `accounts.ts` (۸ حساب سیستمی) · `ledger-service.ts` (`post()` تنها مسیر) |
| `packages/ton/src/adapter.ts` | آداپتور TON — انتقال **بومی** GRAM + گاردهای asset/network |
| `packages/core/src/limits.ts` | سقف‌های عددی `MAX_TOMAN_ATOMIC` / `MAX_GRAM_ATOMIC` |
| `packages/config/src/index.ts` | `loadConfig` · `assertTreasuryManualOnly` · `validateProductionInvariants` |

### مهاجرت‌ها
```
001_schemas_and_core.sql        core.{users,merchants,merchant_users,wallets,
                                invoices,payments,api_keys,webhook_endpoints,
                                bot_conversations}
002_finance_ledger.sql          finance.{ledger_accounts,journals,journal_entries,
                                balances,treasury_accounts,treasury_transactions,
                                payouts,payout_items,liquidity_reservations,rate_quotes}
003_integration_audit_system.sql integration.* · audit.* · system.*
004_admin.sql                   core.admin_users · core.admin_approvals
                                system.platform_state · core.admin_sessions
005_payout_signed_state.sql     signed_at + signing_reference؛ حالت SIGNED
006_provider_fee_reconciliation.sql  provider_fee_{expected,actual,
                                diff,status,source}
007_refunds.sql                 core.refunds + trigger سقف بازپرداخت
```

### اپ‌ها
`apps/api` (http.ts · auth.ts · routes.ts · admin-routes.ts · main.ts) ·
`apps/mini-app` (استاتیک + پروکسی، پورت 3002 → 3000) ·
`apps/worker` · `apps/scheduler` · `apps/bot`

### تست‌ها
`tests/helpers/harness.ts` · `e2e/golden-path.test.ts` ·
`unit/{money-and-fees,security,hardening}` ·
`integration/{ledger-integrity,api,bot,worker,mini-app,admin}`

---

## ۲۳. شکاف‌های شناسایی‌شده

### ✅ ۱. GRAM به‌صورت Jetton پیاده شده بود — **رفع شد**
| فایل | تغییر |
|---|---|
| `packages/ton/src/adapter.ts` | انتقال بومی (`value` + `PAY_GAS_SEPARATELY` + `bounce:false`) به‌جای jetton |
| `packages/ton/src/adapter.ts` | `/api/v3/accountStates` به‌جای `/api/v3/jetton/wallets` |
| `packages/config/src/index.ts` | `gramJettonMaster` حذف → `gramAsset` (`GRAM_ASSET`) |
| `packages/config/src/index.ts` | ثوابت Production: `GRAM_ASSET==='GRAM'` و `GRAM_DECIMALS===9` |
| `tests/helpers/harness.ts` | `GRAM_ASSET: 'GRAM'` |
| `README.md` | «native GRAM transfer on TON» |

مستند: `docs/architecture/adr/ADR-006-native-gram-on-ton.md`

### ✅ ۲. کارمزد ۹٪ CubePay — **رفع شد**
- `calculateProviderCost()` در `packages/core/src/fees.ts` (گرد کردن **CEIL**)
- `FeeConfig.providerFeePercent` از `PROVIDER_FEE_PERCENT` (پیش‌فرض ۹)
- در `finalize-payment.ts` دو خط دفتر اضافه شد:
  `DR PLATFORM_EXPENSE_TOMAN` / `CR PROVIDER_CLEARING_TOMAN`
- بدهی فروشنده دست‌نخورده می‌ماند — Snapshot فاکتور آن را قفل کرده است.

مستند: `docs/architecture/adr/ADR-005-provider-adapter.md`

### ✅ ۳. مرحلهٔ `SIGNED` — **رفع شد**
- مهاجرت `db/migrations/005_payout_signed_state.sql`:
  ستون‌های `signed_at` + `signing_reference`، گسترش `ck_payouts_status`،
  قید جدید `ck_payouts_signed_evidence`، ایندکس `ix_payouts_signed`،
  و افزودن `SIGNED` به `ux_payouts_merchant_in_flight`
- `signPayout()` در `payout.ts` — idempotent، با تمام گاردهای PART 90.10
- `broadcastPayout()` فقط `SIGNED` را می‌پذیرد
- `PAYOUT_IN_FLIGHT` شامل `SIGNED` شد
- Worker مرحلهٔ جدید را اجرا می‌کند

مستند: `docs/architecture/adr/ADR-007-signed-state.md`

### ✅ ۴. سه گارد Broadcast — **رفع شد**
| گارد | محل | خطا |
|---|---|---|
| Asset/Network | `ton/src/adapter.ts::send` | `INVALID_SETTLEMENT_ASSET` / `NETWORK_MISMATCH` |
| Destination | `payout.ts::broadcastPayout` | `DESTINATION_MISMATCH` |
| Amount | `payout.ts::broadcastPayout` | `PAYOUT_AMOUNT_MISMATCH` |

همچنین در `signPayout()` پیش از امضا نیز بررسی می‌شوند.

### ✅ ۵. پوشهٔ `docs/` — **نوشته شد**
```
docs/README.md
docs/architecture/overview.md
docs/architecture/adr/ADR-001 … ADR-007
docs/api/README.md
docs/operations/treasury.md
docs/security/README.md
docs/recovery/README.md
```

### ✅ ۶. سرریز عددی — **رفع شد**
`packages/core/src/limits.ts` — یک منبع واحد:
- `MAX_TOMAN_ATOMIC = 10^28` (ستون `NUMERIC(30,0)`)
- `MAX_GRAM_ATOMIC = 10^38` (ستون `NUMERIC(40,0)`)
- `assertTomanWithinBounds()` / `assertGramWithinBounds()`

اعمال‌شده در: `create-invoice.ts`، `payout.ts` (مبلغ payout + تبدیل نرخ +
`recordManualTreasuryFunding`)، `admin/operations.ts` (درخواست funding).

### ✅ ۷. صف، امضاکننده و نرخ — **رفع شد**

| مورد | وضعیت |
|---|---|
| **QueuePort + BullMQ** | `packages/core/src/ports/queue.ts` + `packages/queue/src/{bullmq,in-memory}-queue.ts`. ۹ صف مشخصات. Redis باید `noeviction` + AOF داشته باشد. Production بدون `REDIS_URL` بالا نمی‌آید. |
| **SignerPort + KMS** | `packages/core/src/ports/signer.ts` + `packages/ton/src/signer.ts`. `KmsSigner` برای Production، `StubSigner` فقط dev (در Production throw می‌کند). Keystore محلی **معماری Production نیست**. |
| **RateAggregator** | `GRAM/USD × USD/TOMAN` با failover، freshness، sanity bounds و سقف انحراف. Production نرخ ثابت را رد می‌کند. |
| **Provider fee** | expected از config + actual از provider + flag اختلاف (مهاجرت ۰۰۶). |

### ✅ ۸. تکمیل درگاه — **انجام شد**

| مورد | جزئیات |
|---|---|
| **صفحهٔ Checkout** | `/checkout/{id}` — برند فروشنده، مبلغ، کارمزد، جمع کل. بدون احراز هویت، بدون اسکریپت، `frame-ancestors 'none'`، escape کامل HTML. |
| **پنل ادمین** | React 18 + esbuild، ۷ صفحه، `apps/admin/`. پورت ۳۰۰۳. اعتبارنامه در sessionStorage. |
| **Refund** | مهاجرت ۰۰۷ + `use-cases/refund.ts`. مدل و ماشین حالت کامل؛ **اجرای مالی پشت `REFUND_POLICY_DEFINED` قفل است**. |
| **Rate limiting** | Token bucket، کلید بر اساس credential نه IP. `packages/core/src/rate-limit.ts`. |
| **اعلان تلگرام** | `notifications.ts` — شکست اعلان هرگز پول را برنمی‌گرداند (تست دارد). |
| **API کامل** | `GET /v1/payments`، لغو فاکتور، مدیریت API key، `GET /v1/statements`. |
| **Mini App** | تب «بیشتر»: پرداخت‌ها، صورت‌حساب، کلیدها، تنظیمات. |

### 🔴 ۹. تنها موضوع باز: سیاست Refund

مدل کامل است ولی **اجرا عمداً غیرفعال**. دلیل: نه مشخصات و نه مستندات CubePay
نگفته‌اند کارمزد ۱۵٪ هنگام برگشت چه می‌شود. ستون‌های
`platform_fee_reversal` و `provider_fee_reversal` آمادهٔ پر شدن‌اند.
وقتی قرارداد CubePay مشخص شد، فقط همان سیاست نوشته می‌شود — دفتر کل و هستهٔ
پرداخت تغییر نمی‌کنند.

### 🟢 ۱۰. باقی‌مانده
Risk Engine و Dispute (نیاز به تصمیم کسب‌وکاری: آستانهٔ امتیاز ریسک، مسئول هزینه).

---

## ۲۴. دام‌های فنی محیط

- **PGlite تک‌فرآیندی و تک‌نویسنده است.** اسکریپت جدا روی همان دایرکتوری = نامرئی
  برای سرور در حال اجرا + **خرابی دایرکتوری** (`RuntimeError: Aborted()`).
  بازیابی: `rm -rf <dir>` + migrate + seed.
- `Percentage.fromPercent()` **عدد** می‌گیرد نه رشته. `Money.toman()` رشته می‌پذیرد.
- `parseApiToken` **throw** می‌کند (`ValidationError('MALFORMED_API_KEY')`)، `null` برنمی‌گرداند.
- ستون‌ها: `finance.ledger_accounts.account_code` (نه `code`) ·
  `finance.treasury_accounts.safety_reserve_atomic`
- `ON CONFLICT DO UPDATE SET col = col + EXCLUDED.col` برای دلتای منفی روی
  `CHECK (col >= 0)` کار نمی‌کند — ensure-row + `UPDATE` ساده.
- جمع `journal_entries` بدون فیلتر `e.account_id` صفر می‌شود.
- ESM خالص — `require()` در `.test.ts` خطا می‌دهد. اسکریپت در `/tmp` importهای نسبی را حل نمی‌کند.
- خطاهای PGlite استک چندمگابایتی دارند —
  همیشه: `2>&1 | grep -E "error:|constraint:|query:|TypeError" | head`
  و برای vitest: `grep -E "✓|×|→|Tests "`
- بدون pnpm، بدون PostgreSQL server، بدون docker — npm workspaces + PGlite.
- مسیرهای کانتینر مدل قبلی (`/mnt/data/gateway`، `gateway_v03`، `gateway_v06`) وجود ندارند.
- تست integration ~۰٫۸۵ ثانیه هرکدام؛ کل مجموعه ~۴۷ ثانیه.

---

## پیوست — نقل‌قول‌های کلیدی

> **«۱۵٪ کارمزد پلتفرم است. ۹٪ CubePay هزینه زیرساخت پرداخت است.
> این دو را در پنل فروشنده به یک کارمزد تبدیل نمی‌کنیم.»**

> **«Gram مستقیماً ارز بومی TON است؛ برای انتقال آن نیاز به قرارداد Jetton
> مثل USDT نیست.»**

> **«خزانه کاملاً دستی است. مدیر سیستم خودش GRAM وارد خزانه می‌کند.»**

> **«اگر GRAM کافی نباشد، پرداخت حذف نمی‌شود. وضعیت WAITING_LIQUIDITY می‌شود.»**

> **«Admin نمی‌تواند مستقیماً Balance را ویرایش کند. اصلاحات نیاز به Ledger Adjustment دارند.»**

> **«تنظیمات کارمزد در لحظه ساخت Invoice ذخیره می‌شود. اگر فردا کارمزد تغییر کرد،
> Invoice قدیمی تغییر نمی‌کند.»**

---

*این فایل باید با هر یافتهٔ جدید از مشخصات به‌روزرسانی شود.*
*آخرین به‌روزرسانی: پس از خواندن کامل هفت چت تا PART 125 / آیتم 104185.*
