// Incident 1: a long read from a read-only agent stalls a migration, and the
// migration's queued ACCESS EXCLUSIVE lock then stalls the app's writes.
//
// Timeline per run:
//   t=0      app insert loop starts (pooled writes every ~50 ms)
//   t=2s     agent runs a 15 s read through the MCP server (holds ACCESS SHARE)
//   t=4s     owner runs ALTER TABLE ADD COLUMN (wants ACCESS EXCLUSIVE)
//   ...      the ALTER waits for the agent; new writes queue behind the ALTER
//   t=~17s   the read ends, the ALTER runs, writes drain
//
// Variants: agent read on the primary; agent read on a read replica; and the
// migration guarded by lock_timeout = 2s. Each is run REPEATS times.
//
// The app writers insert into app.orders, the table the migration alters. (An
// earlier version wrote to a side table and could not see the pile-up; that
// run is kept in results/discarded/.)
import { loadEnv, connectionUri, createReadReplica, branchEndpoints } from "../lib/neon.mjs";
import { connect } from "../lib/db.mjs";
import { openMcp } from "../lib/mcp.mjs";
import { readState, openResults } from "../lib/record.mjs";

loadEnv();
const state = readState();
const REPEATS = Number(process.env.REPEATS || 3);
const WRITERS = Number(process.env.WRITERS || 4);
const READ_SECONDS = 15;
const ID_BASE = 5_000_000; // app writes use ids from here; cleaned after each run
let nextId = ID_BASE;

// A read replica (read_only compute) on the same branch.
let replicaId = state.replicaEndpointId;
if (!replicaId) {
  const existing = (await branchEndpoints(state.projectId, state.branchId)).find((e) => e.type === "read_only");
  replicaId = existing ? existing.id : (await createReadReplica(state.projectId, state.branchId, { cu: 0.25, maxCu: 1 })).id;
}

const ownerUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database });
const pooledUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: true, role: state.ownerRole, database: state.database });

const owner = await connect(ownerUri);
await owner.query(`DELETE FROM app.orders WHERE id >= ${ID_BASE}`);

// The role state this run happened in, so the record shows it.
const roleSettings = (await owner.query("SELECT coalesce(array_to_string(s.setconfig, ', '), '') AS g FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid WHERE r.rolname = 'agent_ro'")).rows[0].g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.floor(q * s.length)); return Math.round(s[i]); };

const out = openResults("lock-stall", { project: state.projectId, replica: replicaId, repeats: REPEATS, writers: WRITERS, readSeconds: READ_SECONDS, agentRoRoleSettings: roleSettings });

async function oneRun(variant) {
  // WRITERS app writers (pooled) and a lock sampler (owner, direct).
  const apps = [];
  for (let w = 0; w < WRITERS; w++) apps.push(await connect(pooledUri));
  const sampler = await connect(ownerUri);
  const mcp = await openMcp({ readonly: true, roleName: "agent_ro" });

  const inserts = [];
  const queued = [];
  let running = true;
  const t0 = Date.now();

  // Each writer inserts into app.orders, the table the migration alters, and
  // records when each insert started and how long it took.
  const appLoops = apps.map((app) => (async () => {
    while (running) {
      const start = Date.now() - t0;
      const s = performance.now();
      const id = nextId++;
      try { await app.query("INSERT INTO app.orders(id, customer_id, amount_cents) VALUES ($1, 1, 100)", [id]); inserts.push({ start, ms: performance.now() - s }); }
      catch (e) { inserts.push({ start, ms: performance.now() - s, error: e.code || String(e.message).slice(0, 60) }); }
      await sleep(50);
    }
  })());

  const sampleLoop = (async () => {
    while (running) {
      const r = await sampler.query("SELECT count(*)::int AS n FROM pg_locks WHERE relation = 'app.orders'::regclass AND NOT granted").catch(() => ({ rows: [{ n: null }] }));
      queued.push({ at: Date.now() - t0, waiting: r.rows[0].n });
      await sleep(250);
    }
  })();

  // t=2s: the agent's long read.
  const readTarget = variant === "replica" ? { computeId: replicaId } : {};
  const agentRead = (async () => {
    await sleep(2000);
    const s = performance.now();
    const r = await mcp.runSql({ sql: `SELECT pg_sleep(${READ_SECONDS}) FROM app.orders LIMIT 1`, projectId: state.projectId, branchId: state.branchId, database: state.database, ...readTarget });
    return { ms: performance.now() - s, ok: r.ok, error: r.ok ? undefined : (r.error || "").slice(0, 160) };
  })();

  // t=4s: the migration.
  await sleep(4000);
  const mig = await connect(ownerUri);
  if (variant === "lock_timeout") await mig.query("SET lock_timeout = '2s'");
  const migStart = Date.now() - t0;
  const ms = performance.now();
  let migration;
  try { await mig.query("ALTER TABLE app.orders ADD COLUMN note text"); migration = { ms: performance.now() - ms, ok: true }; }
  catch (e) { migration = { ms: performance.now() - ms, ok: false, sqlstate: e.code, error: String(e.message).slice(0, 120) }; }
  await mig.end().catch(() => {});

  const read = await agentRead;
  running = false;
  await Promise.all(appLoops); await sampleLoop;
  for (const app of apps) await app.end().catch(() => {});
  await sampler.end().catch(() => {}); await mcp.close();

  // Clean up the added column and the app's rows for the next run.
  await owner.query("ALTER TABLE app.orders DROP COLUMN IF EXISTS note");
  await owner.query(`DELETE FROM app.orders WHERE id >= ${ID_BASE}`);

  // Writes that STARTED while the migration was waiting or running.
  const migEnd = migStart + migration.ms;
  const stall = inserts.filter((i) => i.start >= migStart && i.start <= migEnd);
  const stallMs = stall.map((i) => i.ms);
  const maxWaiting = Math.max(0, ...queued.map((q) => q.waiting || 0));
  return {
    variant, migStartMs: migStart, migrationMs: Math.round(migration.ms), migrationOk: migration.ok, migrationState: migration.sqlstate,
    readMs: Math.round(read.ms), readOk: read.ok, readError: read.error,
    insertCount: inserts.length, insertErrors: inserts.filter((i) => i.error).length,
    stallInserts: stall.length, stallP50: quantile(stallMs, 0.5), stallP99: quantile(stallMs, 0.99), stallMax: stallMs.length ? Math.round(Math.max(...stallMs)) : null,
    overOneSecond: inserts.filter((i) => i.ms > 1000).length,
    worstInsertMs: inserts.length ? Math.round(Math.max(...inserts.map((i) => i.ms))) : null,
    baselineP50: quantile(inserts.filter((i) => i.start < migStart).map((i) => i.ms), 0.5),
    maxWaitingBackends: maxWaiting,
  };
}

for (const variant of ["primary", "replica", "lock_timeout"]) {
  for (let i = 0; i < REPEATS; i++) {
    const r = await oneRun(variant);
    out.write({ type: "run", run: i, ...r });
    console.log(`${variant} run ${i}: migration ${r.migrationMs}ms (${r.migrationOk ? "ok" : r.migrationState}), writes in window ${r.stallInserts}, worst write ${r.worstInsertMs}ms, over 1 s ${r.overOneSecond}, max waiting ${r.maxWaitingBackends}, read ${r.readOk ? "ok" : "FAILED"}`);
  }
}

await owner.end().catch(() => {});
out.release();
console.log(`\nlock-stall written to ${out.file} (stamp ${out.stamp}). next: npm run cost`);
