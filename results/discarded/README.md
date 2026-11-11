# Discarded runs, kept as evidence

`lock-stall-wrong-table.jsonl` was written by an earlier version of
`scripts/05-lock-stall.mjs`, before a method bug was fixed. That version sent
the app's writes to a side table (`app.pulse`) instead of `app.orders`, the
table the migration alters. The migration stall it recorded is real (about
12.6 s on the primary, about 160 ms with the agent on a read replica), but the
app writes never touched the locked table, so their latency in the stall window
matched the baseline. It could not show the write pile-up it was meant to show.

The fixed script writes to `app.orders` from several concurrent writers. These
lines are stamped by the old script, so `npm run verify-stamps` skips this
folder on purpose.

`matrix-pre-lib-fix.jsonl` is a complete run of the probe matrix made before a
fix to `lib/neon.mjs` (operations with status `skipped` were treated as still
pending, which hung the cost stage). The fix does not touch any code the matrix
runs, so the final matrix should reproduce these outcomes probe for probe;
`10-summarize.mjs` does not read this folder.

`matrix-run2.jsonl` and `lock-stall-run2.jsonl` are complete runs made after the
lock-stall fix, but before two more fixes to `lib/` (`deleteBranch` was missing,
which stopped the drift stage, and the MCP call now takes a longer timeout for
the heavy read). Their stamps belong to that older `lib/`, so the final runs in
`results/` replace them. The matrix outcomes are kept to compare run against
run.

## Run against run

`node scripts/compare-matrix-runs.mjs` compares the final `results/matrix.jsonl`
with the two older complete runs, probe by probe (allowed or denied, SQLSTATE,
outcome). Its output for the published run:

```text
results/matrix.jsonl (160) vs results/discarded/matrix-pre-lib-fix.jsonl (160): 0 differences
results/matrix.jsonl (160) vs results/discarded/matrix-run2.jsonl (160): 0 differences
```
