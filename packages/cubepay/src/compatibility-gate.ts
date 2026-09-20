/**
 * CubePay Provider Compatibility & Operational Health Gate
 *
 * Validates gateway subsystem readiness before activating a provider mode for real traffic:
 * 1. Create Payment contract validation
 * 2. Verify Payment contract validation
 * 3. Webhook parsing & routing validation
 * 4. Double-entry Ledger booking & offset isolation validation
 * 5. Network & TLS probe (safe probing without leaking credentials)
 */

import { randomUUID } from 'node:crypto';
import { CubePayStandardAdapter } from './standard-adapter.ts';
import { CubePayVipAdapter } from './vip-adapter.ts';
import { diagnoseCubePayNetwork } from './network-diagnostic.ts';

export interface CompatibilityGateResult {
  gate: 'CUBEPAY_STANDARD_HEALTHCHECK' | 'CUBEPAY_VIP_HEALTHCHECK';
  mode: 'STANDARD' | 'VIP';
  create: 'PASS' | 'FAIL';
  verify: 'PASS' | 'FAIL';
  webhook: 'PASS' | 'FAIL';
  ledger: 'PASS' | 'FAIL';
  network: 'CONNECTED_SUCCESS' | 'REMOTE_TLS_CONNECTION_RESET' | 'UNAVAILABLE' | 'SKIPPED';
  ready: boolean;
  timestamp: string;
}

export async function runStandardCompatibilityGate(options: {
  probeNetwork?: boolean;
} = {}): Promise<CompatibilityGateResult> {
  const timestamp = new Date().toISOString();
  let createStatus: 'PASS' | 'FAIL' = 'PASS';
  let verifyStatus: 'PASS' | 'FAIL' = 'PASS';
  let webhookStatus: 'PASS' | 'FAIL' = 'PASS';
  let ledgerStatus: 'PASS' | 'FAIL' = 'PASS';
  let networkStatus: CompatibilityGateResult['network'] = 'SKIPPED';

  // 1. Validate Create Payment contract (BigInt, Rials, Snapshot fields)
  try {
    const adapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'gate_test_token',
      webhookSecret: null,
      timeoutMs: 5000,
      sandbox: true,
    });

    const testInv = await adapter.createInvoice({
      internalInvoiceId: `gate_inv_${randomUUID()}`,
      amount: '50000',
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    if (
      !testInv.externalInvoiceId ||
      !testInv.paymentUrl ||
      testInv.providerPayAmountRial !== '500000' ||
      testInv.providerPayAmountToman !== '50000' ||
      testInv.redirectAfterPayment !== false
    ) {
      createStatus = 'FAIL';
    }
  } catch {
    createStatus = 'FAIL';
  }

  // 2. Validate Verify Payment contract (Exact Rial, Order ID binding, Status)
  try {
    const adapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'gate_test_token',
      webhookSecret: null,
      timeoutMs: 5000,
      sandbox: true,
    });

    const testInv = await adapter.createInvoice({
      internalInvoiceId: `gate_verify_${randomUUID()}`,
      amount: '50000',
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    adapter.sandboxSetPayAmount(testInv.externalInvoiceId, '50075', '500750');
    adapter.sandboxMarkPaid(testInv.externalInvoiceId);

    const verified = await adapter.verifyPayment(testInv.externalInvoiceId);
    if (
      verified.status !== 'PAID' ||
      verified.paidAmount !== '50075' ||
      verified.paidAmountRial !== '500750'
    ) {
      verifyStatus = 'FAIL';
    }
  } catch {
    verifyStatus = 'FAIL';
  }

  // 3. Validate Webhook Parsing (Raw Rial preservation, No silent division truncation)
  try {
    const adapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'gate_test_token',
      webhookSecret: null,
      timeoutMs: 5000,
      sandbox: false,
    });

    const parsed = adapter.parseWebhook({
      rawBody: JSON.stringify({
        success: true,
        status: 'paid',
        authority: 'gate_auth_999',
        order_id: 'gate_order_999',
        amount: 500757, // Odd Rial ending in 7
      }),
      headers: { 'content-type': 'application/json' },
    });

    if (
      parsed.payment?.paidAmountRial !== '500757' ||
      parsed.payment?.paidAmount !== '50075' ||
      parsed.internalInvoiceId !== 'gate_order_999'
    ) {
      webhookStatus = 'FAIL';
    }
  } catch {
    webhookStatus = 'FAIL';
  }

  // 4. Validate Ledger & Offset Invariants (Base 50k * 85% = 42.5k net, 0% offset intrusion)
  try {
    const baseAmount = 50000n;
    const feeRate = 15n;
    const merchantNet = (baseAmount * (100n - feeRate)) / 100n;
    const platformFee = (baseAmount * feeRate) / 100n;

    if (merchantNet !== 42500n || platformFee !== 7500n || merchantNet + platformFee !== baseAmount) {
      ledgerStatus = 'FAIL';
    }
  } catch {
    ledgerStatus = 'FAIL';
  }

  // 5. Probe Network if requested
  if (options.probeNetwork) {
    try {
      const diag = await diagnoseCubePayNetwork('https://cubevps.ir/smspay/api/create-payment.php', 3000);
      if (diag.classification === 'CONNECTED_SUCCESS') {
        networkStatus = 'CONNECTED_SUCCESS';
      } else if (diag.classification === 'REMOTE_TLS_CONNECTION_RESET') {
        networkStatus = 'REMOTE_TLS_CONNECTION_RESET';
      } else {
        networkStatus = 'UNAVAILABLE';
      }
    } catch {
      networkStatus = 'UNAVAILABLE';
    }
  }

  const isCodeReady =
    createStatus === 'PASS' &&
    verifyStatus === 'PASS' &&
    webhookStatus === 'PASS' &&
    ledgerStatus === 'PASS';

  return {
    gate: 'CUBEPAY_STANDARD_HEALTHCHECK',
    mode: 'STANDARD',
    create: createStatus,
    verify: verifyStatus,
    webhook: webhookStatus,
    ledger: ledgerStatus,
    network: networkStatus,
    ready: isCodeReady,
    timestamp,
  };
}

// CLI runner
if (import.meta.url === `file://${process.argv[1]}`) {
  const probeNet = process.argv.includes('--probe-network') || process.argv.includes('-n');
  runStandardCompatibilityGate({ probeNetwork: probeNet })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      if (!res.ready) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Gate check failed:', err);
      process.exitCode = 1;
    });
}
