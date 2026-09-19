/**
 * packages/errors — a single typed error hierarchy.
 * SPEC 117.28: base-error / financial / auth / integration / payout / error-codes.
 */

export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTH'
  | 'FINANCIAL'
  | 'STATE'
  | 'INTEGRATION'
  | 'PAYOUT'
  | 'SECURITY'
  | 'CONFIG'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export interface AppErrorOptions {
  /** Whether the caller may safely retry the exact same request. */
  retryable?: boolean;
  /** HTTP status to surface at the edge. */
  httpStatus?: number;
  /** Non-sensitive structured context for logs and audit. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    category: ErrorCategory,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? defaultStatus(category);
    this.details = options.details ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * Safe body for an API response. SPEC: internal details and provider secrets
   * must never leak to a merchant or customer.
   */
  toPublicJSON(): { error: { code: string; message: string; retryable: boolean } } {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

function defaultStatus(category: ErrorCategory): number {
  switch (category) {
    case 'VALIDATION':
      return 400;
    case 'AUTH':
      return 401;
    case 'SECURITY':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'STATE':
      return 409;
    case 'FINANCIAL':
    case 'PAYOUT':
      return 422;
    case 'INTEGRATION':
      return 502;
    case 'CONFIG':
    case 'INTERNAL':
      return 500;
  }
}

export class ValidationError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 'VALIDATION', message, { details });
  }
}

export class AuthError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 'AUTH', message, { details });
  }
}

export class SecurityError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 'SECURITY', message, { details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', 'NOT_FOUND', `${resource} not found`, { details: { resource, id } });
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 'CONFLICT', message, { details });
  }
}

/** Invariant breach in the ledger or balance model. Never retryable. */
export class FinancialError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 'FINANCIAL', message, { details, retryable: false });
  }
}

/** Illegal state-machine transition (SPEC 103951: rows_affected = 0). */
export class StateTransitionError extends AppError {
  constructor(entity: string, from: string | null, to: string) {
    super('INVALID_STATE_TRANSITION', 'STATE', `${entity}: ${from ?? 'null'} -> ${to} is not allowed`, {
      details: { entity, from, to },
    });
  }
}

export class IntegrationError extends AppError {
  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(code, 'INTEGRATION', message, { retryable: true, ...options });
  }
}

export class PayoutError extends AppError {
  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(code, 'PAYOUT', message, options);
  }
}

export class ConfigError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 'CONFIG', message, { details });
  }
}

/** Canonical codes referenced by the spec and by tests. */
export const ErrorCodes = {
  // financial
  LEDGER_UNBALANCED: 'LEDGER_UNBALANCED',
  NEGATIVE_BALANCE: 'NEGATIVE_BALANCE',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DUPLICATE_OPERATION: 'DUPLICATE_OPERATION',
  REFUND_EXCEEDS_REFUNDABLE: 'REFUND_EXCEEDS_REFUNDABLE',
  // payment
  INVOICE_EXPIRED: 'INVOICE_EXPIRED',
  INVOICE_NOT_PAYABLE: 'INVOICE_NOT_PAYABLE',
  PAYMENT_NOT_VERIFIED: 'PAYMENT_NOT_VERIFIED',
  PROVIDER_STATUS_UNKNOWN: 'PROVIDER_STATUS_UNKNOWN',
  // release / payout
  NOT_YET_ELIGIBLE: 'NOT_YET_ELIGIBLE',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  WALLET_NOT_ACTIVE: 'WALLET_NOT_ACTIVE',
  RATE_QUOTE_EXPIRED: 'RATE_QUOTE_EXPIRED',
  PAYOUT_UNKNOWN_NO_BLIND_RETRY: 'PAYOUT_UNKNOWN_NO_BLIND_RETRY',
  // security
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  TIMESTAMP_OUT_OF_WINDOW: 'TIMESTAMP_OUT_OF_WINDOW',
  NONCE_REPLAYED: 'NONCE_REPLAYED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  // config
  FORBIDDEN_TREASURY_AUTOMATION: 'FORBIDDEN_TREASURY_AUTOMATION',
} as const;

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
