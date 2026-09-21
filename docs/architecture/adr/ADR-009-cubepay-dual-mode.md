# ADR-009 — CubePay Dual-Mode: VIP (Default) vs Standard (Card-to-Card)

**Status:** Accepted

## Context

CubePay provides two distinct integration models according to official documentation (`https://github.com/cubepy/cubepay-doc`):
1. **CubePay VIP (Managed Settlement)**:
   - Uses `/managed-settlement/api/create-order.php` and `/check-order-status.php`.
   - Native amounts in **Toman**.
   - HMAC-SHA256 signature verification over `order_id|paid|amount_toman`.
2. **CubePay Standard (Card-to-Card SMS Forwarder)**:
   - Uses `/smspay/api/create-payment.php` and `/verify-payment.php`.
   - Wire amounts in **Rials** (`Toman * 10`).
   - Authority-based verification.

We require a clean dual-mode architecture where `VIP` is the default active mode in production, but `STANDARD` can be activated on demand, while guaranteeing that existing invoices retain their original snapshot and are never corrupted or routed to the wrong provider adapter during mode switches.

## Decision

1. **Port & Segregated Adapters**:
   - `CubePayProviderPort` defines the common payment provider interface.
   - `CubePayVipAdapter` implements VIP endpoints, Toman handling, and HMAC verification.
   - `CubePayStandardAdapter` implements Standard endpoints, Rial wire conversions, and authority verification.
2. **Central Resolver (`CubePayProviderResolver`)**:
   - Enforces single active mode for new invoices (`CUBEPAY_ACTIVE_MODE = 'VIP' | 'STANDARD'`).
   - Resolves existing invoices by their snapshotted `provider_mode`.
   - Provides atomic, versioned, and audited mode switching via `/internal/admin/cubepay/switch-mode`.
3. **Immutable Invoice Snapshot**:
   - Every invoice captures `provider = 'CUBEPAY'`, `provider_mode = 'VIP' | 'STANDARD'`, and `provider_version`.
   - Webhooks inspect the invoice's snapshotted mode first before delegating verification to the corresponding adapter.
4. **Isolated Fees & Credentials**:
   - Platform fee is fixed at 14%.
   - Provider expected fee is recorded at 9% until confirmed by authoritative provider evidence.
   - Instant withdrawal fee is 2% and completely independent of the ingress provider.

## Consequences

- Full compliance with official CubePay specifications without guessing or mixing protocol logic.
- Zero downtime or state corruption during mode transitions.
- Segregated testability: 14 integration tests specifically assert dual-mode invariants, webhook isolation, and Rial/Toman conversions.
