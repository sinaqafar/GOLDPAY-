/**
 * BlockchainPayoutPort — SPEC 103781: Payout Core -> BlockchainPayoutPort -> TONAdapter.
 * The domain never imports a TON SDK directly (SPEC 103718).
 */

export interface SendTransferRequest {
  /** Deterministic key so an adapter-level retry cannot double-send. */
  idempotencyKey: string;
  to: string;
  amountAtomic: bigint;
  network: string;
}

export interface BroadcastResult {
  /**
   * ACCEPTED  the network accepted the transaction
   * REJECTED  definitively not sent (safe to return funds)
   * UNKNOWN   indeterminate — must go to reconciliation, never a blind retry
   */
  status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  txHash?: string;
  error?: string;
  raw?: Record<string, unknown>;
}

export interface TransferStatusRequest {
  idempotencyKey: string;
  txHash: string | null;
  to: string;
  amountAtomic: bigint;
}

export interface TransferStatus {
  state: 'CONFIRMED' | 'PENDING' | 'NOT_FOUND' | 'FAILED';
  txHash?: string;
  confirmations?: number;
  onChainAmountAtomic?: bigint;
}

export interface BlockchainPayoutPort {
  send(request: SendTransferRequest): Promise<BroadcastResult>;
  getTransferStatus(request: TransferStatusRequest): Promise<TransferStatus>;
  /** Confirmed on-chain balance of the treasury wallet, in atomic units. */
  getBalance(address: string): Promise<bigint>;
  /** Address format validation for the configured network. */
  isValidAddress(address: string, network: string): boolean;
}
