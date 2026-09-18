/**
 * Metrics — SPEC 71 / Prometheus exposition.
 *
 * A payment gateway that cannot be watched cannot be operated: SPEC 121.173
 * says a feature is not complete until operations can monitor, support, recover
 * and reconcile it.
 *
 * Deliberately a tiny in-process registry rather than a client library. The
 * exposition format is a few lines of text, and the values that matter here —
 * payout queue depth, unknown payouts, liquidity — are read from the database
 * at scrape time rather than counted in memory, because the database is the
 * source of truth and a counter that drifts from it would be worse than no
 * counter at all.
 */

import type { Database } from '../../database/src/client.ts';

type Labels = Record<string, string>;

interface Sample {
  value: number;
  labels: Labels;
}

/** Escape a label value per the exposition format. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

export class Counter {
  #samples = new Map<string, Sample>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = renderLabels(labels);
    const existing = this.#samples.get(key);
    if (existing) existing.value += by;
    else this.#samples.set(key, { value: by, labels });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, sample] of this.#samples) {
      lines.push(`${this.name}${key} ${sample.value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  #samples = new Map<string, Sample>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.#samples.set(renderLabels(labels), { value, labels });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, sample] of this.#samples) {
      lines.push(`${this.name}${key} ${sample.value}`);
    }
    return lines.join('\n');
  }
}

/** Latency buckets in milliseconds, spanning a fast query to a stuck request. */
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

export class Histogram {
  #buckets: number[];
  #counts = new Map<string, { counts: number[]; sum: number; total: number; labels: Labels }>();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = renderLabels(labels);
    let entry = this.#counts.get(key);
    if (!entry) {
      entry = { counts: new Array(this.#buckets.length).fill(0), sum: 0, total: 0, labels };
      this.#counts.set(key, entry);
    }
    entry.sum += value;
    entry.total += 1;
    for (let i = 0; i < this.#buckets.length; i++) {
      if (value <= (this.#buckets[i] as number)) entry.counts[i] = (entry.counts[i] as number) + 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.#counts) {
      const inner = key === '' ? '' : key.slice(1, -1);
      const withLe = (le: string) => `{${inner ? `${inner},` : ''}le="${le}"}`;
      for (let i = 0; i < this.#buckets.length; i++) {
        lines.push(`${this.name}_bucket${withLe(String(this.#buckets[i]))} ${entry.counts[i]}`);
      }
      lines.push(`${this.name}_bucket${withLe('+Inf')} ${entry.total}`);
      lines.push(`${this.name}_sum${key} ${entry.sum}`);
      lines.push(`${this.name}_count${key} ${entry.total}`);
    }
    return lines.join('\n');
  }
}

/** The process-wide registry. */
export const metrics = {
  httpRequests: new Counter('gram_http_requests_total', 'HTTP requests by method, route and status'),
  httpDuration: new Histogram('gram_http_request_duration_ms', 'HTTP request duration in milliseconds'),
  paymentsVerified: new Counter('gram_payments_verified_total', 'Payments verified'),
  paymentsRejected: new Counter('gram_payments_rejected_total', 'Payments rejected, by reason'),
  payoutsSettled: new Counter('gram_payouts_settled_total', 'Payouts confirmed on chain'),
  payoutsFailed: new Counter('gram_payouts_failed_total', 'Payouts that failed definitively'),
  webhooksDelivered: new Counter('gram_webhooks_delivered_total', 'Merchant webhook deliveries, by outcome'),
  rateLimited: new Counter('gram_rate_limited_total', 'Requests refused by the rate limiter'),
};

/**
 * Render the full exposition, combining in-process counters with figures read
 * live from the database.
 *
 * The database figures are the ones an operator actually pages on — a growing
 * WAITING_LIQUIDITY queue means the treasury needs funding, and an unknown
 * payout means money whose fate nobody knows.
 */
export async function renderMetrics(db: Database): Promise<string> {
  const payoutQueue = new Gauge('gram_payouts_by_status', 'Payouts currently in each status');
  const openExceptions = new Gauge('gram_reconciliation_exceptions_open', 'Open reconciliation exceptions by severity');
  const treasury = new Gauge('gram_treasury_balance_nanogram', 'Confirmed treasury balance in nanogram');
  const holds = new Gauge('gram_payment_holds_active', 'Payments currently held, by source');
  const frozen = new Gauge('gram_financial_freeze', '1 when the platform is financially frozen');
  const oldestUnknown = new Gauge('gram_oldest_unknown_payout_seconds', 'Age of the oldest UNKNOWN payout');

  const [statuses, exceptions, treasuryRows, holdRows, freeze, unknown] = await Promise.all([
    db.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*)::text AS count FROM finance.payouts GROUP BY status',
    ),
    db.query<{ severity: string; count: string }>(
      `SELECT severity, COUNT(*)::text AS count FROM system.reconciliation_exceptions
        WHERE status <> 'RESOLVED' GROUP BY severity`,
    ),
    db.query<{ asset: string; balance: string }>(
      'SELECT asset, confirmed_balance_atomic::text AS balance FROM finance.treasury_accounts',
    ),
    db.query<{ source: string; count: string }>(
      `SELECT source, COUNT(*)::text AS count FROM finance.payment_holds
        WHERE status = 'ACTIVE' GROUP BY source`,
    ),
    db.query<{ frozen: boolean }>(
      'SELECT financial_freeze AS frozen FROM system.platform_state WHERE id = TRUE',
    ),
    db.query<{ seconds: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(updated_at)))::text AS seconds
         FROM finance.payouts WHERE status = 'UNKNOWN'`,
    ),
  ]);

  for (const row of statuses.rows) payoutQueue.set(Number(row.count), { status: row.status });
  for (const row of exceptions.rows) openExceptions.set(Number(row.count), { severity: row.severity });
  for (const row of treasuryRows.rows) treasury.set(Number(row.balance), { asset: row.asset });
  for (const row of holdRows.rows) holds.set(Number(row.count), { source: row.source });
  frozen.set(freeze.rows[0]?.frozen ? 1 : 0);
  oldestUnknown.set(Number(unknown.rows[0]?.seconds ?? 0));

  return (
    [
      metrics.httpRequests,
      metrics.httpDuration,
      metrics.paymentsVerified,
      metrics.paymentsRejected,
      metrics.payoutsSettled,
      metrics.payoutsFailed,
      metrics.webhooksDelivered,
      metrics.rateLimited,
      payoutQueue,
      openExceptions,
      treasury,
      holds,
      frozen,
      oldestUnknown,
    ]
      .map((m) => m.render())
      .join('\n\n') + '\n'
  );
}

/**
 * Collapse a path into a low-cardinality route label.
 *
 * `/v1/invoices/<uuid>` must become `/v1/invoices/:id`, or every invoice id
 * becomes its own time series and the metrics backend falls over.
 */
export function routeLabel(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}
