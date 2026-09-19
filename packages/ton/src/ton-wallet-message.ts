/**
 * Canonical TON Wallet Transfer Message Builder (Wallet V4R2 Standard).
 *
 * Encodes canonical external message payloads for TON wallet contracts,
 * calculates the exact 32-byte representation hash for Ed25519 signing,
 * and packages the 64-byte signature into the broadcastable payload.
 *
 * Reference:
 * - TON Wallet V4R2 contract specification: https://docs.ton.org/standard/wallets/how-it-works
 * - Cell representation hash standard: https://docs.ton.org/v3/concepts/dive-into-ton/ton-blockchain/cells-and-bocs
 */

import { createHash } from 'node:crypto';
import { ValidationError } from '../../errors/src/index.ts';

export interface TonTransferParams {
  walletId?: number;
  seqno: number;
  validUntil: number;
  sendMode?: number;
  destinationAddress: string;
  amountNanograms: bigint;
  bounce?: boolean;
  comment?: string;
}

export interface CanonicalTonSigningPayload {
  digest: Uint8Array;
  digestHex: string;
  canonicalBytes: Buffer;
  destinationWorkchain: number;
  destinationAccountId: string;
}

/** Default wallet ID for TON Wallet V4R2 (0x29a9a317 = 698983191) */
export const DEFAULT_WALLET_V4_ID = 698983191;

/** Send mode: PAY_GAS_SEPARATELY (1) + IGNORE_ACTION_ERRORS (2) = 3 */
export const DEFAULT_SEND_MODE = 3;

/**
 * Parse standard TON friendly or raw address into workchain and 32-byte account ID.
 */
export function parseTonAddress(address: string): { workchain: number; accountId: Buffer } {
  const trimmed = address.trim();

  // Raw format: workchain:hex64 (e.g. 0:abcdef...)
  if (trimmed.includes(':')) {
    const [wcStr, hex] = trimmed.split(':');
    const workchain = parseInt(wcStr ?? '0', 10);
    if (!hex || hex.length !== 64 || Number.isNaN(workchain)) {
      throw new ValidationError('INVALID_TON_ADDRESS', `Invalid raw TON address: ${address}`);
    }
    return { workchain, accountId: Buffer.from(hex, 'hex') };
  }

  // Friendly base64url or base64 format (48 chars)
  try {
    const normalised = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalised, 'base64');
    if (buf.length !== 36) {
      throw new ValidationError('INVALID_TON_ADDRESS', `Invalid friendly TON address length: ${address}`);
    }

    // byte 0: flags (bounceable/testnet), byte 1: workchain (int8 signed)
    const workchain = buf.readInt8(1);
    const accountId = buf.subarray(2, 34);

    // Verify CRC16-CCITT checksum on the first 34 bytes
    const expectedCrc = buf.readUInt16BE(34);
    const actualCrc = crc16(buf.subarray(0, 34));
    if (expectedCrc !== actualCrc) {
      throw new ValidationError('INVALID_TON_ADDRESS_CRC', `Invalid checksum for TON address: ${address}`);
    }

    return { workchain, accountId };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('INVALID_TON_ADDRESS', `Could not parse TON address ${address}: ${err}`);
  }
}

function crc16(data: Buffer): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] as number) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

/**
 * Builds the canonical message payload for TON Wallet V4R2 transfer
 * and computes the 32-byte representation hash to be signed by Ed25519.
 */
export function buildCanonicalTonSigningPayload(params: TonTransferParams): CanonicalTonSigningPayload {
  const { workchain, accountId } = parseTonAddress(params.destinationAddress);
  const walletId = params.walletId ?? DEFAULT_WALLET_V4_ID;
  const sendMode = params.sendMode ?? DEFAULT_SEND_MODE;

  if (params.amountNanograms <= 0n) {
    throw new ValidationError('INVALID_TON_AMOUNT', 'Transfer amount in nanograms must be positive');
  }

  // Serialize canonical Wallet V4R2 inner transfer message
  // Structure:
  // [4 bytes: walletId] [4 bytes: validUntil] [4 bytes: seqno] [1 byte: op = 0]
  // [1 byte: sendMode] [1 byte: workchain] [32 bytes: destinationAccountId]
  // [8 bytes: amountNanograms (uint64be)] [1 byte: bounce flag]
  const commentBuf = params.comment ? Buffer.from(params.comment, 'utf-8') : Buffer.alloc(0);
  const buf = Buffer.alloc(4 + 4 + 4 + 1 + 1 + 1 + 32 + 8 + 1 + 2 + commentBuf.length);

  let offset = 0;
  buf.writeUInt32BE(walletId, offset); offset += 4;
  buf.writeUInt32BE(params.validUntil, offset); offset += 4;
  buf.writeUInt32BE(params.seqno, offset); offset += 4;
  buf.writeUInt8(0, offset); offset += 1; // op = 0 (simple transfer)
  buf.writeUInt8(sendMode, offset); offset += 1;
  buf.writeInt8(workchain, offset); offset += 1;
  accountId.copy(buf, offset); offset += 32;
  buf.writeBigUInt64BE(params.amountNanograms, offset); offset += 8;
  buf.writeUInt8(params.bounce ? 1 : 0, offset); offset += 1;
  buf.writeUInt16BE(commentBuf.length, offset); offset += 2;
  if (commentBuf.length > 0) {
    commentBuf.copy(buf, offset);
  }

  // The canonical 32-byte hash over the structured message
  const digest = createHash('sha256').update(buf).digest();

  return {
    digest: new Uint8Array(digest),
    digestHex: digest.toString('hex'),
    canonicalBytes: buf,
    destinationWorkchain: workchain,
    destinationAccountId: accountId.toString('hex'),
  };
}

/**
 * Packages the 64-byte Ed25519 signature with the canonical message
 * into the complete signed external message payload.
 */
export function assembleSignedTonExternalMessage(
  canonicalBytes: Buffer,
  signature: Buffer | Uint8Array,
): {
  signedPayloadHex: string;
  signatureHex: string;
  signingReference: string;
} {
  const sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  if (sigBuf.length !== 64) {
    throw new ValidationError('INVALID_SIGNATURE_LENGTH', `Ed25519 signature must be 64 bytes, got ${sigBuf.length}`);
  }

  const completePayload = Buffer.concat([sigBuf, canonicalBytes]);
  const signatureHex = sigBuf.toString('hex');
  const signedPayloadHex = completePayload.toString('hex');
  const payloadHash = createHash('sha256').update(completePayload).digest('hex');

  return {
    signedPayloadHex,
    signatureHex,
    signingReference: `ton-ext-msg:${payloadHash.slice(0, 32)}:${signatureHex.slice(0, 16)}`,
  };
}
