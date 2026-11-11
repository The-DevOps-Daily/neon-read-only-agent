#!/usr/bin/env bash
# Stage 9: after hardening, run the probe matrix again for the two setups that
# matter, the direct read_only connection (S1) and the recommended read-only
# MCP pin (S3), into results/matrix-hardened.jsonl. The summarizer then shows
# which probes flipped from allowed to denied.
set -euo pipefail
cd "$(dirname "$0")/.."
MATRIX_SETUPS="S1,S3" MATRIX_OUT="matrix-hardened" MATRIX_PHASE="hardened" node scripts/04-matrix.mjs
echo "rerun done. next: npm run summarize"
