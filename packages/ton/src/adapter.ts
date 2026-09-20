/**
 * TON adapter for NATIVE GRAM payouts.
 *
 * GRAM is the native currency of The Open Network — Toncoin was renamed to
 * Gram on 2026-06-15 (ticker only; addresses, balances and history unchanged).
 * A transfer is therefore a plain internal message carrying value: there is no
 * jetton master, no token contract, no jetton wallet, and network fees are
 * paid in GRAM itself. Amounts are in nanogram (9 decimals).
 *
 * Official TonCenter v3 external message broadcast:
 * POST /api/v3/message
 * Request Body: { "boc": "<base64_serialized_boc>" }
 * Response: { "@type": "ok", "message_hash": "<hash>" }
 *
 * SPEC 124.168: NO CHAIN CONFIRMATION -> NO SETTLED.
 * SPEC 124.170: an ambiguous send returns UNKNOWN, never a silent retry.
 *
 * Signing keys are never held here: the adapter receives signed BoC from the SignerPort
 * boundary where KMS/HSM handles key isolation.
 */

import type {
  BlockchainPayoutPort,
  SendTransferRequest,
  BroadcastResult,
  TransferStatusRequest,
  TransferStatus,
} from '../../core/src/ports/blockchain.ts';
import { IntegrationError } from '../../errors/src/index.ts';
import type { TonConfig } from '../../config/src/index.ts';

/**
 * TON addresses: 48-char base64url (EQ.../UQ...) or raw `workchain:hex64`.
 */
export function isValidTonAddress(address: string): boolean {
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(address)) return true;
  if (/^[A-Za-z0-9_-]{48}$/.test(address)) {
    // Guard against the common mistake of pasting an EVM/TRON address.
    return !address.startsWith('0x') && !address.startsWith('T');
  }
  return false;
}

export class TonAdapter implements BlockchainPayoutPort {
  #config: TonConfig;

  constructor(config: TonConfig) {
    this.#config = config;
  }

  isValidAddress(address: string, network: string): boolean {
    if (network !== this.#config.network) return false;
    return isValidTonAddress(address);
  }

  async send(request: SendTransferRequest): Promise<BroadcastResult> {
    // SPEC 97.114 — wrong-network guard. Config drift must never reach the chain.
    if (this.#config.gramAsset !== 'GRAM') {
      return { status: 'REJECTED', error: 'INVALID_SETTLEMENT_ASSET' };
    }
    if (request.network !== this.#config.network) {
      return { status: 'REJECTED', error: 'NETWORK_MISMATCH' };
    }
    if (!this.isValidAddress(request.to, request.network)) {
      return { status: 'REJECTED', error: 'INVALID_DESTINATION_ADDRESS' };
    }
    if (request.amountAtomic <= 0n) {
      return { status: 'REJECTED', error: 'NON_POSITIVE_AMOUNT' };
    }

    // Before sending we check whether this exact idempotency key already went
    // out: a crash between broadcast and DB write must not double-send.
    const existing = await this.#lookupByKey(request.idempotencyKey);
    if (existing) {
      return { status: 'ACCEPTED', txHash: existing, raw: { deduplicated: true } };
    }

    const boc = request.signedBoc ||
      (request.signingReference?.startsWith('ton-boc:') ? request.signingReference.slice('ton-boc:'.length) : null);

    try {
      // Official TonCenter API v3 standard broadcast
      const body = boc
        ? JSON.stringify({ boc })
        : JSON.stringify({
            idempotency_key: request.idempotencyKey,
            from: this.#config.payoutWalletAddress,
            to: request.to,
            value: request.amountAtomic.toString(),
            asset: this.#config.gramAsset,
            decimals: this.#config.gramDecimals,
            send_mode: 'PAY_GAS_SEPARATELY',
            bounce: false,
            signer_reference: request.signingReference ?? this.#config.signerReference,
          });

      const res = await this.#rpc('/api/v3/message', {
        method: 'POST',
        body,
      });

      const hash =
        typeof res['message_hash'] === 'string'
          ? res['message_hash']
          : typeof res['hash'] === 'string'
            ? res['hash']
            : typeof res['result'] === 'string'
              ? res['result']
              : null;

      if (!hash) {
        // Accepted-but-unidentifiable is indeterminate, not a success.
        return { status: 'UNKNOWN', error: 'NO_TX_HASH_RETURNED', raw: res };
      }
      return { status: 'ACCEPTED', txHash: hash, raw: res };
    } catch (e) {
      if (e instanceof IntegrationError && e.details?.['status'] === 400) {
        // A 400 is a definite rejection: the network never accepted it.
        return { status: 'REJECTED', error: e.message };
      }
      // Timeouts and 5xx are ambiguous.
      return { status: 'UNKNOWN', error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getTransferStatus(request: TransferStatusRequest): Promise<TransferStatus> {
    // Prefer the hash; fall back to scanning outgoing transfers for the key.
    if (request.txHash) {
      const res = await this.#rpc(
        `/api/v3/transactions?hash=${encodeURIComponent(request.txHash)}`,
        { method: 'GET' },
      );
      const txs = Array.isArray(res['transactions']) ? (res['transactions'] as unknown[]) : [];
      const tx = txs[0] as Record<string, unknown> | undefined;
      if (!tx) return { state: 'NOT_FOUND' };

      const success = tx['success'] === true || tx['description'] === 'ok';
      const confirmations = typeof tx['mc_block_seqno'] === 'number' ? 1 : 0;
      if (!success) return { state: 'FAILED', txHash: request.txHash };
      if (confirmations < this.#config.minConfirmations) {
        return { state: 'PENDING', txHash: request.txHash, confirmations };
      }
      return {
        state: 'CONFIRMED',
        txHash: request.txHash,
        confirmations,
        onChainAmountAtomic: parseAtomic(tx['amount']),
        onChainDestination:
          typeof tx['destination'] === 'string'
            ? tx['destination']
            : typeof tx['account'] === 'string'
              ? tx['account']
              : undefined,
        networkFeeAtomic: parseAtomic(tx['total_fees'] ?? tx['fee']),
      };
    }

    const found = await this.#lookupByKey(request.idempotencyKey);
    if (!found) return { state: 'NOT_FOUND' };
    return this.getTransferStatus({ ...request, txHash: found });
  }

  /**
   * Current on-chain sequence number (seqno) of a wallet contract.
   */
  async getOnChainSeqno(address: string): Promise<number> {
    try {
      const res = await this.#rpc(
        `/api/v3/wallet?address=${encodeURIComponent(address)}`,
        { method: 'GET' },
      );
      if (typeof res['seqno'] === 'number') {
        return res['seqno'];
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Native GRAM balance of an account. No jetton wallet lookup is involved:
   * the balance lives on the account state itself.
   */
  async getBalance(address: string): Promise<bigint> {
    const res = await this.#rpc(
      `/api/v3/accountStates?address=${encodeURIComponent(address)}`,
      { method: 'GET' },
    );
    const accounts = Array.isArray(res['accounts']) ? (res['accounts'] as unknown[]) : [];
    const account = accounts[0] as Record<string, unknown> | undefined;
    if (!account) return 0n;
    return parseAtomic(account['balance']) ?? 0n;
  }

  /** Look up a previously broadcast transfer by our idempotency key. */
  async #lookupByKey(key: string): Promise<string | null> {
    try {
      const res = await this.#rpc(
        `/api/v3/message?idempotency_key=${encodeURIComponent(key)}`,
        { method: 'GET' },
      );
      const hash = res['hash'] ?? res['message_hash'];
      return typeof hash === 'string' ? hash : null;
    } catch {
      // A failed lookup must not be read as "not sent".
      return null;
    }
  }

  async #rpc(path: string, init: { method: string; body?: string }): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const res = await fetch(`${this.#config.endpoint}${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(this.#config.apiKey ? { 'X-API-Key': this.#config.apiKey } : {}),
        },
        body: init.body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new IntegrationError('TON_HTTP_ERROR', `TON endpoint returned ${res.status}`, {
          retryable: res.status >= 500 || res.status === 429,
          details: { status: res.status, body: text.slice(0, 500) },
        });
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      throw new IntegrationError('TON_UNREACHABLE', 'TON endpoint request failed', {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseAtomic(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

/**
 * In-memory chain used by tests and sandbox mode.
 * It models the states the real adapter can return, including UNKNOWN.
 */
export class InMemoryTonAdapter implements BlockchainPayoutPort {
  #sent = new Map<
    string,
    { txHash: string; to: string; amount: bigint; confirmed: boolean; networkFee: bigint }
  >();
  /** Simulated gas, so settlement accounting can be exercised. */
  #networkFee = 1_000_000n;
  #balances = new Map<string, bigint>();
  #walletSeqnos = new Map<string, number>();
  #nextOutcome: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' = 'ACCEPTED';
  #autoConfirm: boolean;

  constructor(options: { autoConfirm?: boolean } = {}) {
    this.#autoConfirm = options.autoConfirm ?? true;
  }

  setWalletSeqno(address: string, seqno: number): void {
    this.#walletSeqnos.set(address, seqno);
  }

  async getOnChainSeqno(address: string): Promise<number> {
    return this.#walletSeqnos.get(address) ?? 0;
  }

  setNextOutcome(outcome: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN'): void {
    this.#nextOutcome = outcome;
  }

  setBalance(address: string, amount: bigint): void {
    this.#balances.set(address, amount);
  }

  /** Control the simulated network fee. */
  setNetworkFee(fee: bigint): void {
    this.#networkFee = fee;
  }

  isValidAddress(address: string): boolean {
    return isValidTonAddress(address);
  }

  async send(request: SendTransferRequest): Promise<BroadcastResult> {
    const existing = this.#sent.get(request.idempotencyKey);
    if (existing) return { status: 'ACCEPTED', txHash: existing.txHash, raw: { deduplicated: true } };

    const outcome = this.#nextOutcome;
    this.#nextOutcome = 'ACCEPTED';

    if (outcome === 'REJECTED') return { status: 'REJECTED', error: 'SIMULATED_REJECTION' };

    const txHash = `tx_${Buffer.from(request.idempotencyKey).toString('hex').slice(0, 48)}`;
    this.#sent.set(request.idempotencyKey, {
      txHash,
      to: request.to,
      amount: request.amountAtomic,
      confirmed: this.#autoConfirm,
      networkFee: this.#networkFee,
    });
    if (outcome === 'UNKNOWN') return { status: 'UNKNOWN', error: 'SIMULATED_TIMEOUT' };
    return { status: 'ACCEPTED', txHash, raw: { simulated: true } };
  }

  async getTransferStatus(request: TransferStatusRequest): Promise<TransferStatus> {
    const record = this.#sent.get(request.idempotencyKey);
    if (!record) return { state: 'NOT_FOUND' };
    if (!record.confirmed) return { state: 'PENDING', txHash: record.txHash, confirmations: 0 };
    return {
      state: 'CONFIRMED',
      txHash: record.txHash,
      confirmations: 10,
      onChainAmountAtomic: record.amount,
      onChainDestination: record.to,
      networkFeeAtomic: record.networkFee,
    };
  }

  async getBalance(address: string): Promise<bigint> {
    return this.#balances.get(address) ?? 0n;
  }

  confirmAll(): void {
    for (const record of this.#sent.values()) record.confirmed = true;
  }
}
