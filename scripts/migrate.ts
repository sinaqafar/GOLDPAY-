/** Run pending database migrations. */

import { createDatabase } from '../packages/database/src/client.ts';
import { migrate } from '../packages/database/src/migrator.ts';
import { loadConfig } from '../packages/config/src/index.ts';

const config = loadConfig();
const db = await createDatabase({ url: config.database.url });
try {
  const { applied, skipped } = await migrate(db);
  console.log(
    applied.length === 0
      ? `migrate: database is up to date (${skipped.length} migration(s) already applied)`
      : `migrate: applied ${applied.length} migration(s): ${applied.join(', ')}`,
  );
} finally {
  await db.close();
}
