import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
const handle = createDb(url, { max: 1 });
try {
  await runMigrations(handle);
  console.log('Migrations applied');
} finally {
  await handle.close();
}
