// Stage 8: apply the hardening SQL as the owner, and record the grant state
// before and after so the change is evidence, not a claim.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, connectionUri } from "../lib/neon.mjs";
import { withClient } from "../lib/db.mjs";
import { readState, openResults, ROOT } from "../lib/record.mjs";

loadEnv();
const state = readState();
const ownerUri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database });
const out = openResults("harden", { project: state.projectId });

const probeState = async (c) => {
  const temp = (await c.query("SELECT has_database_privilege('public', 'neondb', 'TEMP') AS v")).rows[0].v;
  const execFn = (await c.query("SELECT has_function_privilege('public', 'app.record_touch(text)', 'EXECUTE') AS v")).rows[0].v;
  const connLimit = (await c.query("SELECT rolconnlimit FROM pg_roles WHERE rolname = 'agent_ro'")).rows[0].rolconnlimit;
  const gucs = (await c.query("SELECT coalesce(array_to_string(s.setconfig, ', '), '') AS g FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid WHERE r.rolname = 'agent_ro'")).rows[0].g;
  return { publicTempOnDb: temp, publicExecuteRecordTouch: execFn, agentRoConnLimit: connLimit, agentRoGucs: gucs };
};

await withClient(ownerUri, async (c) => {
  const before = await probeState(c);
  out.write({ type: "before", ...before });
  console.log("before:", before);
  await c.query(readFileSync(join(ROOT, "schema", "harden.sql"), "utf8"));
  const after = await probeState(c);
  out.write({ type: "after", ...after });
  console.log("after: ", after);
});

out.release();
console.log(`\nharden written to ${out.file} (stamp ${out.stamp}). next: npm run rerun`);
