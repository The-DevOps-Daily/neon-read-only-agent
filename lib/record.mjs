// Results are JSON lines. Every line carries a stamp (a hash of the code and
// inputs that wrote it), and only one process may write a file at a time, so a
// stray runner from an earlier session cannot mix its lines into a new run.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname;

function hashDir(h, dir) {
  for (const f of readdirSync(join(ROOT, dir)).sort()) {
    if (f.endsWith(".mjs") || f.endsWith(".sql") || f.endsWith(".json")) h.update(`${dir}/${f}`).update(readFileSync(join(ROOT, dir, f)));
  }
}

// The hash covers lib/, schema/, the script that is running and the lockfile.
export function codeStamp(script = process.argv[1]) {
  const h = createHash("sha256");
  hashDir(h, "lib");
  hashDir(h, "schema");
  h.update(readFileSync(script));
  h.update(readFileSync(join(ROOT, "package-lock.json")));
  return h.digest("hex").slice(0, 12);
}

export function openResults(name, meta = {}) {
  const file = join(ROOT, "results", `${name}.jsonl`);
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new Error(`${lock} exists: another run is writing ${name}.jsonl`);
  }
  closeSync(fd);
  const release = () => existsSync(lock) && unlinkSync(lock);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  const stamp = codeStamp();
  if (!existsSync(file)) writeFileSync(file, "");
  const write = (event) => appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), stamp, ...event }) + "\n");
  write({ type: "start", ...meta });
  return { write, stamp, file, release };
}

// Reads a results file and refuses unstamped lines. With latest: true it keeps
// only the lines of the most recent run (the last "start" line and after).
export function readResults(name, { latest = false } = {}) {
  const file = join(ROOT, "results", `${name}.jsonl`);
  let lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (lines.some((l) => !l.stamp)) throw new Error(`${name}.jsonl has unstamped lines`);
  if (latest) {
    const i = lines.findLastIndex((l) => l.type === "start");
    lines = lines.slice(i);
    if (new Set(lines.map((l) => l.stamp)).size > 1) throw new Error(`${name}.jsonl: the last run has lines from more than one stamp`);
  }
  return lines;
}

export function readState() {
  const f = join(ROOT, ".state.json");
  if (!existsSync(f)) throw new Error(".state.json is missing: run npm run project first");
  return JSON.parse(readFileSync(f, "utf8"));
}

export function writeState(state) {
  writeFileSync(join(ROOT, ".state.json"), JSON.stringify(state, null, 2) + "\n");
}

export function readJson(rel) {
  return JSON.parse(readFileSync(isAbsolute(rel) ? rel : join(ROOT, rel), "utf8"));
}
