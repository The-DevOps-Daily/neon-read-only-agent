// Stage 10: read every results file and write results/summary.json plus a
// human summary. Every number the post quotes comes from here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readResults, ROOT } from "../lib/record.mjs";
import { PROBES } from "../lib/probes.mjs";

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

// --- matrix ---
const matrix = readResults("matrix", { latest: true }).filter((l) => l.type === "probe");
const tools = readResults("matrix", { latest: true }).filter((l) => l.type === "tools");
const bySetup = (s) => matrix.filter((p) => p.setup === s);
const setups = {};
for (const s of ["S1", "S2", "S3", "S4"]) {
  const rows = bySetup(s);
  setups[s] = {
    allowed: rows.filter((p) => p.allowed).length,
    denied: rows.filter((p) => !p.allowed).length,
    persisted: rows.filter((p) => p.outcome === "persisted").length,
    mismatches: rows.filter((p) => !p.matched).map((p) => p.id),
  };
}
const s1 = bySetup("S1");
const s1Leftovers = s1.filter((p) => p.allowed).map((p) => ({ id: p.id, group: p.group, outcome: p.outcome }));
const s1Writes = s1.filter((p) => p.allowed && p.outcome === "persisted").map((p) => ({ id: p.id, group: p.group, effect: p.effect }));
// Durable: still in the database after the session ends. Session: lives only
// as long as the connection. Signal: delivered to another session.
const KIND = { audit: "durable", largeobject: "durable", rolesetting: "durable", temp: "session", advisory: "session", notify: "signal" };
const effectsByKind = (rows) => {
  const out = { durable: [], session: [], signal: [] };
  for (const p of rows.filter((x) => x.allowed && x.outcome === "persisted")) out[KIND[p.effect]].push(p.id);
  return out;
};
const effectKinds = Object.fromEntries(["S1", "S2", "S3", "S4"].map((s) => [s, effectsByKind(bySetup(s))]));

// --- hardening flips (S1 baseline allowed -> S1 hardened denied) ---
let hardening = null;
try {
  const hardened = readResults("matrix-hardened", { latest: true }).filter((l) => l.type === "probe");
  const h1 = new Map(hardened.filter((p) => p.setup === "S1").map((p) => [p.id, p]));
  const flipped = [], stayedOpen = [];
  for (const p of s1.filter((x) => x.allowed)) {
    const after = h1.get(p.id);
    if (after && !after.allowed) flipped.push({ id: p.id, group: p.group, hardenedSqlstate: after.sqlstate });
    else if (after) stayedOpen.push({ id: p.id, group: p.group });
  }
  hardening = { flipped, stayedOpen };
} catch { /* rerun not done yet */ }

// --- lock-stall ---
let lockStall = null;
try {
  const runs = readResults("lock-stall", { latest: true }).filter((l) => l.type === "run");
  lockStall = {};
  for (const v of ["primary", "replica", "lock_timeout"]) {
    const rs = runs.filter((r) => r.variant === v);
    if (!rs.length) continue;
    lockStall[v] = {
      runs: rs.length,
      migrationMs: { median: median(rs.map((r) => r.migrationMs)), range: range(rs.map((r) => r.migrationMs)) },
      migrationOk: rs.every((r) => r.migrationOk),
      migrationState: rs.find((r) => r.migrationState)?.migrationState,
      stallP99: { median: median(rs.map((r) => r.stallP99).filter((x) => x != null)), range: range(rs.map((r) => r.stallP99).filter((x) => x != null)) },
      stallMax: { median: median(rs.map((r) => r.stallMax).filter((x) => x != null)) },
      worstInsertMs: { median: median(rs.map((r) => r.worstInsertMs).filter((x) => x != null)), range: range(rs.map((r) => r.worstInsertMs).filter((x) => x != null)) },
      overOneSecond: rs.map((r) => r.overOneSecond),
      writesInWindow: rs.map((r) => r.stallInserts),
      readsOk: rs.filter((r) => r.readOk).length,
      baselineP50: median(rs.map((r) => r.baselineP50).filter((x) => x != null)),
      maxWaitingBackends: Math.max(...rs.map((r) => r.maxWaitingBackends || 0)),
    };
  }
} catch { /* not done */ }

// --- cost ---
let cost = null;
try {
  const runs = readResults("cost", { latest: true }).filter((l) => l.type === "run");
  cost = {};
  for (const r of runs) cost[r.target] = { seconds: r.seconds, ok: r.ok, peakVcpus: r.peakVcpus, vcpuSecondsUpperBound: r.vcpuSecondsUpperBound, costScaleUsdUpperBound: r.costScaleUsdUpperBound, costLaunchUsdUpperBound: r.costLaunchUsdUpperBound, samples: r.samples };
} catch { /* not done */ }

// --- drift ---
let drift = null;
try {
  drift = readResults("drift", { latest: true }).filter((l) => l.type === "case");
} catch { /* not done */ }

// --- harden ---
let harden = null;
try {
  const h = readResults("harden", { latest: true });
  harden = { before: h.find((l) => l.type === "before"), after: h.find((l) => l.type === "after") };
} catch { /* not done */ }

const summary = {
  generatedAt: new Date().toISOString(),
  probeCount: PROBES.length,
  runSqlTransactionOffered: Object.fromEntries(tools.map((t) => [t.setup, t.hasRunSqlTransaction])),
  setups,
  headline: {
    s1AllowedOf40: `${setups.S1.allowed} of ${PROBES.length}`,
    s1PersistentWrites: s1Writes.length,
  },
  s1Leftovers,
  s1Writes,
  effectKinds,
  hardening,
  lockStall,
  cost,
  drift,
  harden,
};

writeFileSync(join(ROOT, "results", "summary.json"), JSON.stringify(summary, null, 2) + "\n");

console.log("probe count:", PROBES.length);
for (const s of ["S1", "S2", "S3", "S4"]) console.log(`  ${s}: allowed ${setups[s].allowed}, denied ${setups[s].denied}, persisted ${setups[s].persisted}, mismatches ${setups[s].mismatches.length}`);
console.log("run_sql_transaction offered:", summary.runSqlTransactionOffered);
console.log(`HEADLINE: ${summary.headline.s1AllowedOf40} probes not blocked under the read_only role; ${s1Writes.length} left a persistent trace`);
console.log("S1 persistent writes:", s1Writes.map((w) => w.id).join(", "));
for (const s of ["S1", "S2", "S3", "S4"]) console.log(`  ${s} effects: durable [${effectKinds[s].durable.join(", ")}] session [${effectKinds[s].session.join(", ")}] signal [${effectKinds[s].signal.join(", ")}]`);
if (hardening) console.log("hardening flipped:", hardening.flipped.map((f) => f.id).join(", "), "| stayed open:", hardening.stayedOpen.map((f) => f.id).join(", "));
if (lockStall) for (const [v, d] of Object.entries(lockStall)) console.log(`lock-stall ${v}: migration ${d.migrationMs.median}ms ${JSON.stringify(d.migrationMs.range)}, worst write ${d.worstInsertMs.median}ms ${JSON.stringify(d.worstInsertMs.range)}, writes over 1 s ${JSON.stringify(d.overOneSecond)}, waiting ${d.maxWaitingBackends}, reads ok ${d.readsOk}/${d.runs}`);
if (cost) for (const [t, d] of Object.entries(cost)) console.log(`cost ${t}: ${d.seconds}s, peak ${d.peakVcpus} vCPU, <= ${d.vcpuSecondsUpperBound} vCPU-s, <= $${d.costScaleUsdUpperBound} Scale`);
console.log("\nsummary written to results/summary.json");
