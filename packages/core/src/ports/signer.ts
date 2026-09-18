/**
 * SignerPort — the permanent boundary between this application and whatever
 * holds the payout wallet's private key.
 *
 * This is NOT a temporary abstraction to be collapsed once a real signer
 * exists. Key material must never enter this process (SPEC 5485-5487,
 * 118.37), so the application's side of the boundary is always: describe the
 * transfer, receive a signed payload, never see the key.
 *
 * Implementations, in order of what production requires:
 *
 *   KmsSigner / HsmSigner   the only acceptable production signers
 *   StubSigner              development and tests only
 *
 * A local mnemonic or keystore file is explicitly NOT production architecture:
 * it puts the key on the same disk as the application, which is the exact
 * failure the boundary exists to prevent.
 */

export interface SignTransferRequest {
  /**
   * Unique per signing attempt. The signer must refuse to produce a second
   * signature for an id it has already consumed (SPEC 5569/5570) — otherwise a
   * retry could authorise the same funds twice.
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
   * The application stores this reference, never the payload's key material.
   */
  signingReference: string;
  /** Present when the signer can report it before broadcast. */
  unsignedHash?: string;
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
   * asset, network, destination and amount again independently (SPEC 5567,
   * 7567). A signer that trusts its caller is only as safe as the weakest code
   * path that can reach it.
   */
  sign(request: SignTransferRequest): Promise<SignedTransfer>;
}
