/**
 * GRAM Gateway Mini App.
 *
 * Presentation only. Every figure shown here comes from the API, which is the
 * single source of truth; this file never computes a fee, a balance or an
 * eligibility date of its own. Amounts are handled as strings so that no value
 * ever passes through a JavaScript float.
 */

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

/**
 * Outside Telegram there is no initData. In development the server can mint a
 * signed one so the UI is viewable in a plain browser; in every other
 * environment that endpoint returns 404 and the app simply stays unauthorised.
 */
let devInitData = null;
async function loadDevInitData() {
  if (tg?.initData) return;
  try {
    const res = await fetch('/__dev/init-data');
    if (res.ok) devInitData = (await res.json()).initData;
  } catch {
    /* not available: carry on unauthenticated */
  }
}

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

const state = { tab: 'home', me: null, feePercent: null };

/* --- helpers -------------------------------------------------------------- */

/** Group an integer string with Persian thousands separators, digits intact. */
function formatToman(value) {
  if (value === null || value === undefined) return '۰';
  const digits = String(value).replace(/[^\d]/g, '') || '0';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return toPersianDigits(grouped);
}

function toPersianDigits(s) {
  return String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

/** nanoGRAM (9 decimals) as an exact decimal string — no float arithmetic. */
function formatGram(atomic) {
  if (!atomic) return '۰';
  const s = String(atomic).replace(/[^\d]/g, '').padStart(10, '0');
  const whole = s.slice(0, -9).replace(/^0+(?=\d)/, '');
  const frac = s.slice(-9).replace(/0+$/, '');
  return toPersianDigits(frac ? `${whole}.${frac}` : whole);
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      dateStyle: 'short',
      timeStyle: 'short',
      calendar: 'persian',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function shorten(s, head = 6, tail = 6) {
  const v = String(s ?? '');
  return v.length > head + tail + 3 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v;
}

/* --- API ------------------------------------------------------------------ */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      // The Mini App proves who the user is with Telegram's signed initData.
      // The API verifies the HMAC; the client cannot forge it.
      'x-telegram-init-data': tg?.initData || devInitData || '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(payload?.error?.message ?? 'خطای ناشناخته');
    err.code = payload?.error?.code;
    throw err;
  }
  return payload;
}

/* --- status labels -------------------------------------------------------- */

const INVOICE_STATUS = {
  CREATED: ['در انتظار پرداخت', 'neutral'],
  PENDING: ['در حال پرداخت', 'warn'],
  PAID: ['پرداخت شد', 'ok'],
  EXPIRED: ['منقضی شد', 'neutral'],
  CANCELLED: ['لغو شد', 'neutral'],
};

const PAYOUT_STATUS = {
  CREATED: ['ایجاد شد', 'neutral'],
  QUEUED: ['در صف', 'warn'],
  RATE_LOCKED: ['نرخ قفل شد', 'warn'],
  WAITING_LIQUIDITY: ['در انتظار نقدینگی', 'warn'],
  RESERVED: ['رزرو شد', 'warn'],
  SIGNED: ['امضا شد', 'warn'],
  BROADCASTED: ['ارسال شد به شبکه', 'warn'],
  CONFIRMING: ['در انتظار تأیید شبکه', 'warn'],
  SETTLED: ['تسویه شد', 'ok'],
  FAILED: ['ناموفق', 'bad'],
  UNKNOWN: ['در حال بررسی', 'warn'],
};

const PAYMENT_STATUS = {
  PENDING: ['در انتظار', 'warn'],
  VERIFYING: ['در حال بررسی', 'warn'],
  VERIFIED: ['تأیید شد', 'ok'],
  RELEASED: ['آزاد شد', 'ok'],
  FAILED: ['ناموفق', 'bad'],
  MISMATCH: ['مغایرت مبلغ', 'bad'],
  REVIEW: ['در حال بررسی', 'warn'],
  UNKNOWN: ['نامشخص', 'warn'],
};

const FEE_MODE_LABEL = {
  CUSTOMER: 'پرداخت کارمزد توسط خریدار',
  MERCHANT: 'پرداخت کارمزد توسط فروشنده',
  SPLIT: 'کارمزد نصف‌نصف',
};

const TICKET_STATUS = {
  OPEN: ['باز', 'warn'],
  IN_PROGRESS: ['در حال بررسی', 'warn'],
  WAITING_CUSTOMER: ['منتظر پاسخ شما', 'warn'],
  WAITING_INTERNAL: ['منتظر پشتیبانی', 'warn'],
  RESOLVED: ['حل شد', 'ok'],
  CLOSED: ['بسته', 'neutral'],
};

const WALLET_STATUS = {
  ACTIVE: ['فعال', 'ok'],
  SECURITY_HOLD: ['در دورهٔ امنیتی', 'warn'],
  DISABLED: ['غیرفعال', 'neutral'],
};

function badge(map, status) {
  const [label, tone] = map[status] ?? [status, 'neutral'];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

/* --- views ---------------------------------------------------------------- */

async function viewHome() {
  const me = await api('GET', '/v1/me');
  state.me = me;

  if (!me.merchant) {
    return `
      <div class="empty">
        <h2>هنوز فروشگاهی ندارید</h2>
        <p>برای ساخت فروشگاه، در ربات دستور /start را بفرستید.</p>
      </div>`;
  }

  const b = me.balance ?? {};
  return `
    <div class="card balance-card">
      <div class="label">موجودی قابل برداشت</div>
      <div class="amount">${formatToman(b.available)} <span class="unit">تومان</span></div>
      <div class="balance-grid">
        <div><div class="k">در دورهٔ تسویه</div><div class="v">${formatToman(b.pending)}</div></div>
        <div><div class="k">در حال پرداخت</div><div class="v">${formatToman(b.settling)}</div></div>
      </div>
    </div>

    <div class="notice">
      مبلغ هر پرداخت ۴۸ ساعت پس از تأیید، آزاد و به‌صورت خودکار تسویه می‌شود.
      نیازی به درخواست برداشت نیست.
    </div>

    <div class="card">
      <div class="row">
        <div class="main"><div class="title">${escapeHtml(me.merchant.name)}</div>
        <div class="sub">حالت کارمزد: ${escapeHtml(me.merchant.default_fee_mode)}</div></div>
        <div class="end">${badge({ ACTIVE: ['فعال', 'ok'], SUSPENDED: ['معلق', 'bad'] }, me.merchant.status)}</div>
      </div>
    </div>

    <button class="primary" data-action="new-invoice">ساخت فاکتور جدید</button>`;
}

function viewNewInvoice() {
  return `
    <h2>فاکتور جدید</h2>
    <div class="card">
      <label for="amount">مبلغ (تومان)</label>
      <input id="amount" inputmode="numeric" placeholder="۲۵۰۰۰۰" autocomplete="off" />
      <label for="description">توضیحات (اختیاری)</label>
      <input id="description" placeholder="مثلاً: سفارش ۱۲۳" autocomplete="off" />
      <div class="fee-preview" id="preview"></div>
      <button class="primary" data-action="submit-invoice">ساخت فاکتور</button>
    </div>
    <button class="ghost" data-action="back">بازگشت</button>`;
}

async function viewInvoices() {
  const { data } = await api('GET', '/v1/app/invoices?limit=30');
  if (!data.length) {
    return `<div class="empty"><p>هنوز فاکتوری نساخته‌اید.</p></div>
            <button class="primary" data-action="new-invoice">ساخت فاکتور جدید</button>`;
  }

  return `
    <h2>فاکتورها</h2>
    <div class="card">
      ${data
        .map(
          (i) => {
            const checkoutUrl = i.checkout_url || `${location.origin}/checkout/${i.id}`;
            return `
        <div class="row" style="align-items: center; justify-content: space-between;">
          <div class="main" style="cursor: pointer;" data-action="open-url" data-url="${escapeHtml(checkoutUrl)}">
            <div class="title">${formatToman(i.customer_total)} تومان</div>
            <div class="sub">${escapeHtml(i.invoice_number)} · ${formatDate(i.created_at)}</div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <div class="end">${badge(INVOICE_STATUS, i.status)}</div>
            ${i.status === 'CREATED' ? `<button class="ghost" style="padding: 6px 10px; font-size: 11px; margin: 0;" data-action="share" data-url="${escapeHtml(checkoutUrl)}">اشتراک</button>` : ''}
          </div>
        </div>`;
          }
        )
        .join('')}
    </div>
    <button class="primary" data-action="new-invoice">ساخت فاکتور جدید</button>`;
}

async function viewPayouts() {
  const { data } = await api('GET', '/v1/app/payouts');
  if (!data.length) {
    return `<div class="empty">
      <p>هنوز تسویه‌ای انجام نشده.</p>
      <p class="sub">پس از ۴۸ ساعت از اولین پرداخت، تسویه خودکار آغاز می‌شود.</p>
    </div>`;
  }

  return `
    <h2>تسویه‌ها</h2>
    <div class="card">
      ${data
        .map(
          (p) => `
        <div class="row">
          <div class="main">
            <div class="title">${formatToman(p.amount_toman)} تومان</div>
            <div class="sub">
              ${p.gram_amount ? `${formatGram(p.gram_amount)} گرم · ` : ''}${formatDate(p.created_at)}
            </div>
            ${
              p.transaction_hash
                ? `<div class="sub mono">${escapeHtml(shorten(p.transaction_hash, 10, 8))}</div>`
                : ''
            }
          </div>
          <div class="end">${badge(PAYOUT_STATUS, p.status)}</div>
        </div>`,
        )
        .join('')}
    </div>`;
}

async function viewWallet() {
  const { data } = await api('GET', '/v1/app/wallets');
  const active = data.find((w) => w.status === 'ACTIVE' || w.status === 'SECURITY_HOLD');

  return `
    <h2>کیف پول تسویه</h2>
    ${
      active
        ? `<div class="card">
             <div class="row">
               <div class="main">
                 <div class="title mono">${escapeHtml(shorten(active.address, 8, 8))}</div>
                 <div class="sub">${escapeHtml(active.network)} · GRAM</div>
               </div>
               <div class="end">${badge(WALLET_STATUS, active.status)}</div>
             </div>
           </div>
           ${
             active.status === 'SECURITY_HOLD'
               ? `<div class="notice">این آدرس تا ${formatDate(active.hold_until)} در دورهٔ امنیتی است و پیش از آن تسویه‌ای به آن انجام نمی‌شود.</div>`
               : ''
           }`
        : `<div class="notice">برای دریافت تسویه باید یک آدرس TON ثبت کنید.</div>`
    }

    <div class="card">
      <label for="address">آدرس کیف پول TON</label>
      <input id="address" class="mono" placeholder="EQ…" autocomplete="off" spellcheck="false" />
      <div class="fee-preview">
        پس از ثبت، آدرس ۲۴ ساعت در دورهٔ امنیتی می‌ماند. ثبت آدرس جدید، آدرس قبلی را غیرفعال می‌کند.
      </div>
      <button class="primary" data-action="submit-wallet">ثبت آدرس</button>
    </div>`;
}

/* --- fee preview ---------------------------------------------------------- */

/**
 * Show what the customer pays. This mirrors the server's CUSTOMER-mode rule for
 * display purposes only — the authoritative figure is the one the API returns
 * and stores on the invoice.
 */
function updatePreview() {
  const el = document.getElementById('preview');
  const raw = (document.getElementById('amount')?.value ?? '').replace(/[^\d۰-۹٠-٩]/g, '');
  const normalised = raw.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
                        .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  if (!el) return;
  if (!normalised) { el.innerHTML = ''; return; }

  const base = BigInt(normalised);
  const fee = (base * 15n) / 100n; // integer arithmetic, same as the server
  el.innerHTML = `
    مبلغ شما: <b>${formatToman(base.toString())}</b> تومان<br />
    کارمزد ۱۵٪: <b>${formatToman(fee.toString())}</b> تومان<br />
    پرداختی مشتری: <b>${formatToman((base + fee).toString())}</b> تومان`;
}

/* --- actions -------------------------------------------------------------- */

async function submitInvoice(button) {
  const amountEl = document.getElementById('amount');
  const raw = amountEl.value.replace(/[^\d۰-۹٠-٩]/g, '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

  if (!raw || BigInt(raw) <= 0n) {
    tg?.HapticFeedback?.notificationOccurred('error');
    return showError('مبلغ نامعتبر است.');
  }

  button.disabled = true;
  button.textContent = 'در حال ساخت…';
  try {
    const invoice = await api('POST', '/v1/app/invoices', {
      amount: raw,
      description: document.getElementById('description').value || undefined,
    });
    tg?.HapticFeedback?.notificationOccurred('success');

    const checkoutUrl = invoice.checkout_url || `${location.origin}/checkout/${invoice.id}`;

    app.innerHTML = `
      <h2>فاکتور ساخته شد</h2>
      <div class="card">
        <div class="row"><div class="main"><div class="sub">شمارهٔ فاکتور</div>
          <div class="title mono">${escapeHtml(invoice.invoice_number)}</div></div></div>
        <div class="row"><div class="main"><div class="sub">پرداختی مشتری</div>
          <div class="title">${formatToman(invoice.customer_total)} تومان</div></div></div>
        <div class="row"><div class="main"><div class="sub">سهم شما</div>
          <div class="title">${formatToman(invoice.merchant_net)} تومان</div></div></div>
      </div>
      <button class="primary" data-action="share" data-url="${escapeHtml(checkoutUrl)}">ارسال لینک پرداخت (Checkout)</button>
      <button class="ghost" data-action="back">بازگشت</button>`;
  } catch (e) {
    tg?.HapticFeedback?.notificationOccurred('error');
    showError(e.message);
    button.disabled = false;
    button.textContent = 'ساخت فاکتور';
  }
}

async function submitWallet(button) {
  const address = document.getElementById('address').value.trim();
  if (!address) return showError('آدرس را وارد کنید.');

  button.disabled = true;
  button.textContent = 'در حال ثبت…';
  try {
    await api('POST', '/v1/app/wallets', { address });
    tg?.HapticFeedback?.notificationOccurred('success');
    await render('wallet');
  } catch (e) {
    tg?.HapticFeedback?.notificationOccurred('error');
    showError(
      e.code === 'INVALID_WALLET_ADDRESS'
        ? 'این آدرس معتبر نیست. آدرس TON باید با EQ یا UQ شروع شود.'
        : e.message,
    );
    button.disabled = false;
    button.textContent = 'ثبت آدرس';
  }
}

function showError(message) {
  const existing = document.querySelector('.error');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'error';
  div.textContent = message;
  app.prepend(div);
}

/* --- router --------------------------------------------------------------- */

const VIEWS = {
  home: viewHome,
  invoices: viewInvoices,
  payouts: viewPayouts,
  wallet: viewWallet,
  more: viewMore,
};

async function render(tab) {
  state.tab = tab;
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  for (const b of tabbar.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tab === tab);
  }

  try {
    app.innerHTML = await VIEWS[tab]();
    tabbar.hidden = false;
  } catch (e) {
    app.innerHTML =
      e.code === 'USER_NOT_REGISTERED'
        ? `<div class="empty"><h2>ابتدا ثبت‌نام کنید</h2><p>در ربات دستور /start را بفرستید.</p></div>`
        : `<div class="error">${escapeHtml(e.message)}</div>
           <button class="ghost" data-action="retry">تلاش دوباره</button>`;
    tabbar.hidden = false;
  }
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;

  if (btn.dataset.tab) return void render(btn.dataset.tab);

  switch (btn.dataset.action) {
    case 'new-invoice':
      app.innerHTML = viewNewInvoice();
      document.getElementById('amount').addEventListener('input', updatePreview);
      document.getElementById('amount').focus();
      break;
    case 'submit-invoice':
      void submitInvoice(btn);
      break;
    case 'submit-wallet':
      void submitWallet(btn);
      break;
    case 'open-url':
      if (btn.dataset.url) {
        window.open(btn.dataset.url, '_blank');
      }
      break;
    case 'share':
      if (tg?.openTelegramLink) {
        tg.openTelegramLink(
          `https://t.me/share/url?url=${encodeURIComponent(btn.dataset.url)}&text=${encodeURIComponent('لینک پرداخت')}`,
        );
      } else {
        window.open(btn.dataset.url, '_blank');
      }
      break;
    case 'new-ticket':
      app.innerHTML = viewNewTicket();
      document.getElementById('subject').focus();
      break;
    case 'submit-ticket':
      void submitTicket(btn);
      break;
    case 'back':
    case 'retry':
      void render(state.tab);
      break;
  }
});

void loadDevInitData().then(() => render('home'));
