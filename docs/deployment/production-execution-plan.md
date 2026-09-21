# برنامه اجرایی استقرار پروداکشن (Production Deployment Execution Plan)
**سیستم هدف:** درگاه پرداخت سازمانی GOLDPAY (نسخه v3.3.0 مصوب)  
**سند راهنمای عملیات استقرار و راه‌اندازی زنده (Operational Execution Plan)**

---

```
                       PRODUCTION DEPLOYMENT EXECUTION PHASES
                       
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                      PHASE 1: INFRASTRUCTURE & SECURITY                     │
 │   • PostgreSQL 16 HA + Redis 7 + S3 WORM Object Lock                        │
 │   • Secret Manager Injection & Database Permission Lock (Least Privilege)   │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │                      PHASE 2: REAL GATEWAY & TREASURY                       │
 │   • CubePay Live Network Smoke Test (Exact Rial Wire Match)                 │
 │   • TON Mainnet Treasury & AWS KMS Hardware Signer Validation               │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │                      PHASE 3: CONTROLLED PILOT LAUNCH                       │
 │   • 1-5 Selected Merchants (Manual Webhook, Settlement & Liquidity Review)  │
 │   • Continuous Ledger Verification: npm run ledger:verify (Zero-Sum Invariant)│
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │                      PHASE 4: RAMP & PUBLIC ROLLOUT                         │
 │   • Phase 2: 50 Merchants Ramp ──► Phase 3: Unrestricted Public Launch      │
 │   • 24/7 Prometheus & Alertmanager Active Monitoring                        │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## ۱. گام‌های اجرایی ۷ دروازه عملیاتی (7-Gate Execution Blueprint)

---

### دروازه ۱: انجماد و ایزوله‌سازی زیرساخت پروداکشن (Production Environment Freeze)

#### الف) متغیرهای محیطی استاندارد در Secret Manager (AWS Secrets Manager / Vault):
```env
# Production App Config
NODE_ENV=production
APP_ENV=production
PORT=3000

# Database & Cache (Private VPC)
DATABASE_URL=postgres://gram_app:<SECURE_PASSWORD>@pg-primary.internal:5432/gram_prod?sslmode=verify-full
REDIS_URL=redis://:<REDIS_AUTH_TOKEN>@redis-cluster.internal:6379

# CubePay VIP Production Credentials
CUBEPAY_ACTIVE_MODE=VIP
CUBEPAY_BASE_URL=https://cubevps.ir
CUBEPAY_API_KEY=<PRODUCTION_VIP_TOKEN>
CUBEPAY_WEBHOOK_SECRET=<PRODUCTION_HMAC_SECRET>

# TON Mainnet & KMS Hardware Signer
TON_NETWORK=TON_MAINNET
GRAM_ASSET=GRAM
GRAM_NETWORK=TON_MAINNET
GRAM_DECIMALS=9
TREASURY_ADDRESS=<MAINNET_TREASURY_RAW_ADDRESS>
PAYOUT_WALLET_ADDRESS=<MAINNET_TREASURY_RAW_ADDRESS>
TON_SIGNER_REFERENCE=aws-kms://arn:aws:kms:eu-central-1:123456789012:key/abcd-1234
SAFETY_RESERVE_ATOMIC=50000000000  # 50 GRAM (Covering Gas Variance)

# Automated Trading Protection (Must Remain False)
AUTO_FUNDING=false
AUTO_BUY=false
AUTO_SWAP=false
AUTO_EXCHANGE=false
AUTO_BRIDGE=false

# Financial Policy Invariants
PLATFORM_FEE_PERCENT=15
PROVIDER_FEE_PERCENT=9
PAYOUT_HOLD_HOURS=48
```

---

### دروازه ۲: قفل امنیتی سطح دیتابیس (Database Final Permission Lock)

پس از اجرای مایگریشن‌ها توسط ادمین دیتابیس (`postgres`), دسترسی کاربر اپلیکیشن (`gram_app`) محدود می‌گردد:

```sql
-- DDL Execution on Production PostgreSQL
REVOKE UPDATE, DELETE ON finance.journals FROM gram_app;
REVOKE UPDATE, DELETE ON finance.journal_entries FROM gram_app;
REVOKE UPDATE, DELETE ON finance.ledger_blocks FROM gram_app;
REVOKE UPDATE, DELETE ON integration.evidence_chain FROM gram_app;
REVOKE UPDATE, DELETE ON integration.critical_event_receipts FROM gram_app;
REVOKE UPDATE, DELETE ON risk.risk_decisions FROM gram_app;
REVOKE UPDATE, DELETE ON core.merchant_wallet_history FROM gram_app;

-- دسترسی‌های مجاز اپلیکیشن
GRANT SELECT, INSERT ON finance.journals TO gram_app;
GRANT SELECT, INSERT ON finance.journal_entries TO gram_app;
GRANT SELECT, INSERT ON finance.ledger_blocks TO gram_app;
GRANT SELECT, INSERT, UPDATE ON finance.balances TO gram_app;
GRANT SELECT, INSERT, UPDATE ON core.invoices TO gram_app;
GRANT SELECT, INSERT, UPDATE ON core.payment_intents TO gram_app;
GRANT SELECT, INSERT, UPDATE ON core.payment_attempts TO gram_app;
```

---

### دروازه ۳: اعتبارسنجی زنده با درگاه CubePay (CubePay Smoke Test)

پس از تنظیم IP Allowlist در سرورهای CubePay:
1. اجرای ابزار تشخیصی:
   ```bash
   npm run diagnose:cubepay
   ```
2. اجرای تست اندپوینت زنده:
   ```bash
   npx vitest run tests/integration/cubepay-real-provider-e2e.test.ts
   ```
3. اعتبارسنجی ۴ شاخص در تراکنش واقعی آزمایشی:
   * برابری دقیق ریالی و آفست (`provider_pay_amount_rial == verified_amount_rial`).
   * ثبت کارمزد ۱۵٪ پلتفرم در لجر (`PLATFORM_REVENUE_TOMAN`).
   * ثبت سهم خالص مرچنت در باکت `PENDING`.
   * بررسی ضد-Replay وب‌هوک (ارسال مجدد = ۰ تأثیر مالی).

---

### دروازه ۴: راه‌اندازی خزانه‌داری Mainnet و امضای سخت‌افزاری KMS

1. **شارژ اولیه والت خزانه:** واریز دستی توکن GRAM به آدرس `TREASURY_ADDRESS`.
2. **ثبت تراکنش در پنل ادمین با تایید دونفره (Four-Eyes):**
   ```http
   POST /internal/admin/treasury/funding-requests
   {
     "treasury_account_id": "<ID>",
     "amount_atomic": "100000000000",
     "tx_hash": "<MAINNET_TX_HASH>",
     "reason": "Initial operational liquidity funding"
   }
   ```
3. **تأیید توسط سوپرادمین دوم:** `POST /internal/admin/approvals/<ID>/approve`.
4. **تست امضای KMS:** ارسال یک تراکنش تسویه تستی به والت داخلی و تأیید ثبت هش امضا در `finance.kms_signature_evidence`.

---

### دروازه ۵: انتشار آزمایشی کنترل‌شده (Pilot Launch: 1-5 Merchants)

```
[ثبت‌نام ۱ تا ۵ مرچنت معتمد]
              │
              ▼
 ┌────────────────────────────────────────┐
 │   نظارت ۲۴ ساعته تیم عملیات بر:         │
 │   ۱. دریافت سالم وب‌هوک‌ها              │
 │   ۲. محاسبه دقیق واریزی‌ها در لجر      │
 │   ۳. عدم بروز قفل یا انحراف اوراکل     │
 │   ۴. چرخه تسویه ۴۸ ساعته و صف نقدینگی  │
 └────────────────────────────────────────┘
```

---

### دروازه ۶: فعال‌سازی سامانه مانیتورینگ و هشدارهای اضطراری

قوانین هشدار اضطراری در پرومتئوس فعال و به کانال تلگرام کشیک متصل می‌گردند:

```yaml
groups:
  - name: goldpay_production_live_alerts
    rules:
      - alert: LedgerImbalanceCritical
        expr: goldpay_ledger_balanced == 0
        for: 0m
        labels:
          severity: CRITICAL
        annotations:
          summary: "Ledger double-entry imbalance detected"
          description: "Debits != Credits. Platform financial freeze engaged."

      - alert: PayoutStalledInQueue
        expr: goldpay_payouts_unknown_count > 0
        for: 15m
        labels:
          severity: HIGH
        annotations:
          summary: "Payout stranded in UNKNOWN or SIGNED state"
          description: "Requires manual or chain reconciliation."

      - alert: OracleDeviationHigh
        expr: goldpay_oracle_divergence_bps > 500
        for: 5m
        labels:
          severity: WARNING
        annotations:
          summary: "CEX vs DEX rate divergence > 5%"
          description: "Oracle operating in degraded mode."
```

---

### دروازه ۷: مسیر گسترش پس از پایلوت (Post-Pilot Scaling Roadmap)

```
[مرحله ۱: پایلوت ۱ تا ۵ مرچنت] ──► ارزیابی ۵۰۰ تراکنش اول
              │
              ▼ (تأیید تراز لجر و پایداری خزانه‌داری)
[مرحله ۲: گسترش به ۵۰ مرچنت]  ──► ارزیابی زیر بار ترافیک همزمان
              │
              ▼ (تأیید پایداری و مانیتورینگ بدون خطا)
[مرحله ۳: بازگشایی عمومی]     ──► ثبت‌نام آزاد مرچنت‌ها روی تلگرام
```

---

## ۲. دستورالعمل‌های بررسی مداوم سلامت سیستم (CLI Verification Commands)

```bash
# 1. بررسی یکپارچگی دفاتر کل حسابداری
npm run ledger:verify

# 2. بررسی سلامت زیرسیستم‌ها
npm run health-check

# 3. بررسی گیت سازگاری و ارتباط با پرووایدر
npm run gate:cubepay
```

---

*پایان سند برنامه اجرایی استقرار — نسخه مصوب v3.3.0*
