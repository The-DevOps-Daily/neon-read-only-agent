// Drift: cases where a read_only role stops matching the schema it was meant to
// guard, because its grants are a snapshot taken when the role was created.
//
//   1. A table created later by a different role. Default privileges are
//      FOR ROLE <owner> only, so agent_ro cannot read a migrator's new table.
//      The fix is default privileges for that role too.
//   2. A new schema. agent_ro was created with --schema app, so a second schema
//      is not readable at all.
import { loadEnv, connectionUri } from "../lib/neon.mjs";
import { connect, withClient } from "../lib/db.mjs";
import { readState, openResults } from "../lib/record.mjs";

loadEnv();
const state = readState();
const out = openResults("drift", { project: state.projectId, branch: state.branchId });

const ownerUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database });
const roUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: "agent_ro", database: state.database });

// Run one statement as agent_ro directly, return ok/sqlstate.
async function asRo(sql) {
  const c = await connect(roUri);
  try { const r = await c.query(sql); return { ok: true, rows: r.rows.length }; }
  catch (e) { return { ok: false, sqlstate: e.code, error: String(e.message).slice(0, 120) }; }
  finally { await c.end().catch(() => {}); }
}

// --- Case 1: a table a migrator role creates later ---
await withClient(ownerUri, async (c) => {
  // Remove a migrator role left by an earlier run. Since Postgres 16 the role
  // that creates another role gets ADMIN OPTION on it but not membership, so
  // the owner grants itself membership before it can act as that role.
  await c.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
      EXECUTE format('GRANT migrator TO %I', current_user);
      DROP OWNED BY migrator;
      DROP ROLE migrator;
    END IF;
  END $$`);
  await c.query("CREATE ROLE migrator LOGIN");
  await c.query("GRANT migrator TO CURRENT_USER");
  await c.query("GRANT USAGE, CREATE ON SCHEMA app TO migrator");
  await c.query("SET ROLE migrator");
  await c.query("CREATE TABLE app.migrator_table (id int, secret text)");
  await c.query("INSERT INTO app.migrator_table VALUES (1, 'owned-by-migrator')");
  await c.query("RESET ROLE");
});
const beforeFix = await asRo("SELECT * FROM app.migrator_table");
// Fix: default privileges for the migrator role, then a NEW table is readable.
await withClient(ownerUri, async (c) => {
  await c.query("ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT ON TABLES TO agent_ro");
  await c.query("SET ROLE migrator");
  await c.query("CREATE TABLE app.migrator_table2 (id int)");
  await c.query("RESET ROLE");
});
const afterFix = await asRo("SELECT * FROM app.migrator_table2");
// The fix covers tables created after it, not the one that already exists.
const oldTableAfterFix = await asRo("SELECT * FROM app.migrator_table");
out.write({ type: "case", name: "migrator_owned_table", beforeFix, afterFix, oldTableAfterFix,
  note: "read_only grants cover the owner's tables; a different role's new tables need ALTER DEFAULT PRIVILEGES FOR ROLE migrator" });
console.log("migrator table: before fix", beforeFix.ok ? "readable" : beforeFix.sqlstate, "| new table after fix", afterFix.ok ? "readable" : afterFix.sqlstate, "| old table after fix", oldTableAfterFix.ok ? "readable" : oldTableAfterFix.sqlstate);

// --- Case 2: a new schema the role was never scoped to ---
await withClient(ownerUri, async (c) => {
  await c.query("DROP SCHEMA IF EXISTS app2 CASCADE");
  await c.query("CREATE SCHEMA app2");
  await c.query("CREATE TABLE app2.secrets (id int, value text)");
  await c.query("INSERT INTO app2.secrets VALUES (1, 'in-second-schema')");
});
const newSchema = await asRo("SELECT * FROM app2.secrets");
out.write({ type: "case", name: "new_schema", result: newSchema,
  note: "agent_ro was created with --schema app, so a second schema has no USAGE grant" });
console.log("new schema app2:", newSchema.ok ? "readable" : newSchema.sqlstate);

out.release();
console.log(`\ndrift written to ${out.file} (stamp ${out.stamp}). next: npm run harden`);
