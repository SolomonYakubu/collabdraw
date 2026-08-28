// Answers "is the database actually wired up?" without touching any data.
//
// Reports, in order: whether a connection string is present, whether it accepts
// a connection, which server answered, and whether the tables migrations/*.sql
// create are there. Exits non-zero on the first thing that is wrong, so it works
// as a preflight check.
//
//   npm run db:check
import pg from "pg";

const pooled = process.env.DATABASE_URL;
const direct = process.env.DATABASE_URL_UNPOOLED;

if (!pooled && !direct) {
  console.error(
    "✗ No DATABASE_URL in the environment.\n" +
      "  Add it to .env (see .env.example), then run this again.",
  );
  process.exit(1);
}

const EXPECTED_TABLES = ["boards", "board_opens", "board_thumbnails"];

/** Same rule as app/lib/db.ts: TLS for a remote host, none for a local one. */
function sslFor(connectionString) {
  if (/sslmode=disable/i.test(connectionString)) return false;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(
    connectionString,
  );
  if (isLocal) return false;
  return { rejectUnauthorized: !/sslmode=no-verify/i.test(connectionString) };
}

/** Host only — never print a connection string, it carries the password. */
function hostOf(connectionString) {
  try {
    return new URL(connectionString).host;
  } catch {
    return "(unparseable connection string)";
  }
}

async function check(label, connectionString) {
  const pool = new pg.Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const { rows } = await pool.query(
      "select current_database() as db, version() as version",
    );
    const version = rows[0].version.split(" ").slice(0, 2).join(" ");
    console.log(
      `✓ ${label} — connected to ${rows[0].db} at ${hostOf(connectionString)} (${version})`,
    );
    return pool;
  } catch (error) {
    // A failed connect is an AggregateError with no message of its own; the
    // causes carry the reason.
    const detail =
      error.message ||
      error.errors?.map((e) => e.message).join("; ") ||
      String(error);
    console.error(`✗ ${label} — could not connect to ${hostOf(connectionString)}`);
    console.error(`  ${detail}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

const pool = await check("DATABASE_URL", pooled || direct);

const { rows } = await pool.query(
  `select table_name from information_schema.tables
    where table_schema = 'public' and table_name = any($1)`,
  [EXPECTED_TABLES],
);
const present = new Set(rows.map((r) => r.table_name));
const missing = EXPECTED_TABLES.filter((t) => !present.has(t));

if (missing.length > 0) {
  console.error(`✗ Schema incomplete — missing: ${missing.join(", ")}`);
  console.error("  Run: npm run db:migrate");
  await pool.end().catch(() => {});
  process.exit(1);
}

const [{ count }] = (
  await pool.query("select count(*)::int as count from boards where deleted_at is null")
).rows;
console.log(`✓ Schema present — ${count} board(s) stored`);
console.log("Board saving is ready. Restart `npm run dev` and the socket server.");

await pool.end().catch(() => {});
