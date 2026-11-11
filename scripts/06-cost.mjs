// Incident 2: one legal, heavy read from the read-only agent, and what it costs
// on an autoscaling primary versus a capped read replica.
//
// The read_only role does not limit how much a query may scan. We run the same
// heavy read as agent_ro through the MCP server, on the primary (autoscaling
// 0.25 to 4 CU) and on a read replica (capped 0.25 to 1 CU). An owner
// connection on each compute samples the live vCPU count once a second, and we
// add up CU-seconds. Cost uses Neon list prices, because the consumption API
// lags a run by minutes.
import { loadEnv, connectionUri, updateEndpoint, createReadReplica, branchEndpoints } from "../lib/neon.mjs";
import { connect } from "../lib/db.mjs";
import { openMcp } from "../lib/mcp.mjs";
import { readState, openResults } from "../lib/record.mjs";

loadEnv();
const state = readState();

// List prices, USD per CU-hour (Neon pricing page, cited in the post).
const PRICE = { scale: 0.222, launch: 0.106 };
// The heavy read: a parallel scan of a 2M-row table with a chain of md5 calls
// per row. Postgres runs it with 2 parallel workers by default (3 processes),
// so it can use more than one vCPU. A function scan (generate_series) cannot
// run in parallel, so it could never show autoscaling.
const ROWS = Number(process.env.COST_ROWS || 2_000_000);
const DEPTH = Number(process.env.COST_MD5_DEPTH || 20);
const hashChain = (d) => (d === 0 ? "payload" : `md5(${hashChain(d - 1)})`);
const HEAVY_SQL = `SELECT count(*) AS n FROM app.cost_events WHERE ${hashChain(DEPTH)} LIKE '00%'`;

// Primary: allow it to autoscale to 4 CU for this test.
await updateEndpoint(state.projectId, state.primaryEndpointId, { minCu: 0.25, maxCu: 4 });

// Read replica capped at 1 CU.
let replicaId = state.replicaEndpointId;
if (!replicaId) {
  const existing = (await branchEndpoints(state.projectId, state.branchId)).find((e) => e.type === "read_only");
  replicaId = existing ? existing.id : (await createReadReplica(state.projectId, state.branchId, { cu: 0.25, maxCu: 1 })).id;
}
await updateEndpoint(state.projectId, replicaId, { minCu: 0.25, maxCu: 1 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// neon_utils installs num_cpus() in the public schema. It returns the compute's
// vCPU limit rounded UP to a whole number (a 0.25 CU compute reports 1), so the
// integral below is an upper bound on CU-seconds, not an exact meter.
async function numCpus(c) {
  const r = await c.query("SELECT public.num_cpus() AS n");
  return Number(r.rows[0].n);
}

// Sample the compute's vCPU count every second on an owner connection to that
// same compute, and integrate CU-seconds using the real gaps between samples.
async function sampleCompute(computeId, stopFlag) {
  const uri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database, computeId });
  const c = await connect(uri);
  const samples = [];
  let last = Date.now();
  let cuSeconds = 0;
  while (!stopFlag.stop) {
    const n = await numCpus(c);
    const now = Date.now();
    if (samples.length) cuSeconds += (n ?? 0) * ((now - last) / 1000);
    samples.push({ at: now, cpus: n });
    last = now;
    await sleep(1000);
  }
  await c.end().catch(() => {});
  const peak = Math.max(0, ...samples.map((s) => s.cpus || 0));
  return { samples, cuSeconds, peak };
}

async function heavyReadOn(target) {
  const computeId = target === "replica" ? replicaId : state.primaryEndpointId;
  const stopFlag = { stop: false };
  const sampler = sampleCompute(computeId, stopFlag);
  await sleep(1500); // a couple of baseline samples first
  const mcp = await openMcp({ readonly: true, roleName: "agent_ro" });
  const t0 = performance.now();
  const r = await mcp.runSql({ sql: HEAVY_SQL, projectId: state.projectId, branchId: state.branchId, database: state.database, computeId });
  const seconds = (performance.now() - t0) / 1000;
  await mcp.close();
  await sleep(1500); // catch the tail of the climb
  stopFlag.stop = true;
  const s = await sampler;
  return { target, computeId, seconds: Math.round(seconds * 10) / 10, ok: r.ok, result: r.ok ? (r.text || "").slice(0, 80) : undefined, error: r.ok ? undefined : (r.error || "").slice(0, 160), vcpuSecondsUpperBound: Math.round(s.cuSeconds * 100) / 100, peakVcpus: s.peak, samples: s.samples.map((x) => x.cpus) };
}

// Build the table once, as the owner, on the primary.
const ownerUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database });
const built = await (async () => {
  const c = await connect(ownerUri);
  try {
    await c.query("CREATE EXTENSION IF NOT EXISTS neon_utils");
    const n = await c.query("SELECT count(*)::bigint AS n FROM app.cost_events").then((r) => Number(r.rows[0].n)).catch(() => -1);
    if (n !== ROWS) {
      await c.query("DROP TABLE IF EXISTS app.cost_events");
      await c.query(`CREATE TABLE app.cost_events AS SELECT g AS id, md5(g::text) AS payload FROM generate_series(1, ${ROWS}) g`);
      await c.query("ANALYZE app.cost_events");
    }
    return (await c.query("SELECT pg_total_relation_size('app.cost_events')::bigint AS b")).rows[0].b;
  } finally { await c.end().catch(() => {}); }
})();
// Let the replica catch up on the new table before reading it there.
await sleep(5000);

const out = openResults("cost", { project: state.projectId, primary: state.primaryEndpointId, replica: replicaId, rows: ROWS, md5Depth: DEPTH, tableBytes: Number(built), prices: PRICE, sql: HEAVY_SQL.replace(hashChain(DEPTH), `md5^${DEPTH}(payload)`) });

for (const target of ["primary", "replica"]) {
  const r = await heavyReadOn(target);
  const costScale = (r.vcpuSecondsUpperBound / 3600) * PRICE.scale;
  const costLaunch = (r.vcpuSecondsUpperBound / 3600) * PRICE.launch;
  out.write({ type: "run", ...r, costScaleUsdUpperBound: Math.round(costScale * 1e5) / 1e5, costLaunchUsdUpperBound: Math.round(costLaunch * 1e5) / 1e5 });
  console.log(`${target}: ${r.seconds}s ${r.ok ? "ok" : "FAILED " + r.error}, peak ${r.peakVcpus} vCPU, <= ${r.vcpuSecondsUpperBound} vCPU-s, <= $${costScale.toFixed(5)} (Scale)`);
}

// Put the primary back to the fixed small compute.
await updateEndpoint(state.projectId, state.primaryEndpointId, { minCu: 0.25, maxCu: 0.25 });
out.release();
console.log(`\ncost written to ${out.file} (stamp ${out.stamp}). next: npm run drift`);
