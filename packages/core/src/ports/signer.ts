/**
 * SignerPort — the permanent boundary between this application and whatever
 * holds the payout wallet's private key.
 *
 * Key material must never enter this process (SPEC 5485-5487, 118.37).
 * The application's side of the boundary: describe the transfer, receive a signed payload,
 * never see the key.
 */

export interface SignTransferRequest {
  /**
   * Unique per signing attempt. The signer must refuse to produce a second
   * signature for an id it has already consumed (SPEC 5569/5570).
   */
  signRequestId: string;
  payoutId: string;
  /** Must be GRAM; the signer re-checks rather than trusting the caller. */
  asset: string;
  /** Must be the configured network; a production signer refuses testnet. */
  network: string;
  destinationAddress: string;
  /** Amount in nanogram, as an exact decimal string. Never a float. */
  amountAtomic: string;
  /** Sender wallet, so the signer can confirm it controls it. */
  fromAddress: string;
}

export interface SignedTransfer {
  /**
   * Opaque handle to the signed payload held by the signer.
   * Formatted as "ton-boc:<base64_boc>" or persistent reference URI.
   */
  signingReference: string;
  /** Present when the signer can report it before broadcast (representation hash). */
  unsignedHash?: string;
  /** Base64 serialized TON Bag of Cells external message for TonCenter broadcast. */
  bocBase64?: string;
  signedAt: Date;
  /** Which signer produced this, for audit. */
  signer: string;
}

export interface SignerPort {
  readonly name: string;
  /**
   * Sign a transfer.
   *
   * Defence in depth: however much the caller validated, the signer validates
   * asset, network, destination and amount again independently (SPEC 5567, 7567).
   */
  sign(request: SignTransferRequest): Promise<SignedTransfer>;
}
