// Compares complete probe-matrix runs probe by probe: for each setup and probe,
// whether it was allowed, its SQLSTATE, and its outcome. Prints every
// difference. With no arguments it compares results/matrix.jsonl with the
// earlier runs kept in results/discarded/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/record.mjs";

const load = (file) => {
  const out = new Map();
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const p = JSON.parse(line);
    if (p.type === "probe") out.set(`${p.setup} ${p.id}`, `${p.allowed ? "allowed" : "denied " + p.sqlstate} ${p.outcome}`);
  }
  return out;
};

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["results/matrix.jsonl", "results/discarded/matrix-pre-lib-fix.jsonl", "results/discarded/matrix-run2.jsonl"];
const [base, ...others] = files.map((f) => ({ f, m: load(join(ROOT, f)) }));

let total = 0;
for (const o of others) {
  const keys = new Set([...base.m.keys(), ...o.m.keys()]);
  const diffs = [...keys].filter((k) => base.m.get(k) !== o.m.get(k));
  total += diffs.length;
  console.log(`${base.f} (${base.m.size}) vs ${o.f} (${o.m.size}): ${diffs.length} differences`);
  for (const k of diffs) console.log(`  ${k}: ${base.m.get(k)} | ${o.m.get(k)}`);
}
process.exit(total ? 1 : 0);
