/**
 * Canonical TON Wallet V4R2 Transfer Message Builder.
 *
 * Strictly uses @ton/core for TL-B Cell serialization, canonical representation
 * hashing, and BoC (Bag of Cells) external message packaging.
 *
 * Zero custom byte serialization. Fully compliant with TON Wallet V4 contracts.
 */

import {
  beginCell,
  Address,
  internal,
  external,
  storeMessageRelaxed,
  storeMessage,
  type Cell,
} from '@ton/core';
import { createHash } from 'node:crypto';
import { ValidationError } from '../../errors/src/index.ts';

export interface TonTransferParams {
  walletAddress: string;
  destinationAddress: string;
  amountNanograms: bigint;
  seqno: number;
  validUntil: number;
  walletId?: number;
  sendMode?: number;
  bounce?: boolean;
  comment?: string;
}

export interface CanonicalTonSigningPayload {
  signingCell: Cell;
  digest: Uint8Array;
  digestHex: string;
  walletAddress: Address;
  destinationAddress: Address;
  seqno: number;
  validUntil: number;
  walletId: number;
  sendMode: number;
  comment?: string;
}

export interface AssembledSignedTonMessage {
  bocBase64: string;
  bocHex: string;
  signatureHex: string;
  signingReference: string;
  unsignedHash: string;
}

/** Default wallet ID for TON Wallet V4R2 (0x29a9a317 = 698983191) */
export const DEFAULT_WALLET_V4_ID = 698983191;

/** Send mode: PAY_GAS_SEPARATELY (1) + IGNORE_ACTION_ERRORS (2) = 3 */
export const DEFAULT_SEND_MODE = 3;

/**
 * Deterministically computes the full SHA-256 Intent Hash binding all transaction parameters.
 */
export function computeTonSigningIntentHash(params: {
  signerVersion?: string;
  network: string;
  asset: string;
  keyReference: string;
  walletId: number;
  fromAddress: string;
  destinationAddress: string;
  amountAtomic: string;
  seqno: number;
  validUntil: number;
  sendMode: number;
  bounce: boolean;
  comment: string;
  unsignedHash: string;
}): string {
  const payload = {
    signerVersion: params.signerVersion ?? '1.0',
    network: params.network,
    asset: params.asset,
    keyReference: params.keyReference,
    walletId: params.walletId,
    fromAddress: params.fromAddress,
    destinationAddress: params.destinationAddress,
    amountAtomic: params.amountAtomic,
    seqno: params.seqno,
    validUntil: params.validUntil,
    sendMode: params.sendMode,
    bounce: params.bounce,
    comment: params.comment,
    unsignedHash: params.unsignedHash,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Builds the canonical Cell tree for a TON Wallet V4R2 transfer
 * and extracts the exact 32-byte representation hash that Ed25519 signs.
 */
export function buildCanonicalTonSigningPayload(params: TonTransferParams): CanonicalTonSigningPayload {
  if (params.amountNanograms <= 0n) {
    throw new ValidationError('INVALID_TON_AMOUNT', 'Transfer amount in nanograms must be positive');
  }

  if (params.seqno < 0 || !Number.isInteger(params.seqno)) {
    throw new ValidationError('INVALID_TON_SEQNO', 'TON seqno must be a non-negative integer');
  }

  let walletAddr: Address;
  let destAddr: Address;
  try {
    walletAddr = Address.parse(params.walletAddress);
  } catch (e) {
    throw new ValidationError('INVALID_TON_WALLET_ADDRESS', `Invalid source wallet address: ${params.walletAddress}`);
  }

  try {
    destAddr = Address.parse(params.destinationAddress);
  } catch (e) {
    throw new ValidationError('INVALID_TON_DESTINATION_ADDRESS', `Invalid destination address: ${params.destinationAddress}`);
  }

  const walletId = params.walletId ?? DEFAULT_WALLET_V4_ID;
  const sendMode = params.sendMode ?? DEFAULT_SEND_MODE;

  // 1. Build canonical internal message
  const intMsg = internal({
    to: destAddr,
    value: params.amountNanograms,
    bounce: params.bounce ?? false,
    body: params.comment ? params.comment : undefined,
  });

  // 2. Build canonical Wallet V4 signing cell
  // Structure: wallet_id (32) + valid_until (32) + seqno (32) + op (8 = 0) + send_mode (8) + ref(internal_message)
  const signingCell = beginCell()
    .storeUint(walletId, 32)
    .storeUint(params.validUntil, 32)
    .storeUint(params.seqno, 32)
    .storeUint(0, 8) // op = 0 (simple transfer)
    .storeUint(sendMode, 8)
    .storeRef(beginCell().store(storeMessageRelaxed(intMsg)).endCell())
    .endCell();

  // 3. Extract 32-byte canonical representation hash
  const hashBuffer = signingCell.hash();
  const digest = new Uint8Array(hashBuffer);

  return {
    signingCell,
    digest,
    digestHex: hashBuffer.toString('hex'),
    walletAddress: walletAddr,
    destinationAddress: destAddr,
    seqno: params.seqno,
    validUntil: params.validUntil,
    walletId,
    sendMode,
    comment: params.comment,
  };
}

/**
 * Packages the 64-byte Ed25519 signature and the signing cell into
 * a canonical external message BoC ready for broadcast to the TON network.
 */
export function assembleSignedTonExternalMessage(
  canonical: CanonicalTonSigningPayload,
  signature: Uint8Array | Buffer,
): AssembledSignedTonMessage {
  const sigBuffer = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  if (sigBuffer.length !== 64) {
    throw new ValidationError('INVALID_SIGNATURE_LENGTH', `Ed25519 signature must be 64 bytes, got ${sigBuffer.length}`);
  }

  // Combine signature and signing cell slice into external message body
  const bodyCell = beginCell()
    .storeBuffer(sigBuffer)
    .storeSlice(canonical.signingCell.beginParse())
    .endCell();

  // Construct complete external message
  const extMessage = external({
    to: canonical.walletAddress,
    body: bodyCell,
  });

  // Serialize to BoC
  const bocBuffer = beginCell().store(storeMessage(extMessage)).endCell().toBoc();
  const signatureHex = sigBuffer.toString('hex');
  const bocBase64 = bocBuffer.toString('base64');
  const bocHex = bocBuffer.toString('hex');

  // Prefix with ton-boc: so downstream TonAdapter can unpack the serialized BoC directly
  const signingReference = `ton-boc:${bocBase64}`;

  return {
    bocBase64,
    bocHex,
    signatureHex,
    signingReference,
    unsignedHash: canonical.digestHex,
  };
}
