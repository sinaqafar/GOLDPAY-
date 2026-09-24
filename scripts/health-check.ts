/**
 * Gateway Health Check & Subsystem Readiness Probe
 */

import { runProductionReadinessGate } from '../packages/cubepay/src/compatibility-gate.ts';

async function main() {
  const gate = await runProductionReadinessGate({ probeNetwork: true });
  console.log(JSON.stringify(gate, null, 2));
  if (!gate.code_ready) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Health check failed:', err);
  process.exit(1);
});
