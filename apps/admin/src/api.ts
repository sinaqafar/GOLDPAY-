/**
 * Admin API client.
 *
 * Every call goes through `/internal/admin/*`. The panel never talks to the
 * database and never computes a financial figure: it displays what the API
 * returns (SPEC 121.71 — the UI is not the source of truth).
 */

export interface ApiError {
  code: string;
  message: string;
}

const CREDENTIAL_KEY = 'gram.admin.credential';

export function getCredential(): string | null {
  return sessionStorage.getItem(CREDENTIAL_KEY);
}

export function setCredential(value: string): void {
  // sessionStorage, not localStorage: the credential dies with the tab rather
  // than persisting on a shared machine.
  sessionStorage.setItem(CREDENTIAL_KEY, value);
}

export function clearCredential(): void {
  sessionStorage.removeItem(CREDENTIAL_KEY);
}

/**
 * Exchange the credential for an HttpOnly session cookie, then forget it.
 *
 * Holding a long-lived credential in sessionStorage leaves it readable by any
 * script that reaches this origin. The cookie is not.
 */
export async function startSession(credential: string): Promise<void> {
  const res = await fetch('/internal/admin/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
  });
  if (!res.ok) {
    const envelope = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const error = (envelope?.['error'] ?? {}) as Partial<ApiError>;
    throw Object.assign(new Error(error.message ?? 'login failed'), {
      code: error.code ?? 'UNKNOWN',
      status: res.status,
    });
  }
  // The cookie is set; the credential is deliberately not retained.
  clearCredential();
}

export async function endSession(): Promise<void> {
  await fetch('/internal/admin/session/revoke', {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(() => undefined);
  clearCredential();
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const credential = getCredential();
  const res = await fetch(path, {
    method,
    // The session cookie travels automatically; the header is only a fallback
    // for a browser that has not exchanged one yet.
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const envelope = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok) {
    const error = (envelope?.['error'] ?? {}) as Partial<ApiError>;
    if (res.status === 401 || res.status === 403) clearCredential();
    throw Object.assign(new Error(error.message ?? `request failed (${res.status})`), {
      code: error.code ?? 'UNKNOWN',
      status: res.status,
    });
  }

  // Unwrap the standard { data, meta } envelope.
  const data = envelope?.['data'];
  return (data === undefined ? envelope : data) as T;
}

/** Group digits for readability. Display only — never used for arithmetic. */
export function formatAmount(value: unknown): string {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  if (!/^-?\d+$/.test(raw)) return '—';
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  return (negative ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** nanogram -> GRAM, using BigInt so no precision is lost. */
export function formatGram(atomic: unknown): string {
  const raw = typeof atomic === 'string' ? atomic : '';
  if (!/^\d+$/.test(raw)) return '—';
  const value = BigInt(raw);
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function formatDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
