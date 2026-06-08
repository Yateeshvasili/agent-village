import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';
import { log } from '../logger.js';

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');

/**
 * Split a .sql file into individual statements. Strips `--` comments to
 * end-of-line first (so a `;` inside a comment can't split a statement). Our
 * migration SQL contains no `--` sequences inside string literals, so this
 * simple stripping is safe here.
 */
function statements(file: string): string[] {
  const raw = readFileSync(join(sqlDir, file), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function apply(db: Db, file: string): Promise<void> {
  for (const stmt of statements(file)) {
    await db.query(stmt);
  }
  log.info('migrate.applied', { file });
}

/**
 * Apply schema + seed. Idempotent: structural migrations use IF NOT EXISTS /
 * CREATE OR REPLACE; seed only runs when the village is empty, so this is safe
 * to run on every boot and on top of an already-seeded Supabase database.
 */
export async function migrate(db: Db): Promise<void> {
  await apply(db, '001_base.sql');
  await apply(db, '002_trust.sql');
  await apply(db, '004_social.sql');

  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM living_agents');
  if ((rows[0]?.n ?? 0) === 0) {
    await apply(db, '003_seed.sql');
    // Backdate seeded public activity by ~3 days. Seed INSERTs default created_at
    // to now(), which would make freshly-seeded agents look "just active" and
    // (correctly) suppress proactive behavior. Backdating makes the village look
    // genuinely idle so the proactive engine has a real signal to act on.
    const past = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    await db.query(`UPDATE living_diary SET created_at = $1`, [past]);
    await db.query(`UPDATE living_log SET created_at = $1`, [past]);
    log.info('migrate.seeded');
  } else {
    log.info('migrate.seed_skipped', { existing_agents: rows[0]?.n });
  }
}
