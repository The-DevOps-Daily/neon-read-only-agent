# neon-read-only-agent

Measure what a Neon `read_only` role, the Neon MCP Server read-only mode, and the MCP role pin actually stop an agent from doing to a Lakebase Postgres branch, and what they leave open. Real Neon project through the Neon API, the hosted Neon MCP Server called the way an agent calls it, a fake SaaS schema, every number stamped by the commit that produced it. Nothing simulated.

A probe matrix of 40 one-statement probes runs across four access setups (a direct `read_only` connection, and three Neon MCP Server configurations), plus two incident reproductions (a read that stalls a migration, a read that runs up compute), schema-drift cases, and a hardening pass with a re-run.

```sh
cp .env.example .env
npm install
npm test
npm run project
npm run seed
npm run roles
npm run matrix
npm run lock-stall
npm run cost
npm run drift
npm run harden
npm run rerun
npm run summarize
npm run verify-stamps
npm run teardown
```

What each stage does:

- `project` creates the throwaway Neon project and records its settings.
- `seed` applies the schema and seeds deterministic fake data.
- `roles` creates the scoped roles and records the Neon CLI output.
- `matrix` runs the probe matrix across the four access setups.
- `lock-stall` reproduces a long-read migration stall and its mitigations.
- `cost` compares a heavy read on the primary and a capped read replica.
- `drift` checks role access as tables, schemas, and branches change.
- `harden` applies the hardening SQL and records the grant state.
- `rerun` repeats the relevant probes after hardening.
- `summarize` writes the machine and human summaries.
- `verify-stamps` checks result stamps against `results/STAMPED_AT`.
- `teardown` deletes the throwaway project.

It creates and deletes ONE throwaway Neon project. Every results file is stamped and `npm run verify-stamps` checks them against `results/STAMPED_AT`. Results are JSON lines.

## Method notes

- Each probe in `lib/probes.mjs` declares its expected result per setup before the run (allowed, or denied with an exact SQLSTATE). A result that does not match is a harness failure, not a pass. Where a first run disagreed with a prediction, the prediction was changed with a comment saying why; outcomes were never edited.
- A stamp is a hash of `lib/`, `schema/`, the script that wrote the file and the lockfile, so files written by different scripts carry different stamps by design. `matrix.jsonl` and `matrix-hardened.jsonl` share one because the same script writes both.
- `09-rerun.sh` reuses the matrix runner, which clears `agent_ro`'s `statement_timeout` before it starts. The 30-second default from `schema/harden.sql` is therefore not in place during the re-run. No probe depends on it.
- `results/discarded/` keeps runs that were replaced, with the reason for each. `verify-stamps` does not read that folder.
- `num_cpus()` rounds the compute's vCPU limit up to a whole number, so the cost figures are upper bounds.
- Traces: durable writes (audit rows, large objects, role settings) and `NOTIFY` delivery are checked from an owner session in every setup. Temp tables and session advisory locks are checked inside the probe's own session only on the direct connection (S1). On the MCP setups each `run_sql` is a separate request, so those two traces are recorded from a successful call (a `CREATE TEMP TABLE` that succeeded, a `pg_advisory_lock()` that returned) and are inferences, not observations.
- `npm run compare` (`scripts/compare-matrix-runs.mjs`) checks the final matrix against the older runs in `results/discarded/`.
- A correction to a comment in `schema/harden.sql`: it says NOTIFY and advisory locks are not privilege-controlled. That is true of the `NOTIFY` statement. `pg_notify()` and the advisory-lock functions run on the `EXECUTE` that `PUBLIC` holds on built-in functions; the hardening revokes `EXECUTE` only in the `app` schema. The file is left as it was run, because it is part of every stamp.

See the write-up: TODO(post-url)
GitHub: TODO(repo-url)

MIT License.
