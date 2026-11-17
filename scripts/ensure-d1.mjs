// Finds the D1 database named in wrangler.jsonc, creates it if it doesn't exist yet,
// and writes its id into wrangler.jsonc. Runs in CI before the build.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'simple-mailbox-db';
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const find = () => JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === NAME);

let db = find();
if (!db) {
  console.log(`Creating D1 database ${NAME}`);
  wrangler('d1', 'create', NAME);
  db = find();
}
if (!db?.uuid) throw new Error(`Could not find or create D1 database ${NAME}`);

const config = readFileSync('wrangler.jsonc', 'utf8');
const updated = config.replace(/("database_id":\s*")[^"]*(")/, `$1${db.uuid}$2`);
writeFileSync('wrangler.jsonc', updated);
console.log(`D1 ${NAME}: ${db.uuid}`);
