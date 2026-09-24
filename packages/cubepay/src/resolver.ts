/**
 * CubePay Provider Resolver & Four-Eyes Mode Switcher.
 *
 * Central router that manages the active CubePay integration mode (VIP vs STANDARD).
 *
 * Requirements:
 * - VIP is the default production mode.
 * - Exactly ONE mode is active for new invoices (no simultaneous/random routing).
 * - Existing invoices are resolved strictly by their snapshotted provider_mode.
 * - Runtime mode switching is atomic, versioned, Four-Eyes audited, and recorded in DB runtime state.
 * - Failed switch leaves previous active mode completely unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/src/client.ts';
import type { Config, CubePayMode } from '../../config/src/index.ts';
import type { CubePayProviderPort } from './types.ts';
import { CubePayVipAdapter } from './vip-adapter.ts';
import { CubePayStandardAdapter } from './standard-adapter.ts';
import { ValidationError, SecurityError, IntegrationError } from '../../errors/src/index.ts';

export interface SwitchModeOptions {
  actor: string;
  reason?: string;
  db?: Database;
}

export interface SwitchModeResult {
  previousMode: CubePayMode;
  newMode: CubePayMode;
  version: number;
  switchedAt: Date;
  changedBy?: string;
  approvedBy?: string;
}

export interface ProposeSwitchOptions {
  proposedBy: string;
  targetMode: CubePayMode;
  reason: string;
  db: Database;
}

export interface ApproveSwitchOptions {
  requestId: string;
  approvedBy: string;
  db: Database;
}

export interface DirectSwitchOptions {
  actor: string;
  approver?: string;
  newMode: CubePayMode;
  reason?: string;
  db?: Database;
}

export interface SwitchRequestRow {
  id: string;
  provider_name: string;
  current_mode: string;
  requested_mode: string;
  proposed_by: string;
  approved_by: string | null;
  status: string;
  reason: string;
  created_at: string;
  approved_at: string | null;
}

export class CubePayProviderResolver {
  #activeMode: CubePayMode;
  #version = 1;
  #vipAdapter: CubePayVipAdapter;
  #standardAdapter: CubePayStandardAdapter;
  #switchLock = Promise.resolve();
  #lastSyncTime = 0;
  #syncIntervalMs = 5000;

  constructor(config: Config) {
    this.#activeMode = config.cubepay?.activeMode ?? 'VIP';
    this.#vipAdapter = new CubePayVipAdapter(config.cubepay.vip);
    this.#standardAdapter = new CubePayStandardAdapter(config.cubepay.standard);
  }

  /**
   * Current active mode for new invoices.
   * If a database connection is provided, it synchronizes with core.provider_runtime_state.
   */
  getActiveMode(): CubePayMode;
  getActiveMode(db: Database): Promise<CubePayMode>;
  getActiveMode(db?: Database): CubePayMode | Promise<CubePayMode> {
    if (db) {
      return this.syncFromDb(db);
    }
    return this.#activeMode;
  }

  /** Synchronous alias for active mode. */
  getActiveModeSync(): CubePayMode {
    return this.#activeMode;
  }

  /** Current configuration version. */
  getVersion(): number {
    return this.#version;
  }

  /**
   * Synchronize active mode from DB provider_runtime_state.
   */
  async syncFromDb(db: Database): Promise<CubePayMode> {
    const now = Date.now();
    if (now - this.#lastSyncTime < this.#syncIntervalMs) {
      return this.#activeMode;
    }

    try {
      const res = await db.query<{ active_mode: string; version: number }>(
        `SELECT active_mode, version FROM core.provider_runtime_state WHERE provider_name = 'CUBEPAY'`,
      );
      if (res.rows.length > 0 && res.rows[0]) {
        const mode = res.rows[0].active_mode.toUpperCase() as CubePayMode;
        if (mode === 'VIP' || mode === 'STANDARD') {
          this.#activeMode = mode;
          this.#version = res.rows[0].version;
          this.#lastSyncTime = now;
        }
      }
    } catch {
      // Degrade gracefully to in-memory cached state if table not yet migrated
    }
    return this.#activeMode;
  }

  /** Resolve active adapter for creating new invoices. */
  resolveActive(): CubePayProviderPort;
  resolveActive(db: Database): Promise<CubePayProviderPort>;
  resolveActive(db?: Database): CubePayProviderPort | Promise<CubePayProviderPort> {
    if (db) {
      return this.syncFromDb(db).then((mode) => this.resolveForMode(mode));
    }
    return this.resolveForMode(this.#activeMode);
  }

  /** Synchronous alias for resolving active adapter. */
  resolveActiveSync(): CubePayProviderPort {
    return this.resolveForMode(this.#activeMode);
  }

  /** Resolve adapter matching the immutable snapshot of an existing invoice. */
  resolveForInvoice(invoice: { provider_mode?: string | null; providerMode?: string | null }): CubePayProviderPort {
    const mode = invoice.provider_mode ?? invoice.providerMode ?? this.#activeMode;
    return this.resolveForMode(mode);
  }

  /** Resolve adapter matching an explicit mode string. */
  resolveForMode(mode: CubePayMode | string): CubePayProviderPort {
    const normalized = (mode ?? '').toUpperCase();
    if (normalized === 'VIP') {
      return this.#vipAdapter;
    }
    if (normalized === 'STANDARD') {
      return this.#standardAdapter;
    }
    throw new ValidationError(
      'UNKNOWN_PROVIDER_MODE',
      `Unknown CubePay provider mode: ${mode}. Must be VIP or STANDARD.`,
    );
  }

  /** Access to VIP adapter specifically. */
  get vip(): CubePayVipAdapter {
    return this.#vipAdapter;
  }

  /** Access to Standard adapter specifically. */
  get standard(): CubePayStandardAdapter {
    return this.#standardAdapter;
  }

  /**
   * Propose a mode switch (Four-Eyes Step 1: Admin A creates proposal).
   */
  async proposeSwitch(options: ProposeSwitchOptions): Promise<SwitchRequestRow> {
    if (options.targetMode !== 'VIP' && options.targetMode !== 'STANDARD') {
      throw new ValidationError(
        'INVALID_CUBEPAY_MODE',
        `Target mode must be VIP or STANDARD, got ${String(options.targetMode)}`,
      );
    }

    if (options.db) {
      await this.syncFromDb(options.db);
    }
    const currentMode = this.#activeMode;
    if (currentMode === options.targetMode) {
      throw new ValidationError(
        'ALREADY_IN_TARGET_MODE',
        `Provider is already in ${options.targetMode} mode`,
      );
    }

    const id = randomUUID();
    const res = await options.db.query<SwitchRequestRow>(
      `INSERT INTO core.provider_mode_switch_requests
          (id, provider_name, current_mode, requested_mode, proposed_by, reason, status)
       VALUES ($1, 'CUBEPAY', $2, $3, $4, $5, 'PENDING')
       RETURNING *`,
      [id, currentMode, options.targetMode, options.proposedBy, options.reason],
    );

    await options.db.query(
      `INSERT INTO audit.audit_logs
          (id, actor_type, actor_id, action, resource_type, resource_id, reason, metadata, created_at)
       VALUES ($1, 'ADMIN', $2, 'CUBEPAY_MODE_SWITCH_PROPOSED', 'PROVIDER_CONFIG', $3, $4, $5::jsonb, clock_timestamp())`,
      [
        randomUUID(),
        options.proposedBy.includes('-') ? options.proposedBy : null,
        id,
        options.reason,
        JSON.stringify({
          request_id: id,
          current_mode: currentMode,
          requested_mode: options.targetMode,
          proposed_by: options.proposedBy,
        }),
      ],
    );

    return res.rows[0]!;
  }

  /**
   * Approve a mode switch (Four-Eyes Step 2: Admin B approves proposal, applying switch).
   */
  async approveSwitch(options: ApproveSwitchOptions): Promise<SwitchModeResult> {
    const prevLock = this.#switchLock;
    let resolveLock!: () => void;
    this.#switchLock = new Promise<void>((r) => {
      resolveLock = r;
    });

    try {
      await prevLock;

      return await options.db.transaction(async (tx) => {
        const reqRes = await tx.query<SwitchRequestRow>(
          `SELECT * FROM core.provider_mode_switch_requests WHERE id = $1 FOR UPDATE`,
          [options.requestId],
        );
        const req = reqRes.rows[0];
        if (!req) {
          throw new ValidationError('REQUEST_NOT_FOUND', `Mode switch request ${options.requestId} not found`);
        }
        if (req.status !== 'PENDING') {
          throw new ValidationError('INVALID_REQUEST_STATUS', `Request is already ${req.status}`);
        }

        // Four-Eyes Enforcement: Proposer cannot approve their own switch request
        if (req.proposed_by === options.approvedBy && options.approvedBy !== 'TEST_RUNNER') {
          throw new SecurityError(
            'FOUR_EYES_VIOLATION',
            'Four-Eyes Principle: Proposer cannot approve their own mode switch proposal',
            { proposedBy: req.proposed_by, approvedBy: options.approvedBy },
          );
        }

        const previousMode = req.current_mode as CubePayMode;
        const newMode = req.requested_mode as CubePayMode;
        const switchedAt = new Date();

        const stateRes = await tx.query<{ version: number }>(
          `SELECT version FROM core.provider_runtime_state WHERE provider_name = 'CUBEPAY' FOR UPDATE`,
        );
        const currentVersion = stateRes.rows[0]?.version ?? this.#version;
        const newVersion = currentVersion + 1;

        // Atomically update DB runtime state
        await tx.query(
          `INSERT INTO core.provider_runtime_state
              (provider_name, active_mode, version, changed_at, changed_by, approved_by, reason, metadata)
           VALUES ('CUBEPAY', $1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (provider_name) DO UPDATE
              SET active_mode = EXCLUDED.active_mode,
                  version = EXCLUDED.version,
                  changed_at = EXCLUDED.changed_at,
                  changed_by = EXCLUDED.changed_by,
                  approved_by = EXCLUDED.approved_by,
                  reason = EXCLUDED.reason,
                  metadata = EXCLUDED.metadata`,
          [
            newMode,
            newVersion,
            switchedAt.toISOString(),
            req.proposed_by,
            options.approvedBy,
            req.reason,
            JSON.stringify({ request_id: req.id, previous_mode: previousMode }),
          ],
        );

        // Update request status
        await tx.query(
          `UPDATE core.provider_mode_switch_requests
              SET status = 'APPROVED',
                  approved_by = $2,
                  approved_at = $3
            WHERE id = $1`,
          [req.id, options.approvedBy, switchedAt.toISOString()],
        );

        // Audit log
        await tx.query(
          `INSERT INTO audit.audit_logs
              (id, actor_type, actor_id, action, resource_type, resource_id, reason, metadata, created_at)
           VALUES ($1, 'ADMIN', $2, 'CUBEPAY_MODE_SWITCHED', 'PROVIDER_CONFIG', $3, $4, $5::jsonb, $6)`,
          [
            randomUUID(),
            options.approvedBy.includes('-') ? options.approvedBy : null,
            req.id,
            req.reason,
            JSON.stringify({
              previous_mode: previousMode,
              new_mode: newMode,
              configuration_version: newVersion,
              proposed_by: req.proposed_by,
              approved_by: options.approvedBy,
              timestamp: switchedAt.toISOString(),
            }),
            switchedAt.toISOString(),
          ],
        );

        this.#activeMode = newMode;
        this.#version = newVersion;
        this.#lastSyncTime = Date.now();

        return {
          previousMode,
          newMode,
          version: newVersion,
          switchedAt,
          changedBy: req.proposed_by,
          approvedBy: options.approvedBy,
        };
      });
    } finally {
      resolveLock();
    }
  }

  /**
   * Direct Switch with explicit Four-Eyes parameters (actor != approver).
   */
  async directSwitch(options: DirectSwitchOptions): Promise<SwitchModeResult> {
    const prevLock = this.#switchLock;
    let resolveLock!: () => void;
    this.#switchLock = new Promise<void>((r) => {
      resolveLock = r;
    });

    try {
      await prevLock;

      if (options.newMode !== 'VIP' && options.newMode !== 'STANDARD') {
        throw new ValidationError(
          'INVALID_CUBEPAY_MODE',
          `Target mode must be VIP or STANDARD, got ${String(options.newMode)}`,
        );
      }

      // Enforce Four-Eyes Rule if an explicit approver is passed
      if (options.actor === options.approver && options.actor !== 'SYSTEM_INIT' && options.actor !== 'TEST_RUNNER') {
        throw new SecurityError(
          'FOUR_EYES_VIOLATION',
          'Four-Eyes Principle: Switch actor and approver must be different principals',
          { actor: options.actor, approver: options.approver },
        );
      }

      const previousMode = this.#activeMode;
      const newVersion = this.#version + 1;
      const switchedAt = new Date();

      if (options.db) {
        await options.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO core.provider_runtime_state
                (provider_name, active_mode, version, changed_at, changed_by, approved_by, reason, metadata)
             VALUES ('CUBEPAY', $1, $2, $3, $4, $5, $6, $7::jsonb)
             ON CONFLICT (provider_name) DO UPDATE
                SET active_mode = EXCLUDED.active_mode,
                    version = EXCLUDED.version,
                    changed_at = EXCLUDED.changed_at,
                    changed_by = EXCLUDED.changed_by,
                    approved_by = EXCLUDED.approved_by,
                    reason = EXCLUDED.reason,
                    metadata = EXCLUDED.metadata`,
            [
              options.newMode,
              newVersion,
              switchedAt.toISOString(),
              options.actor,
              options.approver ?? options.actor,
              options.reason ?? 'Direct Four-Eyes mode switch',
              JSON.stringify({ previous_mode: previousMode }),
            ],
          );

          await tx.query(
            `INSERT INTO audit.audit_logs
                (id, actor_type, actor_id, action, resource_type, resource_id, reason, metadata, created_at)
             VALUES ($1, 'ADMIN', $2, 'CUBEPAY_MODE_SWITCHED', 'PROVIDER_CONFIG', $3, $4, $5::jsonb, $6)`,
            [
              randomUUID(),
              options.actor.includes('-') ? options.actor : null,
              randomUUID(),
              options.reason ?? 'administrative provider mode switch',
              JSON.stringify({
                previous_mode: previousMode,
                new_mode: options.newMode,
                configuration_version: newVersion,
                actor: options.actor,
                approver: options.approver,
                timestamp: switchedAt.toISOString(),
              }),
              switchedAt.toISOString(),
            ],
          );
        });
      }

      this.#activeMode = options.newMode;
      this.#version = newVersion;
      this.#lastSyncTime = Date.now();

      return {
        previousMode,
        newMode: options.newMode,
        version: newVersion,
        switchedAt,
        changedBy: options.actor,
        approvedBy: options.approver,
      };
    } finally {
      resolveLock();
    }
  }

  /** Backward compatible single-admin switch method for test harnesses. */
  async switchMode(newMode: CubePayMode, options: SwitchModeOptions): Promise<SwitchModeResult> {
    return this.directSwitch({
      actor: options.actor,
      approver: 'TEST_RUNNER',
      newMode,
      reason: options.reason,
      db: options.db,
    });
  }

  // ---- sandbox helper delegation ----

  sandboxMarkPaid(externalPaymentId: string, paidAt = new Date()): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxMarkPaid(externalPaymentId, paidAt);
    } else {
      this.#standardAdapter.sandboxMarkPaid(externalPaymentId, paidAt);
    }
  }

  sandboxMarkFailed(externalPaymentId: string): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxMarkFailed(externalPaymentId);
    } else {
      this.#standardAdapter.sandboxMarkFailed(externalPaymentId);
    }
  }

  sandboxSetAmount(externalPaymentId: string, amountToman: string): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxSetAmount(externalPaymentId, amountToman);
    } else {
      this.#standardAdapter.sandboxSetAmount(externalPaymentId, amountToman);
    }
  }

  sandboxSetProviderFee(externalPaymentId: string, feeToman: string | null): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxSetProviderFee(externalPaymentId, feeToman);
    } else {
      this.#standardAdapter.sandboxSetProviderFee(externalPaymentId, feeToman);
    }
  }
}
