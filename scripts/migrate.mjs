// Applies pending SQL migrations in ./migrations in filename order.
// Tracks applied files in a schema_migrations table.
//
// Uses the UNPOOLED connection string: some DDL and session-level features are
// rejected by the Neon pooler, so schema changes must run over a direct link.
//
//   npm run db:migrate
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

const connectionString =
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL_UNPOOLED (or DATABASE_URL) must be set.");
  process.exit(1);
}

// Neon needs TLS; a local Postgres usually has no certificate at all. A remote
// connection is verified unless the string says sslmode=no-verify.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(connectionString);
const ssl =
  isLocal || /sslmode=disable/i.test(connectionString)
    ? false
    : { rejectUnauthorized: !/sslmode=no-verify/i.test(connectionString) };

const pool = new pg.Pool({
  connectionString,
  ssl,
  max: 1,
});

async function main() {
  await pool.query(
    `create table if not exists schema_migrations (
       filename   text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const applied = new Set(
    (await pool.query("select filename from schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename) values ($1)",
        [filename],
      );
      await client.query("commit");
      console.log(`applied ${filename}`);
      count += 1;
    } catch (error) {
      await client.query("rollback");
      console.error(`failed ${filename}:`, error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? "no pending migrations" : `applied ${count} migration(s)`);
  await pool.end();
}

main().catch(() => process.exit(1));
