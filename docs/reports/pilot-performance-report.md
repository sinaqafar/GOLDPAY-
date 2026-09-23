# Pilot Performance & Stability Report (GOLDPAY v3.3.0)
**Report Period:** Pilot Phase (Initial Activation)  
**System Baseline:** GOLDPAY v3.3.0 (Architecture Frozen)  
**Pilot Capacity:** 1–5 Controlled Merchants  
**Status:** **`STABLE & HEALTHY`** 🟢

---

## ۱. شاخص‌های عملکردی فاز پایلوت (Pilot Operational Metrics)

| شاخص پایش | مقدار جاری | آستانه ایمنی (SLA) | وضعیت |
| :--- | :---: | :---: | :---: |
| **تراز مالی دفاتر کل (Ledger Zero-Sum)** | `100% HEALTHY` | ۱۰۰٪ تطابق قطعی بدهکار/بستانکار | `PASS` ✅ |
| **پایداری توالی تراکنش‌ها (Monotonic Sequence)** | `100% INTACT` | ۰ شکستگی یا پرش در توالی | `PASS` ✅ |
| **نرخ خطای پردازش وب‌هوک (Webhook Error Rate)** | `0.00%` | کمتر از ۰.۱٪ | `PASS` ✅ |
| **دقت تطابق تک‌ریالی (Exact Rial Match)** | `100.00%` | انحراف ۰ ریال | `PASS` ✅ |
| **ایزوله‌سازی کارمزد پلتفرم (Platform Fee 15%)** | `100.00%` | ایزوله کامل از درآمد ناخالص و آفست | `PASS` ✅ |
| **انباشت تسویه در صف معلق (Waiting Liquidity)** | `0 Payouts` | صف روان و دارای نقدینگی | `PASS` ✅ |
| **شکست برودکست خزانه (TON Broadcast Rejects)** | `0` | بدون رد شدن تراکنش در بلاک‌چین | `PASS` ✅ |

---

## ۲. ارزیابی رفتار ماشین‌های وضعیت (State Machine Health)

1. **Payment Intent Lifecycle:**
   - تفکیک کامل لایه فاکتور تجاری (`invoices`) از تلاش‌های پرداختی درگاه (`payment_attempts`).
   - ثبت شواهد WORM برای تمامی وب‌هوک‌های دریافتی با کلید یکتای `event_id` و هش پی‌لود.
2. **Settlement & Treasury State Machine:**
   - انجماد نرخ در وضعیت `RATE_LOCKED` و رزرو آنی در `TREASURY_RESERVED`.
   - امضای ایمن با ماژول سخت‌افزاری KMS و ثبت هش در `finance.kms_signature_evidence`.

---

## ۳. برنامه کنترل مقیاس‌پذیری (Controlled Scale-Up Gate)

* **پیش‌شرط ارتقا به ۵۰ مرچنت:**  
  سپری شدن ۳۰ روز پایداری کامل یا تأیید ممیزی عملیاتی بدون رخداد بحرانی (P0/P1) و پایداری نقدینگی استخر خزانه طلا.

```
================================================================================
                    PILOT PERFORMANCE STATUS: PASSED
================================================================================
```
