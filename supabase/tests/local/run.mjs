// Local rollback-test runner (PGlite = Postgres 17 in WASM; no Docker or psql needed).
// Setup once, in any empty folder:  npm i @electric-sql/pglite@0.3.16  and copy this file and stubs.sql there.
// Run:  node run.mjs <repo>/supabase/migrations <last migration prefix> [<test.sql> ...]
// stubs.sql stands in for the Supabase platform schemas (auth, storage, realtime, cron, net); the
// CREATE EXTENSION pg_net/pg_cron lines are dropped. A "-- @@MIGRATION <repo-relative path>@@" line in a
// test file is replaced by that migration, so the DDL runs inside the test transaction and rolls back.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs'; import path from 'node:path';
const [dir, upto, ...extra] = process.argv.slice(2);
const db = await PGlite.create({ extensions: { pgcrypto } });
const here = path.dirname(new URL(import.meta.url).pathname);
await db.exec(fs.readFileSync(path.join(here, 'stubs.sql'), 'utf8'));
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (f.slice(0, upto.length) > upto) continue;
  const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^create extension if not exists pg_(net|cron).*$/gm, '');
  try { await db.exec(sql); } catch (e) { console.error(`MIGRATION ${f} FAILED: ${e.message} pos=${e.position} where=${e.where} internal=${e.internalQuery?.slice(0,200)}`); process.exit(1); }
}
console.log('migrations applied up to', upto);
for (const f of extra) {
  let sql = fs.readFileSync(f, 'utf8');
  sql = sql.replace(/^-- @@MIGRATION (\S+)@@$/m, (_, p) => fs.readFileSync(path.resolve(path.dirname(f), '../..', p), 'utf8'));
  try {
    const res = await db.exec(sql);
    for (const r of res) if (r.rows?.length && !('expect_true' in r.rows[0] || 'expect_ok' in r.rows[0] || 'expect_state' in r.rows[0])) console.log(f.split('/').pop(), JSON.stringify(r.rows));
  } catch (e) { console.error(`${f.split('/').pop()} FAILED: ${e.message}`); process.exit(1); }
}
