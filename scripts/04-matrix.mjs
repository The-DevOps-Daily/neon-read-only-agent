// Stage 4: run the probe matrix across the four setups and record every
// outcome to results/matrix.jsonl.
//
// For each probe the runner records: whether it was allowed or denied, the
// SQLSTATE on a denial, whether a persistent side effect was measured as the
// owner (a write, a large object, a role GUC, a delivered NOTIFY), and whether
// the outcome matched the expectation declared in lib/probes.mjs. A result that
// does not match its declared expectation is flagged, so an unexpected error
// cannot pass as a block.
import { loadEnv, connectionUri } from "../lib/neon.mjs";
import { connect, withClient } from "../lib/db.mjs";
import { openMcp } from "../lib/mcp.mjs";
import { readState, openResults } from "../lib/record.mjs";
import { PROBES } from "../lib/probes.mjs";

loadEnv();
const state = readState();

const ALL_SETUPS = [
  { id: "S1", label: "direct as agent_ro", kind: "direct", role: "agent_ro" },
  { id: "S2", label: "MCP readonly, owner role", kind: "mcp", readonly: true },
  { id: "S3", label: "MCP readonly + roleName=agent_ro", kind: "mcp", readonly: true, roleName: "agent_ro" },
  { id: "S4", label: "MCP roleName=agent_rw", kind: "mcp", roleName: "agent_rw" },
];
// The post-harden rerun sets MATRIX_SETUPS=S1,S3 and MATRIX_OUT=matrix-hardened.
const wanted = (process.env.MATRIX_SETUPS || "S1,S2,S3,S4").split(",").map((s) => s.trim());
const SETUPS = ALL_SETUPS.filter((s) => wanted.includes(s.id));
const OUT_NAME = process.env.MATRIX_OUT || "matrix";

const ownerUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database });

// Owner connection for side-effect measurement and the NOTIFY listener.
const owner = await connect(ownerUri);
// Clean any persistent test writes from an earlier run so the matrix is
// re-runnable and the side-effect deltas start from zero.
await owner.query("DELETE FROM app.orders WHERE id >= 900000").catch(() => {});
await owner.query("TRUNCATE app.audit_log").catch(() => {});
await owner.query("SELECT lo_unlink(oid) FROM pg_largeobject_metadata").catch(() => {});
await owner.query("ALTER ROLE agent_ro RESET statement_timeout").catch(() => {});
const notifications = [];
owner.on("notification", (n) => notifications.push({ channel: n.channel, payload: n.payload, at: Date.now() }));
await owner.query("LISTEN probe_chan");

const counters = async () => {
  const r = await owner.query(`SELECT
    (SELECT count(*) FROM app.audit_log)::bigint AS audit,
    (SELECT count(*) FROM pg_largeobject_metadata)::bigint AS lobjs,
    (SELECT count(*) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'agent_ro')::bigint AS rolesettings`);
  return { audit: Number(r.rows[0].audit), lobjs: Number(r.rows[0].lobjs), rolesettings: Number(r.rows[0].rolesettings) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run one probe statement in a setup, with an optional in-session follow-up
// check (for ephemeral session effects only a direct connection can observe).
async function runProbe(setup, mcp, sql) {
  if (setup.kind === "direct") {
    const uri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: setup.role, database: state.database });
    const c = await connect(uri);
    try {
      const res = await c.query(sql);
      const text = JSON.stringify(res.rows).slice(0, 400);
      // Follow-up checks on the same session.
      const temp = await c.query("SELECT to_regclass('pg_temp.probe_temp') IS NOT NULL OR to_regclass('pg_temp.probe_temp2') IS NOT NULL AS present").then((r) => r.rows[0].present).catch(() => false);
      const adv = await c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'").then((r) => r.rows[0].n).catch(() => 0);
      return { ok: true, text, inSession: { temp, advisory: adv } };
    } catch (e) {
      return { ok: false, sqlstate: e.code, error: String(e.message).slice(0, 400) };
    } finally {
      await c.end().catch(() => {});
    }
  }
  const r = await mcp.runSql({ sql, projectId: state.projectId, branchId: state.branchId, database: state.database });
  return r.ok ? { ok: true, text: (r.text || "").slice(0, 400) } : { ok: false, sqlstate: r.sqlstate, error: (r.error || "").slice(0, 400), threw: r.threw };
}

const out = openResults(OUT_NAME, { project: state.projectId, branch: state.branchId, setups: SETUPS.map((s) => s.id), probes: PROBES.length, phase: process.env.MATRIX_PHASE || "baseline" });

for (const setup of SETUPS) {
  let mcp;
  if (setup.kind === "mcp") mcp = await openMcp({ readonly: setup.readonly, roleName: setup.roleName });
  const toolNames = setup.kind === "mcp" ? await mcp.listToolNames() : null;
  if (toolNames) out.write({ type: "tools", setup: setup.id, hasRunSqlTransaction: toolNames.includes("run_sql_transaction"), toolCount: toolNames.length });

  for (const probe of PROBES) {
    // Role GUC persists; clear it so each setup starts from the same state.
    if (probe.effect === "rolesetting") await owner.query("ALTER ROLE agent_ro RESET statement_timeout").catch(() => {});
    const before = await counters();
    const token = `${setup.id}:${probe.id}:${Date.now()}`;
    const sql = probe.sql.replace("PAYLOAD", token);
    notifications.length = 0;
    const res = await runProbe(setup, mcp, sql);
    if (probe.effect === "notify") await sleep(400); // let the notification arrive
    const after = await counters();

    const delivered = notifications.some((n) => n.payload === token);
    const deltas = { audit: after.audit - before.audit, lobjs: after.lobjs - before.lobjs, rolesettings: after.rolesettings - before.rolesettings };

    let effectObserved = false;
    if (res.ok) {
      if (probe.effect === "audit") effectObserved = deltas.audit > 0;
      else if (probe.effect === "largeobject") effectObserved = deltas.lobjs > 0;
      else if (probe.effect === "rolesetting") effectObserved = deltas.rolesettings > 0;
      else if (probe.effect === "notify") effectObserved = delivered;
      else if (probe.effect === "temp") effectObserved = res.inSession ? res.inSession.temp : true; // MCP: per-call, not in-session observable
      else if (probe.effect === "advisory") effectObserved = res.inSession ? res.inSession.advisory > 0 : true;
    }

    // Delivery check for disclosure probes: the data must actually have arrived.
    let deliveryOk = true;
    if (res.ok && probe.assertContains) deliveryOk = (res.text || "").includes(probe.assertContains);

    const exp = probe.expect[setup.id];
    const outcome = !res.ok ? "denied" : (["audit", "largeobject", "rolesetting", "notify", "temp", "advisory"].includes(probe.effect) && effectObserved ? "persisted" : "accepted");
    let matched;
    if (exp.allow) matched = res.ok && deliveryOk;
    else matched = !res.ok && res.sqlstate === exp.state;

    // Clean up a persisted role GUC so it does not leak into the next setup.
    if (probe.effect === "rolesetting" && deltas.rolesettings > 0) await owner.query("ALTER ROLE agent_ro RESET statement_timeout").catch(() => {});

    out.write({
      type: "probe", setup: setup.id, id: probe.id, group: probe.group,
      allowed: res.ok, outcome, sqlstate: res.ok ? null : (res.sqlstate ?? (res.threw ? "THREW" : null)),
      effect: probe.effect, effectObserved, deltas, delivered: probe.effect === "notify" ? delivered : undefined,
      expected: exp.allow ? "allow" : `deny ${exp.state}`, matched, deliveryOk,
      evidence: res.ok ? (res.text || "").slice(0, 200) : (res.error || "").slice(0, 200),
    });
  }
  if (mcp) await mcp.close();
  console.log(`setup ${setup.id} (${setup.label}) done`);
}

await owner.end().catch(() => {});
out.release();
console.log(`\nmatrix written to ${out.file} (stamp ${out.stamp}). next: npm run lock-stall`);
