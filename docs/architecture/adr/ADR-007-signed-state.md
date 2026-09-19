# ADR-007 — SIGNED is a state of its own

**Status:** Accepted

## Context

The payout pipeline originally went `RESERVED → BROADCASTED`, with signing
folded into the broadcast step.

That makes a real and dangerous situation unrepresentable. SPEC 5496–5501
describes it:

> حالت بسیار مهم: `SIGNED` ولی Broadcast هنوز مشخص نیست.

A signer can return a valid signature and the process can then crash, or the
broadcast can time out. If the row still reads `RESERVED`, a recovering worker
concludes nothing has been signed and builds a second transaction — a second
spendable authorisation over the same funds. If it reads `BROADCASTED`, the
system claims something reached the network that may never have.

Neither is true, and the truth had nowhere to live.

## Decision

Insert `SIGNED` between `RESERVED` and `BROADCASTED`.

```
RESERVED → SIGNED → BROADCASTED → SETTLED
    ↘         ↘          ↘
   FAILED   FAILED     FAILED | UNKNOWN
   UNKNOWN  UNKNOWN
```

Migration `005_payout_signed_state.sql` adds `signed_at` and
`signing_reference`, widens the status CHECK, and requires the signing evidence
for `SIGNED` and everything after it — so "have we already signed?" is
answerable from the row alone.

`signPayout()` re-validates the full SPEC 90.10 checklist (rate lock, asset,
network, wallet, reservation, amount) and is idempotent: a second call returns
the existing reference instead of producing a second signature.

`broadcastPayout()` now accepts only `SIGNED` (SPEC 5502).

`SIGNED` joins `PAYOUT_IN_FLIGHT`, so it blocks a concurrent payout for the same
merchant exactly as `RESERVED` and `BROADCASTED` do.

## Consequences

A crash at any point is now describable, and therefore recoverable. The
dangerous window — signed, fate unknown — has an explicit state and its own
index for scanning.

The worker gains one stage. The pipeline is one step longer and correspondingly
harder to get wrong.

Signing itself is currently a reference handle rather than a call to a real
KMS/HSM. The boundary is in place — no key material touches this process — but
the signer behind it is not yet implemented.
