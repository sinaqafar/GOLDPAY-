# Security

```
Every Important Action = Authentication + Authorization + Audit
```

## Layers (SPEC 240)

```
User → API → Payment → Financial → Blockchain → Infrastructure → Audit
```

Edge protection does not replace authorisation in the backend. If the proxy is
bypassed the application must still refuse (SPEC 7245/7246).

## The ten acceptance rules (SPEC 48.88)

1. No financial operation without valid authentication.
2. No financial operation without valid authorisation.
3. No payout without a reservation.
4. No blind retry of an unknown payout.
5. No private key outside the signer.
6. No balance edited directly from an admin UI.
7. No callback creating financial value without verification.
8. No sensitive request without replay protection.
9. No secret in Git, logs or the frontend.
10. No merchant frozen or unfrozen without audit.

## Broadcast guards (SPEC 97.113–116)

Checked before anything reaches the chain:

| Guard | Condition | Result |
|---|---|---|
| Asset | `GRAM_ASSET !== 'GRAM'` | `INVALID_SETTLEMENT_ASSET` |
| Network | request network ≠ configured | `NETWORK_MISMATCH` |
| Destination | address ≠ active wallet snapshot | `DESTINATION_MISMATCH` |
| Amount | reservation ≠ locked amount | `PAYOUT_AMOUNT_MISMATCH` → REVIEW |

A production signer must never sign a testnet transaction.

## Keys

Private key material never enters this process. The signer holds it — KMS, HSM
or an encrypted keystore — and the application stores only an opaque reference
(SPEC 118.37).

Never in: logs, database, queue, Redis, frontend, Git, environment dumps.

The signer verifies independently rather than trusting the caller: asset,
network, authorised payout, destination and amount (SPEC 5485–5487,
defence in depth).

## Request security

Replay protection uses timestamp plus nonce. Body hashing is over raw bytes
before parsing, so a signature cannot be valid for a body that was later
modified.

Headers set on every response: `Content-Security-Policy`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
`Strict-Transport-Security`.

CORS is never `*` for authenticated APIs, and wildcard origin with credentials
is forbidden. Bearer tokens never appear in a URL.

## SSRF

Merchant-supplied webhook URLs are attacker-controlled. Validate scheme, host,
port and the **resolved IP**; block private, loopback and link-local ranges
after DNS resolution; follow redirects with the same checks; guard against DNS
rebinding; cap response size and time (SPEC 97).

## Errors

A 500 never contains SQL, a stack trace, a credential or an internal hostname
(SPEC 82). Error codes are stable; messages are for humans and are not part of
the contract.

`401` means not authenticated, `403` means not permitted — and neither may be
usable to enumerate what exists.

## Incident response

```
DETECT → CONTAIN → INVESTIGATE → ROTATE SECRETS → VERIFY SYSTEM
→ RECONCILE FINANCIAL STATE → RESUME
```

Without reconciliation, resumption is not complete.

`SECURITY_FREEZE` and `PAYOUT_BROADCAST_PAUSED` are independent flags. One may
trigger the other; they do not mean the same thing.

### Wallet compromise

1. Stop the payout dispatcher.
2. Disable the signer.
3. Enter emergency mode.
4. Reconcile treasury balance and reservations.
5. Investigate unknown transactions.
6. Preserve audit and security events.
7. Replace the wallet if compromise is confirmed.

### API key leak

Revoke immediately → extract the usage timeline → identify suspicious requests →
reconcile if there was financial impact → issue a new key. Revocation never
alters financial history.

### Admin compromise

Revoke all suspect sessions → rotate credentials → verify and reset 2FA →
review the admin audit trail → move affected payouts to review → check related
API keys and integrations.
