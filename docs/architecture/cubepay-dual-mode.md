# CubePay Dual-Mode Architecture & Integration Guide

This document describes the dual-mode integration for **CubePay** in the GOLDPAY platform: **CubePay VIP (Managed Settlement)** and **CubePay Standard (Card-to-Card Flow)**, strictly adhering to the official [cubepy/cubepay-doc](https://github.com/cubepy/cubepay-doc) specifications.

---

## ۱. مرور کلی معماری دوگانه (Dual-Mode Architecture)

سیستم GOLDPAY از دو حالت پرداخت مستقل CubePay پشتیبانی می‌کند که پشت پورت یکپارچه `CubePayProviderPort` و مسیریاب متمرکز `CubePayProviderResolver` قرار دارند:

1. **CubePay VIP (Managed Settlement) — پیش‌فرض Production**:
   - حالت پیش‌فرض عملیاتی (`CUBEPAY_ACTIVE_MODE=VIP`).
   - تسویه‌حساب مدیریت‌شده، ارز محاسباتی مستقیماً **تومان**، تأیید امنیتی بر پایه امضای HMAC-SHA256.
2. **CubePay Standard (Card-to-Card Flow) — حالت اختیاری / پشتیبان**:
   - برای جابه‌جایی دستی یا شرایط خاص (`CUBEPAY_ACTIVE_MODE=STANDARD`).
   - جریان کارت‌به‌کارت با فورواردر پیامک، ارز مبادلاتی در لایه شبکه **ریال** (`Toman × 10`)، رهگیری بر پایه Authority.

```
                  ┌───────────────────────────────┐
                  │      CubePayProviderResolver   │
                  │   (Active Mode / Snapshot)    │
                  └──────────────┬────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
    ┌─────────────────────────┐     ┌─────────────────────────┐
    │    CubePayVipAdapter    │     │ CubePayStandardAdapter  │
    │  (Managed Settlement)   │     │  (Card-to-Card Flow)    │
    └─────────────────────────┘     └─────────────────────────┘
```

---

## ۲. منطق پرداخت CubePay Standard (Card-to-Card Flow)

### ۲.۱. ایجاد Invoice

وقتی Mode فعال سیستم روی:
```text
CUBEPAY_ACTIVE_MODE=STANDARD
```
باشد، هنگام ساخت Invoice:
```text
Invoice
 ├── provider = CUBEPAY
 ├── provider_mode = STANDARD
 ├── base_amount_toman = مبلغ پایه
 ├── platform_fee_toman = کارمزد پلتفرم (۱۴٪)
 ├── customer_charge_toman = مبلغ مطالبه از مشتری
 ├── provider_order_id = شناسه پایدار سفارش
 └── provider_version = 2026-09-STANDARD
```
ثبت می‌شود.

این **Snapshot** در جدول `core.invoices` کاملاً تغییرناپذیر (Immutable) است.

حتی اگر بعداً مدیر سیستم، Mode فعال پلتفرم را دوباره روی `VIP` قرار دهد:
```text
Invoice قدیمی:
STANDARD

پردازش و اعتبارسنجی:
CubePayStandardAdapter
```
انجام می‌شود و هیچ تداخلی رخ نمی‌دهد.

---

### ۲.۲. تبدیل مبلغ اولیه و دریافت Offset شناسه بانکی از CubePay Standard

CubePay Standard مبلغ درخواستی اولیه را به **ریال** دریافت می‌کند:
```text
amount_rial = customer_charge_toman × 10
```

اما نکته بسیار حیاتی: **CubePay Standard ممکن است برای تشخیص دقیق واریز بانکی در کارت‌به‌کارت، چند تومان به مبلغ اضافه کند (Identification Offset)** و مقدار نهایی قابل‌پرداخت را در فیلدهای `pay_amount` (ریال) و `pay_amount_toman` (تومان) برگرداند.

**مثال**:
```text
Base Invoice = 20,000 تومان
Customer Charge = 20,000 تومان

ارسال اولیه به create-payment.php:
200,000 ریال

پاسخ دریافتی از CubePay:
pay_amount = 200,720 ریال
pay_amount_toman = 20,072 تومان
```

از این لحظه، مقدار دقیق **۲۰٬۰۷۲ تومان** به عنوان Snapshot اختصاصی مبلغ پرووایدر در فاکتور ذخیره می‌شود:
```text
provider_pay_amount_rial = 200720
provider_pay_amount_toman = 20072
```

> **قانون محاسباتی**: هیچ عدد ممیز شناور (Float/Double) استفاده نمی‌شود. تمام محاسبات در پکیج `@goldpay/money` با استفاده از `bigint` و اعداد صحیح انجام می‌شود.

---

### ۲.۳. ساخت Payment Request و تنظیمات تلگرام (Telegram Mode)

جریان ایجاد پرداخت:
```
Merchant
   │
   ▼
GOLDPAY API (/v1/invoices)
   │
   ▼
CubePayStandardAdapter
   │
   ▼
CubePay Standard Gateway (/api/create-payment.php)
```

درخواست HTTP POST به اندپوینت `/api/create-payment.php` ارسال می‌شود:

**پارامترهای اصلی**:
```json
{
  "amount": 200000,
  "order_id": "INV-12345678",
  "callback_url": "https://gateway.goldpay.ir/v1/webhooks/cubepay",
  "redirect_after_payment": false,
  "ttl_minutes": 30,
  "description": "Payment for Order #1234"
}
```

- برای ربات‌ها و مینی‌اپ‌های تلگرام، `redirect_after_payment = false` تنظیم می‌شود تا مرورگر کاربر پس از پرداخت ریدایرکت نشود، اما وب‌هوک سرور‌به‌سرور با قطعیت ارسال گردد.

پاسخ CubePay Standard:
```json
{
  "success": true,
  "authority": "std_a1b2c3d4e5f67890",
  "payment_link": "https://cubevps.ir/smspay/pay.php?authority=std_a1b2c3d4e5f67890",
  "pay_amount": 200720,
  "pay_amount_toman": 20072,
  "expires_in_minutes": 30
}
```

در دیتابیس GOLDPAY:
```text
invoice.provider_invoice_id = authority
invoice.provider_payment_url = payment_link
invoice.provider_order_id = order_id
invoice.provider_pay_amount_rial = pay_amount
invoice.provider_pay_amount_toman = pay_amount_toman
invoice.provider_ttl_minutes = 30
invoice.redirect_after_payment = false
```
ذخیره می‌گردد.

---

### ۲.۴. تکرار درخواست و پایداری شناسه (Idempotency)

- مقدار `provider_order_id` به صورت پایدار به شناسه فاکتور GOLDPAY اختصاص می‌یابد.
- در صورت Retry شدن درخواست ساخت پرداخت با همان `order_id`، پرووایدر CubePay Standard همان Authority و لینک پرداخت قبلی را برمی‌گرداند و فاکتور تکراری ایجاد نمی‌شود.

---

### ۲.۵. دریافت Callback و تعیین هندلر مناسب (Routing)

در Callback ورودی به `/v1/webhooks/cubepay`:
1. ابتدا شناسه سفارش (`order_id` یا `authority`) از بدنه درخواست یا پارامترهای کوئری خوانده می‌شود.
2. فاکتور مربوطه از جدول `core.invoices` جستجو شده و مقدار `provider_mode` آن استخراج می‌گردد.
3. اگر `provider_mode = STANDARD` باشد، روتر به‌صورت خودکار پردازش را به `CubePayStandardAdapter` محول می‌کند.
4. **وب‌هوک صرفاً جنبه اطلاع‌رسانی دارد (Notification Only)** و به تنهایی هرگز لجر را کریدیت نمی‌کند.

---

### ۲.۶. تأیید پرداخت (Verify Payment)

در `CubePayStandardAdapter`:
درخواست POST به اندپوینت `/api/verify-payment.php` ارسال می‌گردد:
```json
{
  "authority": "std_a1b2c3d4e5f67890"
}
```

پاسخ اعتبارسنجی:
```json
{
  "success": true,
  "status": "verified",
  "amount": 200720,
  "paid_at": "2026-09-20T14:00:00Z"
}
```

وضعیت نرمال‌سازی می‌شود:
- موفق: `PAID` (معادل `verified` در پاسخ پرووایدر).
- ناموفق / منقضی: `FAILED`.

---

### ۲.۷. تدابیر امنیتی و تطابق دقیق مبلغ (Amount Verification against Snapshot)

1. **تطابق با اسنپ‌شات پرووایدر**:
   مبلغ تأییدشده مستقیماً با `provider_pay_amount_toman` (و `provider_pay_amount_rial`) مقایسه می‌شود:
   $$\text{verified\_amount\_toman} == \text{snapshot.provider\_pay\_amount\_toman}$$
   هرگز تنها با فرمول خام $\text{invoice\_amount\_toman} \times 10$ اعتبارسنجی صورت نمی‌گیرد تا از خطای کاذب `AMOUNT_MISMATCH` در پرداخت‌های دارای Offset جلوگیری شود.
2. **جلوگیری از پرداخت تکراری (Idempotency)**:
   - رویدادهای وب‌هوک بر اساس کلید یکتای پرووایدر در جدول `integration.webhook_events` ثبت می‌شوند.
   - در صورت بررسی مجدد فاکتوری که فیلد `verified_paid_at` آن مقدار دارد، هیچ تراکنش مالی جدیدی در لجر ثبت نمی‌گردد (`IDEMPOTENT_REPLAY`).

---

### ۲.۸. ثبت در دفترکل دوبل (Double-Entry Ledger)

پس از تأیید موفق (`PAID`):
یک سند حسابداری متوازن در دیتابیس درج می‌شود:
```text
بدهکار (DR): حساب واسط پرووایدر (CubePay Clearing Account)
بستانکار (CR): موجودی در انتظار تسویه فروشنده (Merchant Pending Balance)
بستانکار (CR): درآمد کارمزد پلتفرم (Platform Revenue Toman - 14%)
```

تایم‌استمپ‌ها:
```text
verified_paid_at = NOW()
release_at = NOW() + 48 Hours
```

---

### ۲.۹. تفکیک دقیق مدل کارمزدها (Fee Separation)

تمام اجزای مالی به صورت کاملاً مجزا ذخیره و محاسبه می‌شوند:
- `base_amount_toman`: مبلغ پایه محصول فروشنده
- `platform_fee_toman`: کارمزد ثابت ۱۴٪ پلتفرم GOLDPAY (`PLATFORM_FEE_PERCENT = 14`)
- `customer_charge_toman`: مبلغ نهایی مطالبه از خریدار بر اساس Fee Mode
- `provider_pay_amount_toman`: مبلغ نهایی پرووایدر با احتساب آفست بانکی (هرگز به عنوان درآمد فروشنده لحاظ نمی‌شود)
- `provider_pay_amount_rial`: معادل ریالی پرووایدر
- `expected_provider_fee_toman`: کارمزد تخمینی پرووایدر (۹٪)
- `actual_provider_fee_toman`: کارمزد قطعی پرووایدر (تنها در صورت ارائه سند رسمی پرووایدر)
- `instant_withdrawal_fee`: کارمزد برداشت فوری ۲٪ (`INSTANT_WITHDRAWAL_FEE = 2%`)
- `automatic_settlement_fee`: کارمزد تسویه خودکار ۴۸ ساعته: ۰٪

---

## ۳. جدول مقایسه جامع CubePay VIP در برابر CubePay Standard

| ویژگی / مشخصه | CubePay VIP (Managed Settlement) | CubePay Standard (Card-to-Card) |
|---|---|---|
| **نوع جریان (Flow)** | تسویه‌حساب مدیریت‌شده و خودکار | کارت‌به‌کارت با فورواردر پیامک بانکی |
| **اندپوینت ایجاد سفارش** | `POST /api/create-order.php` | `POST /api/create-payment.php` |
| **اندپوینت استعلام / تأیید** | `GET /api/check-order-status.php` | `POST /api/verify-payment.php` |
| **واحد پولی در لایه API** | **تومان (Toman)** | **ریال (Rials = Toman × 10)** |
| **شناسه پیگیری اصلی** | `order_id` / `invoice_uid` | `authority` |
| **آفست شناسه بانکی** | ندارد | دارد (`pay_amount` / `pay_amount_toman`) |
| **اسنپ‌شات مبلغ پرووایدر** | `customer_total_amount` | `provider_pay_amount_toman` / `rial` |
| **مکانیزم امنیت وب‌هوک** | امضای HMAC-SHA256 روی `order_id\|paid\|amount` | استعلام مستقیم Authority از اندپوینت Verify |
| **فرمت توکن امنیتی** | `vip_...` (Production) / `vipsb_...` (Sandbox) | توکن استاندارد پذیرنده |
| **کلاس Adapter** | `CubePayVipAdapter` | `CubePayStandardAdapter` |
| **مدل ثبت در دیتابیس** | اسنپ‌شات قطعی `provider_mode = 'VIP'` | اسنپ‌شات قطعی `provider_mode = 'STANDARD'` |
| **امکان تغییر مود فاکتور ایجادشده** | **خیر (Immutable)** | **خیر (Immutable)** |

---

## ۴. قوانین نهایی مسیریابی و سوئیچ حالت در GOLDPAY

```text
Active Mode (پیش‌فرض سیستم):
      VIP (Default Production)

Optional Mode (حالت اختیاری):
      STANDARD (Card-to-Card)

New Invoice Routing (فاکتورهای جدید):
      فقط و فقط براساس Mode فعال جاری

Existing Invoices (فاکتورهای در حال پردازش):
      همیشه براساس Mode ثبت‌شده در زمان ایجاد (Snapshot)
```
