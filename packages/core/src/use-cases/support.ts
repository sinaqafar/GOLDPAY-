/**
 * Support tickets — SPEC 2453/2454.
 *
 * Support can explain, investigate and link a question to the payment it is
 * about. It can never change what happened: SPEC 123.158 is explicit that
 * "SUPPORT CAN EXPLAIN. SUPPORT CAN INVESTIGATE. SUPPORT CANNOT INVENT OR
 * ALTER MONEY."
 *
 * Nothing in this module writes to the ledger, adjusts a balance or moves a
 * payout. It reads, records a conversation, and hands the financial decision
 * to the process that owns it.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../../database/src/client.ts';
import { ValidationError, NotFoundError, ConflictError } from '../../../errors/src/index.ts';

export type TicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_CUSTOMER'
  | 'WAITING_INTERNAL'
  | 'RESOLVED'
  | 'CLOSED';

export type TicketCategory =
  | 'PAYMENT'
  | 'PAYOUT'
  | 'WALLET'
  | 'REFUND'
  | 'API'
  | 'WEBHOOK'
  | 'INTEGRATION'
  | 'ACCOUNT'
  | 'SECURITY'
  | 'OTHER';

export const TICKET_CATEGORIES: readonly TicketCategory[] = [
  'PAYMENT', 'PAYOUT', 'WALLET', 'REFUND', 'API',
  'WEBHOOK', 'INTEGRATION', 'ACCOUNT', 'SECURITY', 'OTHER',
];

export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  WAITING_INTERNAL: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  // A resolved ticket can be reopened: the answer may not have worked.
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export function isTicketCategory(value: unknown): value is TicketCategory {
  return typeof value === 'string' && (TICKET_CATEGORIES as readonly string[]).includes(value);
}

export interface OpenTicketInput {
  merchantId: string;
  subject: string;
  body: string;
  category: TicketCategory;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  entityType?: 'PAYMENT' | 'PAYOUT' | 'INVOICE' | 'WALLET' | 'REFUND' | 'DISPUTE';
  entityId?: string;
  openedByType?: 'MERCHANT' | 'ADMIN' | 'SYSTEM';
  openedById?: string;
}

export async function openTicket(
  db: Database,
  input: OpenTicketInput,
): Promise<{ ticketId: string; reference: string }> {
  if (!input.subject.trim()) {
    throw new ValidationError('MISSING_SUBJECT', 'a subject is required');
  }
  if (!input.body.trim()) {
    throw new ValidationError('MISSING_BODY', 'a message is required');
  }
  if (!isTicketCategory(input.category)) {
    throw new ValidationError('INVALID_CATEGORY', `unknown category: ${String(input.category)}`);
  }

  return db.transaction(async (tx) => {
    // Cap the open tickets one merchant can hold, so a loop in an integration
    // cannot bury the support queue.
    const open = await tx.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM core.support_tickets
        WHERE merchant_id = $1 AND status IN ('OPEN','IN_PROGRESS','WAITING_INTERNAL')`,
      [input.merchantId],
    );
    if (Number(open.rows[0]?.count ?? '0') >= 20) {
      throw new ConflictError(
        'TOO_MANY_OPEN_TICKETS',
        'too many open tickets; please continue in an existing one',
      );
    }

    const seq = await tx.query<{ value: string }>(
      "SELECT nextval('core.support_ticket_seq')::text AS value",
    );
    const reference = `TKT-${String(seq.rows[0]?.value ?? '0').padStart(6, '0')}`;

    const ticketId = randomUUID();
    await tx.query(
      `INSERT INTO core.support_tickets
          (id, merchant_id, reference, subject, category, priority,
           entity_type, entity_id, opened_by_type, opened_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ticketId,
        input.merchantId,
        reference,
        input.subject.trim().slice(0, 200),
        input.category,
        input.priority ?? 'NORMAL',
        input.entityType ?? null,
        input.entityId ?? null,
        input.openedByType ?? 'MERCHANT',
        input.openedById ?? null,
      ],
    );

    await tx.query(
      `INSERT INTO core.support_messages (id, ticket_id, sender_type, sender_id, body)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        randomUUID(),
        ticketId,
        input.openedByType ?? 'MERCHANT',
        input.openedById ?? null,
        input.body.trim().slice(0, 5000),
      ],
    );

    return { ticketId, reference };
  });
}

export interface ReplyInput {
  ticketId: string;
  body: string;
  senderType: 'MERCHANT' | 'ADMIN' | 'SYSTEM';
  senderId?: string;
  /** Staff-only note. A merchant reply can never be internal. */
  internal?: boolean;
  /** Restricts to one merchant's ticket when a merchant is replying. */
  merchantId?: string;
}

export async function replyToTicket(db: Database, input: ReplyInput): Promise<{ messageId: string }> {
  if (!input.body.trim()) {
    throw new ValidationError('MISSING_BODY', 'a message is required');
  }
  if (input.internal && input.senderType === 'MERCHANT') {
    throw new ValidationError('INTERNAL_NOT_ALLOWED', 'a merchant cannot write an internal note');
  }

  return db.transaction(async (tx) => {
    const r = await tx.query<{ id: string; merchant_id: string; status: string }>(
      'SELECT id, merchant_id, status FROM core.support_tickets WHERE id = $1 FOR UPDATE',
      [input.ticketId],
    );
    const ticket = r.rows[0];
    if (!ticket) throw new NotFoundError('ticket', input.ticketId);

    // 404 rather than 403, so the endpoint cannot be used to discover that
    // another merchant's ticket exists.
    if (input.merchantId && ticket.merchant_id !== input.merchantId) {
      throw new NotFoundError('ticket', input.ticketId);
    }
    if (ticket.status === 'CLOSED') {
      throw new ConflictError('TICKET_CLOSED', 'this ticket is closed');
    }

    const messageId = randomUUID();
    await tx.query(
      `INSERT INTO core.support_messages (id, ticket_id, sender_type, sender_id, body, internal)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        messageId,
        input.ticketId,
        input.senderType,
        input.senderId ?? null,
        input.body.trim().slice(0, 5000),
        input.internal ?? false,
      ],
    );

    // Whose turn it is now. An internal note changes nothing: the customer is
    // still waiting on us.
    let nextStatus = ticket.status;
    if (!input.internal) {
      if (input.senderType === 'MERCHANT') {
        nextStatus = ticket.status === 'RESOLVED' ? 'IN_PROGRESS' : 'WAITING_INTERNAL';
      } else if (input.senderType === 'ADMIN') {
        nextStatus = 'WAITING_CUSTOMER';
      }
    }

    await tx.query(
      `UPDATE core.support_tickets
          SET status = $2,
              updated_at = NOW(),
              first_replied_at = COALESCE(
                first_replied_at,
                CASE WHEN $3 THEN NOW() ELSE NULL END
              )
        WHERE id = $1`,
      [input.ticketId, nextStatus, input.senderType === 'ADMIN' && !input.internal],
    );

    return { messageId };
  });
}

export async function setTicketStatus(
  db: Database,
  params: { ticketId: string; status: TicketStatus; actorId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await tx.query<{ status: string }>(
      'SELECT status FROM core.support_tickets WHERE id = $1 FOR UPDATE',
      [params.ticketId],
    );
    const current = r.rows[0]?.status as TicketStatus | undefined;
    if (!current) throw new NotFoundError('ticket', params.ticketId);

    const allowed = TICKET_TRANSITIONS[current] ?? [];
    if (!allowed.includes(params.status)) {
      throw new ConflictError(
        'INVALID_TICKET_TRANSITION',
        `cannot move a ticket from ${current} to ${params.status}`,
      );
    }

    await tx.query(
      `UPDATE core.support_tickets
          SET status = $2,
              updated_at = NOW(),
              resolved_at = CASE WHEN $2 = 'RESOLVED' THEN NOW() ELSE resolved_at END,
              closed_at   = CASE WHEN $2 = 'CLOSED'   THEN NOW() ELSE closed_at END
        WHERE id = $1`,
      [params.ticketId, params.status],
    );
  });
}

/**
 * Read a ticket with its conversation.
 * `includeInternal` is false for merchants, so staff notes never leak.
 */
export async function getTicket(
  db: Database,
  params: { ticketId: string; merchantId?: string; includeInternal: boolean },
): Promise<Record<string, unknown>> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT id, merchant_id, reference, subject, category, priority, status,
            entity_type, entity_id, created_at, updated_at, resolved_at
       FROM core.support_tickets WHERE id = $1`,
    [params.ticketId],
  );
  const ticket = r.rows[0];
  if (!ticket) throw new NotFoundError('ticket', params.ticketId);
  if (params.merchantId && ticket['merchant_id'] !== params.merchantId) {
    throw new NotFoundError('ticket', params.ticketId);
  }

  const messages = await db.query<Record<string, unknown>>(
    `SELECT id, sender_type, body, internal, created_at
       FROM core.support_messages
      WHERE ticket_id = $1 AND ($2::boolean OR internal = FALSE)
      ORDER BY created_at ASC`,
    [params.ticketId, params.includeInternal],
  );

  return { ...ticket, messages: messages.rows };
}
