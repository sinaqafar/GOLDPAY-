/**
 * Create a platform admin.
 *
 * The credential is printed once and only its hash is stored, so there is no
 * way to recover it later — that is intentional.
 *
 *   node --experimental-strip-types scripts/create-admin.ts \
 *     --name "Owner" --email owner@example.com --role SUPER_ADMIN
 */

import { randomUUID } from 'node:crypto';
import { createDatabase } from '../packages/database/src/client.ts';
import { loadConfig } from '../packages/config/src/index.ts';
import { generateApiKey } from '../packages/crypto/src/index.ts';
import { isAdminRole, ADMIN_ROLES } from '../packages/core/src/admin/rbac.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const name = arg('name');
const email = arg('email');
const role = arg('role') ?? 'SUPER_ADMIN';
const telegram = arg('telegram');

if (!name || (!email && !telegram)) {
  console.error(
    'usage: create-admin.ts --name <name> (--email <email> | --telegram <id>) [--role <role>]\n' +
      `roles: ${ADMIN_ROLES.join(', ')}`,
  );
  process.exit(1);
}
if (!isAdminRole(role)) {
  console.error(`unknown role: ${role}\nroles: ${ADMIN_ROLES.join(', ')}`);
  process.exit(1);
}

const config = loadConfig(process.env as Record<string, string>);
const db = await createDatabase({ url: config.database.url });

const id = randomUUID();
const credential = generateApiKey();

await db.query(
  `INSERT INTO core.admin_users (id, name, email, telegram_user_id, role, status, secret_hash)
   VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`,
  [id, name, email ?? null, telegram ? Number.parseInt(telegram, 10) : null, role, credential.secretHash],
);

await db.query(
  `INSERT INTO audit.audit_logs (id, actor_type, actor_id, action, resource_type, resource_id, reason, metadata)
   VALUES ($1,'SYSTEM',NULL,'ADMIN_CREATED','ADMIN',$2,'created via CLI',$3::jsonb)`,
  [randomUUID(), id, JSON.stringify({ role, name })],
);

const secret = credential.token.split('.')[1];
console.log('\nadmin created\n');
console.log(`  name        ${name}`);
console.log(`  role        ${role}`);
console.log(`  credential  ${id}.${secret}`);
console.log('\nthis credential is shown once and cannot be recovered. store it now.\n');

await db.close?.();
