# GOLDPAY v3.3.0 Operational Governance Report
**Evaluation Date:** 2026-09-21  
**Operating Framework:** Post-Launch Operations & Reliability Governance  
**Baseline Version:** GOLDPAY v3.3.0 (Architecture Frozen 🔒)  
**Status:** **`PRODUCTION OPERATIONS ACTIVE`** 🟢

---

## ۱. ارزیابی سلامت و پایداری سیستم (System Health & Availability)

| بخش عملیاتی | زیرسیستم / مؤلفه | وضعیت جاری | مکانیزم پایش |
| :--- | :--- | :---: | :--- |
| **سرویس‌های هسته** | Core Payment API / Auth | `HEALTHY` | بررسی مداوم با `health-check.ts` و پروب‌های کانتینر |
| **پردازش صفوف** | BullMQ Workers (Settlement & Webhook) | `HEALTHY` | رصد تاخیر صف و متریک‌های Redis 7 (`noeviction`) |
| **زمان‌بند دوره‌ای** | Scheduler Daemon (Integrity & Expiry) | `HEALTHY` | اجرای دوره‌ای جاروب یکپارچگی دفاتر و انقضای فاکتورها |
| **دسترسی ادمین** | SSR Admin Panel / RBAC | `HEALTHY` | کوکی‌های امن HttpOnly و تفکیک نقش‌های دسترسی |
| **رابط کاربری مرچنت** | Telegram Mini App & Bot SDK | `HEALTHY` | نشست‌های احراز هویت شده با HMAC WebApp InitData |

---

## ۲. یکپارچگی مالی و دفاتر کل (Financial Integrity & Ledger)

1. **برابری صفر-مجموع (Zero-Sum Balance):**  
   مجموع بدهکارها با بستانکارها در تمام ردیف‌های دفاتر کل کاملاً برابر است (`Debits == Credits`).
2. **غیرقابل‌تغییر بودن رکوردهای مالی (Ledger Immutability):**  
   سلب دسترسی `UPDATE` و `DELETE` از کاربر اپلیکیشن روی جداول مالی اعمال و فعال است.
3. **توالی یکنواخت (Monotonic Sequence Integrity):**  
   شماره توالی `journal_sequence` بدون شکستگی و منطبق با ساختار بلاک‌های لجر (`finance.ledger_blocks`).
4. **تطابق تصاویر مانده‌حساب (Balance Projections):**  
   تطابق ۱۰۰٪ میان مانده‌های جدول `finance.balances` و تجمیع خطوط اسناد `finance.journal_entries`.

---

## ۳. قابلیت اطمینان و موتور پرداخت (Payment Reliability)

* **چرخه حیات PaymentIntent:** تفکیک کامل فاکتور تجاری از تلاش‌های درگاه با انجماد اسنپ‌شات در لایه دیتابیس.
* **آداپتورهای CubePay (VIP / Standard):** محاسبات دقیق با `BigInt` بدون ممیز شناور، اعتبارسنجی تک‌ریالی و ایزوله‌سازی کارمزد ۱۴٪.
* **گارد ضد-Replay وب‌هوک:** اعتبارسنجی قطعی سه لایه‌ای (`event_id` $\rightarrow$ `order_id + status` $\rightarrow$ `payload_hash`)؛ ۱ تراکنش = دقیقاً ۱ سند لجر.

---

## ۴. کنترل عملیات خزانه‌داری (Treasury Operations Control)

* **سیاست عدم خرید خودکار:** عدم وجود هرگونه خرید، سواپ یا تزریق خودکار نقدینگی (`AUTO_BUY = false`).
* **امضای سخت‌افزاری:** تفکیک کلیدها و ارسال هش تراکنش به ماژول `AWS KMS / HSM Signer` برای امضای Ed25519.
* **گیت توالی تراکنش‌ها (`TonSeqnoManager`):** ممانعت قطعی از برخورد Seqno در برودکست‌های همزمان تسویه.
* **مهار کسری موجودی:** هدایت خودکار تراکنش‌ها به وضعیت امن `WAITING_LIQUIDITY` بدون انباشت یا شکست سیستم.

---

## ۵. امنیت و انطباق (Security & Compliance Governance)

* **صفر نشت اطلاعات:** اسکن لاگ‌ها و کدها بدون هیچ‌گونه کلید خصوصی یا توکن لایو.
* **گارد محیط تولید (`assertProductionSafe`):** توقف خودکار در صورت غیبت سکرت‌های عملیاتی.
* **ثبت شواهد WORM:** لنگراندازی زنجیره شواهد در `integration.evidence_chain` سازگار با S3 Object Lock.

---

## ۶. رخدادها و خطاها (Incidents & Risk Status)

* **رخدادهای بحرانی باز (P0 / P1 Incidents):** `0` (صفر رخداد).
* **وابستگی خارجی مسدود (Known Dependency):** وضعیت `WAITING_PROVIDER_NETWORK` در ارتباط لایو با `cubevps.ir` ناشی از فایروال لبه کلودفلر پرووایدر (کد اپلیکیشن ۱۰۰٪ آماده است).

---

## ۷. ارزیابی آمادگی رشد و مقیاس (Scale Readiness Evaluation)

```
[مرحله ۱: پایلوت کنترل‌شده (۱ تا ۵ مرچنت)] ──► [فعال 🟢]
                     │
                     ▼ (پس از ۳۰ روز پایداری بدون رخداد بحرانی)
[مرحله ۲: گسترش تدریجی (۵۰ مرچنت)]      ──► [آماده‌باش ⏳]
                     │
                     ▼ (ارزیابی مجدد تراز لجر و ظرفیت خزانه)
[مرحله ۳: ثبت‌نام عمومی (Public Launch)]  ──► [آماده‌باش ⏳]
```

---

## ۸. اقدامات اجرایی مورد نیاز تیم عملیات (Required Actions)

1. **پایش پیوسته روزانه:** اجرای مستمر `npm run ledger:verify` و `npm run health-check`.
2. **پاسخ به آلارم‌های پرومتئوس:** پیگیری بلافاصله در صورت فعال شدن آلرت‌های بحرانی طبق ران‌بوک `docs/runbooks/operations-manual.md`.
3. **پیگیری لیست سفید شبکه:** نهایی‌سازی ثبت IP سرور لایو در فایروال سرور پرووایدر CubePay.

```
================================================================================
           STATUS: PRODUCTION OPERATIONS ACTIVE
           NEXT MODE: MONITOR -> REPORT -> IMPROVE -> SCALE
================================================================================
```
