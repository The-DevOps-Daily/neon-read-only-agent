// Checks that every stamped results file was written by the code of the commit
// in results/STAMPED_AT. Each stamp must equal the hash of lib/, schema/, the
// script that wrote it, and the lockfile, as they are in that commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/record.mjs";

const commit = readFileSync(join(ROOT, "results", "STAMPED_AT"), "utf8").trim();
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { maxBuffer: 64 << 20 });
const show = (path) => git("show", `${commit}:${path}`);
const ls = (dir) => git("ls-tree", "--name-only", `${commit}:${dir}`).toString().split("\n").filter(Boolean).sort();

// The same hash as lib/record.mjs codeStamp(), over the files in the commit.
function stampAt(script) {
  const h = createHash("sha256");
  for (const dir of ["lib", "schema"]) for (const f of ls(dir)) {
    if (f.endsWith(".mjs") || f.endsWith(".sql") || f.endsWith(".json")) h.update(`${dir}/${f}`).update(show(`${dir}/${f}`));
  }
  h.update(show(`scripts/${script}`));
  h.update(show("package-lock.json"));
  return h.digest("hex").slice(0, 12);
}

// results file -> the script that writes it.
const WRITER = {
  "matrix.jsonl": "04-matrix.mjs",
  "matrix-hardened.jsonl": "04-matrix.mjs",
  "lock-stall.jsonl": "05-lock-stall.mjs",
  "cost.jsonl": "06-cost.mjs",
  "drift.jsonl": "07-drift.mjs",
  "harden.jsonl": "08-harden.mjs",
};

let failures = 0;
for (const file of readdirSync(join(ROOT, "results")).filter((f) => f.endsWith(".jsonl")).sort()) {
  const writer = WRITER[file];
  if (!writer) { console.log(`?  ${file}: no known writer, skipped`); continue; }
  const want = stampAt(writer);
  const lines = readFileSync(join(ROOT, "results", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stamps = new Set(lines.map((l) => l.stamp));
  if (stamps.size !== 1 || !stamps.has(want)) {
    failures++;
    console.log(`FAIL ${file}: stamps ${[...stamps].join(",")} != ${want} (writer ${writer})`);
  } else {
    console.log(`ok   ${file}: ${want} (${lines.length} lines)`);
  }
}

if (failures) { console.error(`\n${failures} file(s) failed stamp verification`); process.exit(1); }
console.log("\nall results files verify against", commit);
