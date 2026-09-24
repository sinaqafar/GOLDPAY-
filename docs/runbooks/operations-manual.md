# GOLDPAY Production Operations & Emergency Incident Runbook (v3.3)

---

## ۱. نقشه راه و پروتکل‌های اضطراری (Emergency Response Protocols)

این راهنما مرجع رسمی تیم کشیک (On-Call Engineer)، مدیر سیستم (DevOps / SRE) و ناظر ارشد مالی (Financial Risk Officer) برای مدیریت و رفع خطاهای احتمالی در محیط پروداکشن است.

```
                               INCIDENT TRIAGE FLOWCHART
                               
                             ┌─────────────────────────┐
                             │    Alert Triggered /    │
                             │   Anomaly Discovered    │
                             └────────────┬────────────┘
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   │                                             │
         [Financial Imbalance]                         [Operational Failure]
                   │                                             │
                   ▼                                             ▼
       ┌───────────────────────┐                     ┌───────────────────────┐
       │ Engage Auto-Freeze:   │                     │ Isolate Subsystem:    │
       │ POST /admin/platform/ │                     │ • CubePay Circuit     │
       │ freeze                │                     │ • Polling Backoff     │
       └───────────┬───────────┘                     │ • TonSeqno Recovery   │
                   │                                 └───────────┬───────────┘
                   ▼                                             │
       ┌───────────────────────┐                                 │
       │ Execute Verification: │                                 │
       │ npm run ledger:verify │                                 │
       └───────────┬───────────┘                                 │
                   │                                             │
                   └──────────────────────┬──────────────────────┘
                                          │
                                          ▼
                             ┌─────────────────────────┐
                             │ Execute Root Cause Fix  │
                             │ (See Runbooks Below)    │
                             └────────────┬────────────┘
                                          │
                                          ▼
                             ┌─────────────────────────┐
                             │ Four-Eyes SuperAdmin    │
                             │ Unfreeze & Recovery     │
                             └─────────────────────────┘
```

---

## ۲. ران‌بوک‌های رفع اشکال گام‌به‌گام (Step-by-Step Recovery Runbooks)

---

### سناریوی ۱: اگر یک پرداخت (Payment) گیر کرد

#### علائم:
* وضعیت فاکتور در حالت `CREATED` یا `PENDING_GATEWAY` باقی مانده، در حالی که وجه از حساب مشتری کسر شده است.
* وب‌هوک درگاه ارسال نشده یا به دلیل اختلال شبکه Drop شده است.

#### مراحل اقدام فوری:
1. **بررسی وضعیت در لاگ‌های ممیزی:**
   ```sql
   SELECT id, invoice_number, status, provider_order_id, provider_pay_amount_rial, created_at 
     FROM core.invoices 
    WHERE id = '<INVOICE_UUID>';
   ```
2. **استعلام مستقیم از پرووایدر (Manual Status Probe):**
   ```bash
   # اجرای پروب وضعیت مستقل از طریق کلید ادمین
   curl -X GET "https://api.goldpay.internal/v1/invoices/<INVOICE_UUID>" \
        -H "Authorization: Bearer <ADMIN_PREFIX>.<ADMIN_SECRET>"
   ```
3. **اجرای جاب نظرسنجی فوری (Force Poller Sweep):**
   ```bash
   node --experimental-strip-types -e "
     import { createContainer } from './packages/core/src/container.ts';
     import { pollPendingInvoices } from './packages/core/src/use-cases/poll-pending-invoices.ts';
     const c = await createContainer({ service: 'scheduler' });
     await pollPendingInvoices(c.db, c.config, c.providerResolver);
     process.exit(0);
   "
   ```
4. **تأیید نهایی شدن تراکنش در لجر:**
   ```sql
   SELECT p.id, p.status, p.verified_amount, j.operation_id
     FROM core.payments p
     JOIN finance.journals j ON j.reference_id = p.id
    WHERE p.invoice_id = '<INVOICE_UUID>';
   ```

---

### سناریوی ۲: اگر یک تسویه مرچنت (Payout) در وضعیت UNKNOWN یا گیر کرد

#### علائم:
* تسویه در وضعیت `UNKNOWN`، `WAITING_LIQUIDITY` یا `CONFIRMING` به مدت بیش از ۱۵ دقیقه متوقف شده است.

#### مراحل اقدام:
1. **بررسی وضعیت تسویه در دیتابیس:**
   ```sql
   SELECT id, merchant_id, status, gram_amount_atomic, transaction_hash, failure_code, updated_at
     FROM finance.payouts
    WHERE id = '<PAYOUT_UUID>';
   ```
2. **بررسی علت توقف:**
   * **اگر وضعیت `WAITING_LIQUIDITY` است:**
     - نقدینگی خرج‌پذیر خزانه (`confirmed_balance - active_reservations - safety_reserve`) کمتر از مبلغ تسویه است.
     - **اقدام:** شارژ دستی والت خزانه و ثبت تراکنش دستی در پنل ادمین (`POST /internal/admin/treasury/funding-requests`).
   * **اگر وضعیت `UNKNOWN` است (Ambiguous RPC Timeout):**
     - **قانون طلایی:** **هرگز برودکست مجدد بدون استعلام آن‌چین نزنید!**
     - اجرای Reconciler برای خواندن وضعیت از ایندکسر TON:
       ```sql
       -- ورکر ریست‌کننده وضعیت‌های UNKNOWN به طور خودکار استعلام می‌گیرد
       SELECT id, failure_code FROM system.reconciliation_exceptions WHERE entity_id = '<PAYOUT_UUID>';
       ```
   * **اگر وضعیت `SIGNED` به مدت طولانی مانده (Seqno Blocked):**
     - بررسی قفل ترتیبی TonSeqnoManager:
       ```sql
       SELECT * FROM finance.payout_seqno_allocations WHERE payout_id = '<PAYOUT_UUID>';
       ```
     - اطمینان از اینکه تراکنش قبلی در شبکه TON ماین شده است.

---

### سناریوی ۳: انحراف یا قطعی اوراکل نرخ تبدیل (Oracle Degradation / Divergence)

#### علائم:
* هشدار `OracleDivergenceHigh` یا عدم امکان قفل نرخ در زمان صف تسویه.

#### مراحل اقدام:
1. **مشاهده نرخ‌های ثبت‌شده و انحراف منابع:**
   ```sql
   SELECT id, name, source_type, weight_percent, status, last_rate, last_updated_at 
     FROM finance.oracle_sources;
   ```
2. **تغییر وزن یا غیرفعال‌سازی صرافی معیوب در پنل ادمین:**
   - تغییر وضعیت صرافی معیوب از `ACTIVE` به `INACTIVE` با ثبت دلیل ممیزی در `finance.oracle_change_history`.
3. **فعال‌سازی نرخ اضطراری موقت (Fallback Manual Rate):**
   - در صورت قطع کامل اینترنت بین‌المللی، ادمین ارشد با تایید دونفره (Four-Eyes) نرخ تثبیت‌شده روزانه را به عنوان منبع `MANUAL` تزریق می‌کند.

---

### سناریوی ۴: مواجهه با عدم تعادل لجر (Ledger Imbalance Incident)

#### علائم:
* متریک `goldpay_ledger_balanced == 0` صفر شده و هشدار بحرانی ارسال شده است.
* پلتفرم به طور خودکار وارد وضعیت `financial_freeze = true` شده و خروج پول مسدود گردیده است.

#### مراحل اقدام:
1. **اجرای اسکریپت ممیزی لجر:**
   ```bash
   npm run ledger:verify
   ```
2. **شناسایی آرتیکل‌های نامتعادل:**
   ```sql
   SELECT j.id, j.reference_type, j.reference_id, j.operation_id,
          SUM(e.debit) AS total_debit, SUM(e.credit) AS total_credit
     FROM finance.journals j
     JOIN finance.journal_entries e ON e.journal_id = j.id
    GROUP BY j.id, j.reference_type, j.reference_id, j.operation_id
   HAVING SUM(e.debit) <> SUM(e.credit);
   ```
3. **تحلیل ریشه و رفع مغایرت:**
   - ثبت آرتیکل اصلاحی جبرانی (Correction Journal Entry) با تأیید دو سوپرادمین.
4. **آزاد کردن فریز پلتفرم (Unfreeze):**
   - اجرای `POST /internal/admin/platform/unfreeze` توسط ادمین ارشد پس از تایید پاس شدن مجدد `npm run ledger:verify`.

---

## ۳. دستورالعمل بازیابی پس از سانحه (Disaster Recovery & Point-In-Time Restore)

```bash
# 1. بازیابی آخرین اسنپ‌شات کامل دیتابیس به سرور Standby
pg_restore -U gram -d gram_recovery -v latest_full_backup.dump

# 2. اعمال فایل‌های WAL آرشیو شده تا ثانیه مد نظر
# در postgresql.conf:
# restore_command = 'aws s3 cp s3://goldpay-wal-archive/%f %p'
# recovery_target_time = '2026-09-21 14:30:00 UTC'

# 3. اجرای اسکریپت سلامت و اعتبارسنجی دفاتر کل پس از Restore
DATABASE_URL="postgres://gram:password@standby:5432/gram" npm run ledger:verify

# 4. هدایت ترافیک درگاه به سرور بازیابی‌شده
```

---

## ۴. ماتریس دسترسی و نقش‌های امنیتی سازمانی (Role-Based Access Matrix)

| نقش کاربری | دسترسی‌ها | نیازمندی تأیید دونفره (Four-Eyes) |
| :--- | :--- | :---: |
| **SUPPORT** | مشاهده تیکت‌ها، مشاهده وضعیت فاکتورها، پاسخگویی به مرچنت | خیر |
| **RISK_ANALYST** | مشاهده ارزیابی‌های ریسک، قراردادن و آزادسازی Hold روی پرداخت‌ها | خیر |
| **FINANCE_OPERATOR**| مشاهده ترازنامه‌ها، درخواست شارژ دستی خزانه، استعلام تسویه‌ها | بله (برای شارژ) |
| **SUPER_ADMIN** | فریز/آن‌فریز پلتفرم، تغییر حالت پرووایدر، مدیریت ادمین‌ها | **بله (برای کلیه تغییرات مالی)** |

---

*پایان مستند عملیاتی — نسخه ۳.۳ مصوب*
