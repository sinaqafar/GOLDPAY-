/**
 * Gateway Health Check & Subsystem Readiness Probe
 */

import { runStandardCompatibilityGate } from '../packages/cubepay/src/compatibility-gate.ts';

async function main() {
  const gate = await runStandardCompatibilityGate({ probeNetwork: true });
  console.log(JSON.stringify(gate, null, 2));
  if (!gate.ready) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Health check failed:', err);
  process.exit(1);
});
