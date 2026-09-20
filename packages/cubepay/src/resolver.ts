/**
 * CubePay Provider Resolver & Mode Switcher.
 *
 * Central router that manages the active CubePay integration mode (VIP vs STANDARD).
 *
 * Requirements:
 * - VIP is the default production mode.
 * - Exactly ONE mode is active for new invoices (no simultaneous/random routing).
 * - Existing invoices are resolved strictly by their snapshotted provider_mode.
 * - Runtime mode switching is atomic, versioned, and recorded in audit.audit_logs.
 * - Failed switch leaves previous active mode completely unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/src/client.ts';
import type { Config, CubePayMode } from '../../config/src/index.ts';
import type { CubePayProviderPort } from './types.ts';
import { CubePayVipAdapter } from './vip-adapter.ts';
import { CubePayStandardAdapter } from './standard-adapter.ts';
import { ValidationError, IntegrationError } from '../../errors/src/index.ts';

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
}

export class CubePayProviderResolver {
  #activeMode: CubePayMode;
  #version = 1;
  #vipAdapter: CubePayVipAdapter;
  #standardAdapter: CubePayStandardAdapter;
  #switchLock = Promise.resolve();

  constructor(config: Config) {
    this.#activeMode = config.cubepay.activeMode ?? 'VIP';
    this.#vipAdapter = new CubePayVipAdapter(config.cubepay.vip);
    this.#standardAdapter = new CubePayStandardAdapter(config.cubepay.standard);
  }

  /** Current active mode for new invoices. */
  getActiveMode(): CubePayMode {
    return this.#activeMode;
  }

  /** Current configuration version. */
  getVersion(): number {
    return this.#version;
  }

  /** Resolve active adapter for creating new invoices. */
  resolveActive(): CubePayProviderPort {
    return this.resolveForMode(this.#activeMode);
  }

  /** Resolve adapter matching the immutable snapshot of an existing invoice. */
  resolveForInvoice(invoice: { provider_mode?: string | null; providerMode?: string | null }): CubePayProviderPort {
    const mode = invoice.provider_mode ?? invoice.providerMode ?? this.#activeMode;
    return this.resolveForMode(mode);
  }

  /** Resolve adapter matching the immutable snapshot of an existing invoice. */
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
   * Atomic, audited mode switch.
   *
   * Transitions active mode (e.g. VIP -> STANDARD or STANDARD -> VIP), increments version,
   * and persists an immutable audit log row in audit.audit_logs.
   */
  async switchMode(newMode: CubePayMode, options: SwitchModeOptions): Promise<SwitchModeResult> {
    const prevLock = this.#switchLock;
    let resolveLock!: () => void;
    this.#switchLock = new Promise<void>((r) => {
      resolveLock = r;
    });

    try {
      await prevLock;

      if (newMode !== 'VIP' && newMode !== 'STANDARD') {
        throw new ValidationError(
          'INVALID_CUBEPAY_MODE',
          `Target mode must be VIP or STANDARD, got ${String(newMode)}`,
        );
      }

      const previousMode = this.#activeMode;
      if (previousMode === newMode) {
        return {
          previousMode,
          newMode,
          version: this.#version,
          switchedAt: new Date(),
        };
      }

      const newVersion = this.#version + 1;
      const switchedAt = new Date();

      if (options.db) {
        await options.db.query(
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
              new_mode: newMode,
              configuration_version: newVersion,
              actor: options.actor,
              timestamp: switchedAt.toISOString(),
            }),
            switchedAt.toISOString(),
          ],
        );
      }

      // State is mutated only after successful DB persistence
      this.#activeMode = newMode;
      this.#version = newVersion;

      return {
        previousMode,
        newMode,
        version: newVersion,
        switchedAt,
      };
    } finally {
      resolveLock();
    }
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
