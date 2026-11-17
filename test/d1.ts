import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Enough of D1's API, over Node's built-in SQLite, to run the Worker's real SQL in tests. */
export function testDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) { params = p; return stmt; },
      async first() { return db.prepare(sql).get(...(params as [])) ?? null; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...(params as [])).changes) } }; },
      async all() { return { results: db.prepare(sql).all(...(params as [])) }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts: { run: () => Promise<unknown> }[]) { for (const s of stmts) await s.run(); },
  } as unknown as D1Database;
}
