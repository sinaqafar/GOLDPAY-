/**
 * Admin panel — SPEC 117.21 / 117.22.
 *
 * Read-heavy by design. The dangerous operations it does expose — treasury
 * funding, freeze, suspension — all go through the admin API, which enforces
 * RBAC, four-eyes approval and audit. The panel cannot bypass any of that,
 * because it has no other route to the data (SPEC 121.71).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, getCredential, setCredential, clearCredential, formatAmount, formatGram, formatDate } from './api.ts';

type Tab =
  | 'overview'
  | 'merchants'
  | 'payouts'
  | 'treasury'
  | 'approvals'
  | 'holds'
  | 'disputes'
  | 'support'
  | 'exceptions'
  | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'داشبورد' },
  { id: 'merchants', label: 'فروشندگان' },
  { id: 'payouts', label: 'تسویه‌ها' },
  { id: 'treasury', label: 'خزانه' },
  { id: 'approvals', label: 'تأییدها' },
  { id: 'holds', label: 'قفل‌ها' },
  { id: 'disputes', label: 'اختلافات' },
  { id: 'support', label: 'پشتیبانی' },
  { id: 'exceptions', label: 'مغایرت‌ها' },
  { id: 'audit', label: 'گزارش ممیزی' },
];

export function App() {
  const [authed, setAuthed] = useState(Boolean(getCredential()));
  const [me, setMe] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    if (!authed) return;
    api<Record<string, unknown>>('GET', '/internal/admin/me')
      .then(setMe)
      .catch(() => {
        setAuthed(false);
        setMe(null);
      });
  }, [authed]);

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return (
    <div className="shell">
      <aside>
        <div className="logo">GRAM Gateway</div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="who">
          {me ? (
            <>
              <div className="email">{String(me['email'] ?? '')}</div>
              <div className="role">{String(me['role'] ?? '')}</div>
            </>
          ) : null}
          <button
            className="logout"
            onClick={() => {
              clearCredential();
              setAuthed(false);
            }}
          >
            خروج
          </button>
        </div>
      </aside>
      <main>
        <Panel tab={tab} />
      </main>
    </div>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCredential(value.trim());
    try {
      await api('GET', '/internal/admin/me');
      onSuccess();
    } catch (err) {
      clearCredential();
      setError(err instanceof Error ? err.message : 'ورود ناموفق بود');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>ورود مدیر</h1>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="اعتبارنامه مدیر"
          autoFocus
        />
        {error ? <div className="error">{error}</div> : null}
        <button disabled={busy || !value.trim()}>{busy ? '…' : 'ورود'}</button>
        <p className="hint">اعتبارنامه با اسکریپت create-admin ساخته می‌شود.</p>
      </form>
    </div>
  );
}

/** Loads one endpoint and renders it, with explicit loading/error/empty states. */
function Resource<T>({
  path,
  children,
  refreshKey,
}: {
  path: string;
  refreshKey?: number;
  children: (data: T, reload: () => void) => React.ReactNode;
}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<T>('GET', path)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [path, tick, refreshKey]);

  if (error) return <div className="error">{error}</div>;
  if (data === null) return <div className="loading">در حال بارگذاری…</div>;
  return <>{children(data, reload)}</>;
}

function Panel({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'overview':
      return <Overview />;
    case 'merchants':
      return <Listing path="/internal/admin/merchants" title="فروشندگان" columns={MERCHANT_COLS} />;
    case 'payouts':
      return <Listing path="/internal/admin/payouts" title="تسویه‌ها" columns={PAYOUT_COLS} />;
    case 'treasury':
      return <Treasury />;
    case 'approvals':
      return <Approvals />;
    case 'holds':
      return <Holds />;
    case 'disputes':
      return <Listing path="/internal/admin/disputes" title="اختلافات" columns={DISPUTE_COLS} />;
    case 'support':
      return <Listing path="/internal/admin/support/tickets" title="تیکت‌های پشتیبانی" columns={TICKET_COLS} />;
    case 'exceptions':
      return <Listing path="/internal/admin/exceptions" title="مغایرت‌ها" columns={EXCEPTION_COLS} />;
    case 'audit':
      return <Listing path="/internal/admin/audit" title="گزارش ممیزی" columns={AUDIT_COLS} />;
  }
}

function Overview() {
  return (
    <Resource<Record<string, unknown>> path="/internal/admin/overview">
      {(data) => {
        const frozen = data['financial_freeze'] === true;
        return (
          <>
            <h1>داشبورد</h1>
            {frozen ? (
              <div className="banner bad">
                سیستم در حالت انجماد مالی است. تسویه‌ها متوقف شده‌اند.
              </div>
            ) : null}
            {data['ledger_balanced'] === false ? (
              <div className="banner bad">دفتر کل تراز نیست. بررسی فوری لازم است.</div>
            ) : null}
            <div className="cards">
              <Stat label="فروشندگان" value={String(countOf(data['merchants']))} />
              <Stat label="تسویه‌های در جریان" value={String(countOf(data['payouts']))} />
              <Stat label="مغایرت‌های باز" value={String(countOf(data['open_exceptions']))} />
              <Stat
                label="تراز دفتر کل"
                value={data['ledger_balanced'] === true ? 'سالم' : 'نامشخص'}
              />
            </div>
            {Array.isArray(data['treasury']) && data['treasury'].length > 0 ? (
              <>
                <h1 style={{ marginTop: 28 }}>خزانه</h1>
                <div className="cards">
                  {(data['treasury'] as Record<string, unknown>[]).map((t, i) => (
                    <Stat
                      key={i}
                      label={`${String(t['asset'])} · ${String(t['network'])}`}
                      value={`${formatGram(t['confirmed_balance_atomic'])} GRAM`}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </>
        );
      }}
    </Resource>
  );
}

function Treasury() {
  return (
    <Resource<Record<string, unknown>> path="/internal/admin/treasury">
      {(data) => {
        const accounts = (data['accounts'] ?? []) as Record<string, unknown>[];
        const reserved = String(data['active_reservations_atomic'] ?? '0');

        return (
          <>
            <h1>خزانه</h1>
            <div className="banner">
              تأمین خزانه فقط به‌صورت دستی توسط مالک انجام می‌شود. هیچ خرید، Swap یا تأمین خودکاری
              در سیستم وجود ندارد.
            </div>

            {accounts.length === 0 ? (
              <div className="empty">حساب خزانه‌ای تعریف نشده.</div>
            ) : (
              accounts.map((a) => {
                // Spendable = confirmed − reserved − safety reserve. Computed
                // here only for display; the payout engine does its own
                // calculation against the database.
                const confirmed = BigInt(String(a['confirmed_balance_atomic'] ?? '0'));
                const safety = BigInt(String(a['safety_reserve_atomic'] ?? '0'));
                const held = BigInt(reserved);
                const spendable = confirmed - safety - held;

                return (
                  <div key={String(a['id'])} style={{ marginBottom: 18 }}>
                    <div className="cards">
                      <Stat
                        label="موجودی تأییدشده"
                        value={`${formatGram(a['confirmed_balance_atomic'])} GRAM`}
                      />
                      <Stat label="رزروشده" value={`${formatGram(reserved)} GRAM`} />
                      <Stat
                        label="ذخیره ایمنی"
                        value={`${formatGram(a['safety_reserve_atomic'])} GRAM`}
                      />
                      <Stat
                        label="قابل خرج"
                        value={`${formatGram((spendable > 0n ? spendable : 0n).toString())} GRAM`}
                      />
                    </div>
                    <p className="hint mono" style={{ color: 'var(--dim)', fontSize: 12 }}>
                      {String(a['address'] ?? '')}
                    </p>
                  </div>
                );
              })
            )}
          </>
        );
      }}
    </Resource>
  );
}

/** Length of an array-shaped field, tolerating a missing or scalar value. */
function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function Approvals() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, action: 'approve' | 'reject') {
    setBusy(id);
    try {
      await api('POST', `/internal/admin/approvals/${id}/${action}`, { reason: 'panel' });
      setRefreshKey((n) => n + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Resource<Record<string, unknown>[]> path="/internal/admin/approvals" refreshKey={refreshKey}>
      {(rows) => (
        <>
          <h1>تأییدهای در انتظار</h1>
          <div className="banner">
            هر عملیات حساس نیاز به تأیید شخص دومی دارد؛ درخواست‌کننده نمی‌تواند خودش تأیید کند.
          </div>
          {rows.length === 0 ? (
            <div className="empty">موردی در انتظار تأیید نیست.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>نوع</th>
                  <th>مبلغ</th>
                  <th>درخواست‌کننده</th>
                  <th>زمان</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r['id'])}>
                    <td>{String(r['operation'] ?? '')}</td>
                    <td>{formatGram(r['amount_atomic'])} GRAM</td>
                    <td className="mono">{String(r['requested_by'] ?? '').slice(0, 8)}</td>
                    <td>{formatDate(r['created_at'])}</td>
                    <td className="actions">
                      <button
                        disabled={busy === String(r['id'])}
                        onClick={() => act(String(r['id']), 'approve')}
                      >
                        تأیید
                      </button>
                      <button
                        className="ghost"
                        disabled={busy === String(r['id'])}
                        onClick={() => act(String(r['id']), 'reject')}
                      >
                        رد
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Resource>
  );
}

/**
 * Active holds, with the one action that matters: lifting them.
 *
 * A hold is money a merchant cannot access, so this screen is the answer to
 * "why has my settlement not arrived" and must be easy to work through.
 */
function Holds() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  async function release(id: string) {
    const reason = prompt('دلیل آزادسازی قفل:');
    if (!reason) return;
    setBusy(id);
    try {
      await api('POST', `/internal/admin/holds/${id}/release`, { reason });
      setRefreshKey((n) => n + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Resource<Record<string, unknown>[]> path="/internal/admin/holds" refreshKey={refreshKey}>
      {(rows) => (
        <>
          <h1>قفل‌های فعال</h1>
          <div className="banner">
            قفل فقط آزادسازی را متوقف می‌کند؛ هیچ پولی جابه‌جا یا برگشت نمی‌خورد.
          </div>
          {rows.length === 0 ? (
            <div className="empty">قفل فعالی وجود ندارد.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>فروشنده</th>
                  <th>مبلغ</th>
                  <th>منبع</th>
                  <th>دلیل</th>
                  <th>زمان</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r['id'])}>
                    <td>{String(r['merchant_name'] ?? '')}</td>
                    <td>{formatAmount(r['amount'])} تومان</td>
                    <td>{String(r['source'] ?? '')}</td>
                    <td>{String(r['reason'] ?? '')}</td>
                    <td>{formatDate(r['created_at'])}</td>
                    <td className="actions">
                      <button disabled={busy === String(r['id'])} onClick={() => release(String(r['id']))}>
                        آزادسازی
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Resource>
  );
}

interface Column {
  key: string;
  label: string;
  render?: (row: Record<string, unknown>) => React.ReactNode;
}

const MERCHANT_COLS: Column[] = [
  { key: 'name', label: 'نام' },
  { key: 'status', label: 'وضعیت' },
  { key: 'default_fee_mode', label: 'حالت کارمزد' },
  { key: 'created_at', label: 'تاریخ', render: (r) => formatDate(r['created_at']) },
];

const PAYOUT_COLS: Column[] = [
  { key: 'status', label: 'وضعیت' },
  { key: 'amount_toman', label: 'مبلغ', render: (r) => `${formatAmount(r['amount_toman'])} تومان` },
  {
    key: 'gram_amount_atomic',
    label: 'GRAM',
    render: (r) => formatGram(r['gram_amount_atomic']),
  },
  { key: 'created_at', label: 'تاریخ', render: (r) => formatDate(r['created_at']) },
];

const DISPUTE_COLS: Column[] = [
  { key: 'merchant_name', label: 'فروشنده' },
  { key: 'status', label: 'وضعیت' },
  { key: 'reason', label: 'دلیل' },
  { key: 'resolution', label: 'نتیجه' },
  { key: 'created_at', label: 'تاریخ', render: (r) => formatDate(r['created_at']) },
];

const TICKET_COLS: Column[] = [
  { key: 'reference', label: 'کد' },
  { key: 'merchant_name', label: 'فروشنده' },
  { key: 'subject', label: 'موضوع' },
  { key: 'category', label: 'دسته' },
  { key: 'priority', label: 'اولویت' },
  { key: 'status', label: 'وضعیت' },
  { key: 'updated_at', label: 'به‌روزرسانی', render: (r) => formatDate(r['updated_at']) },
];

const EXCEPTION_COLS: Column[] = [
  { key: 'kind', label: 'نوع' },
  { key: 'severity', label: 'شدت' },
  { key: 'entity_type', label: 'موجودیت' },
  { key: 'status', label: 'وضعیت' },
  { key: 'created_at', label: 'تاریخ', render: (r) => formatDate(r['created_at']) },
];

const AUDIT_COLS: Column[] = [
  { key: 'action', label: 'عملیات' },
  { key: 'actor_type', label: 'عامل' },
  { key: 'resource_type', label: 'موجودیت' },
  { key: 'created_at', label: 'زمان', render: (r) => formatDate(r['created_at']) },
];

function Listing({ path, title, columns }: { path: string; title: string; columns: Column[] }) {
  return (
    <Resource<Record<string, unknown>[]> path={path}>
      {(rows) => (
        <>
          <h1>{title}</h1>
          {rows.length === 0 ? (
            <div className="empty">موردی یافت نشد.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={String(row['id'] ?? i)}>
                    {columns.map((c) => (
                      <td key={c.key}>{c.render ? c.render(row) : String(row[c.key] ?? '—')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Resource>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
