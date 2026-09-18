/**
 * Public checkout page — SPEC 1459.
 *
 * This is the platform's official payment surface. The customer sees the
 * merchant's name, the amount, the fee and the total here, then continues to
 * CubePay to actually pay.
 *
 * Three rules shape it:
 *
 *  - **No authentication.** Anyone holding the link can view it, so the page
 *    must expose nothing beyond what a buyer legitimately needs. No merchant
 *    identifiers, no internal ledger figures, no provider cost (SPEC 1459).
 *  - **Returning here proves nothing.** A customer coming back from the
 *    provider does not make a payment PAID; only verified provider evidence
 *    does (SPEC 101378 / 7602).
 *  - **Server-rendered, no client JavaScript.** There is nothing for a script
 *    to do, and a checkout page with no scripts has a far smaller attack
 *    surface.
 */

import type { Database } from '../../../packages/database/src/client.ts';
import type { HttpResult } from './http.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escape every HTML metacharacter: merchant and product text is untrusted. */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatToman(atomic: unknown): string {
  const raw = typeof atomic === 'string' ? atomic : String(atomic ?? '');
  if (!/^\d+$/.test(raw)) return '—';
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

interface CheckoutRow {
  id: string;
  status: string;
  merchant_name: string;
  merchant_status: string;
  base_amount: string;
  customer_total_amount: string;
  customer_fee_share: string;
  fee_mode: string;
  description: string | null;
  expires_at: string | null;
  provider_payment_url: string | null;
}

export async function renderCheckout(db: Database, invoiceId: string): Promise<HttpResult> {
  if (!UUID_RE.test(invoiceId)) {
    return htmlResponse(404, page('فاکتور پیدا نشد', 'این لینک معتبر نیست.'));
  }

  const r = await db.query<CheckoutRow>(
    `SELECT i.id, i.status, m.name AS merchant_name, m.status AS merchant_status,
            i.base_amount::text, i.customer_total_amount::text, i.customer_fee_share::text,
            i.fee_mode, i.description, i.expires_at, i.provider_payment_url
       FROM core.invoices i
       JOIN core.merchants m ON m.id = i.merchant_id
      WHERE i.id = $1`,
    [invoiceId],
  );

  const invoice = r.rows[0];
  if (!invoice) {
    return htmlResponse(404, page('فاکتور پیدا نشد', 'این فاکتور وجود ندارد یا حذف شده است.'));
  }

  // A suspended merchant must not be able to keep taking money.
  if (invoice.merchant_status !== 'ACTIVE') {
    return htmlResponse(
      409,
      page('پرداخت در دسترس نیست', 'این فروشگاه در حال حاضر قادر به دریافت پرداخت نیست.'),
    );
  }

  const expired =
    invoice.status === 'EXPIRED' ||
    (invoice.expires_at !== null && new Date(invoice.expires_at).getTime() < Date.now());

  if (invoice.status === 'PAID') {
    return htmlResponse(200, page('پرداخت شد ✅', 'این فاکتور قبلاً پرداخت شده است.'));
  }
  if (invoice.status === 'CANCELLED') {
    return htmlResponse(409, page('فاکتور لغو شد', 'این فاکتور توسط فروشنده لغو شده است.'));
  }
  if (expired) {
    return htmlResponse(
      410,
      page('مهلت پرداخت تمام شد', 'برای دریافت لینک تازه با فروشنده تماس بگیرید.'),
    );
  }

  return htmlResponse(200, checkoutPage(invoice));
}

function checkoutPage(invoice: CheckoutRow): string {
  const fee = invoice.customer_fee_share;
  const showFee = /^\d+$/.test(fee) && BigInt(fee) > 0n;

  // SPEC 12: show the FINAL figure, never only a percentage, so the customer
  // knows exactly what will be charged before they commit.
  const rows = [
    row('مبلغ', `${formatToman(invoice.base_amount)} تومان`),
    ...(showFee ? [row('کارمزد درگاه', `${formatToman(fee)} تومان`)] : []),
    row('مبلغ قابل پرداخت', `<b>${formatToman(invoice.customer_total_amount)} تومان</b>`, true),
  ].join('');

  const payButton = invoice.provider_payment_url
    ? `<a class="pay" href="${escapeHtml(invoice.provider_payment_url)}" rel="noopener noreferrer">پرداخت</a>`
    : `<div class="pending">لینک پرداخت در حال آماده‌سازی است. لحظه‌ای بعد صفحه را تازه کنید.</div>`;

  return shell(
    `پرداخت به ${escapeHtml(invoice.merchant_name)}`,
    `
    <div class="brand">${escapeHtml(invoice.merchant_name)}</div>
    ${invoice.description ? `<p class="desc">${escapeHtml(invoice.description)}</p>` : ''}
    <div class="rows">${rows}</div>
    ${payButton}
    <p class="note">پس از پرداخت، تأیید نهایی توسط درگاه انجام می‌شود.</p>
    `,
  );
}

function row(label: string, value: string, strong = false): string {
  return `<div class="row${strong ? ' strong' : ''}"><span>${label}</span><span>${value}</span></div>`;
}

function page(title: string, message: string): string {
  return shell(title, `<div class="brand">${escapeHtml(title)}</div><p class="desc">${escapeHtml(message)}</p>`);
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#0B0B0F; --card:#15151C; --gold:#D4AF37; --dim:#8A8A99; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:#EDEDF2; font-family:Vazirmatn,system-ui,sans-serif; padding:20px; }
  .card { background:var(--card); border:1px solid #23232E; border-radius:16px;
          padding:28px 24px; width:100%; max-width:420px; }
  .brand { font-size:20px; font-weight:700; color:var(--gold); margin-bottom:8px; }
  .desc { color:var(--dim); font-size:14px; line-height:1.7; margin:0 0 18px; }
  .rows { margin:18px 0; }
  .row { display:flex; justify-content:space-between; padding:11px 0;
         border-bottom:1px solid #23232E; font-size:14px; }
  .row.strong { border-bottom:none; font-size:16px; padding-top:16px; }
  .row span:first-child { color:var(--dim); }
  .pay { display:block; text-align:center; background:var(--gold); color:#0B0B0F;
         font-weight:700; padding:14px; border-radius:12px; text-decoration:none; margin-top:8px; }
  .pending { text-align:center; color:var(--dim); font-size:13px; padding:14px;
             border:1px dashed #2E2E3B; border-radius:12px; }
  .note { color:var(--dim); font-size:12px; text-align:center; margin:16px 0 0; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function htmlResponse(status: number, html: string): HttpResult {
  return {
    status,
    body: html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // A checkout page must never be cached by a shared proxy: it is
      // personalised to one invoice (SPEC 7609).
      'cache-control': 'no-store',
      // No scripts at all, and the page may not be framed.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  };
}
