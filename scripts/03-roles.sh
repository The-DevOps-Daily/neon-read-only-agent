#!/usr/bin/env bash
# Stage 3: create the scoped roles with the real Neon CLI (9.3.2), and record
# the commands and their output. The CLI runs the client-side SQL that grants
# the role its privileges; it is not a REST field.
#
# `roles create --output json` prints the new role's password. The output goes
# through redact() before it reaches the terminal or results/roles.txt, so no
# password or connection string is ever written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env for NEON_API_KEY.
set -a; [ -f .env ] && . ./.env; set +a
: "${NEON_API_KEY:?set NEON_API_KEY (see .env.example)}"

PID=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.state.json')).projectId)")
BID=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.state.json')).branchId)")
CLI="npx -y neon@9.3.2"

mkdir -p results
OUT=results/roles.txt
: > "$OUT"

# Drop password fields, and mask connection strings and Neon role passwords
# wherever they appear.
redact() {
  sed -E \
    -e '/"password"[[:space:]]*:/d' \
    -e 's#postgres(ql)?://[^[:space:]"]+#<connection string removed>#g' \
    -e 's#npg_[A-Za-z0-9]+#<password removed>#g'
}

run() {
  echo "\$ $*" | tee -a "$OUT"
  # The CLI reads NEON_API_KEY from the environment.
  "$@" 2>&1 | redact | tee -a "$OUT"
  echo "" | tee -a "$OUT"
}

echo "# neon CLI version" | tee -a "$OUT"
run $CLI --version

echo "# read_only role, scoped to the app schema" | tee -a "$OUT"
run $CLI roles create --project-id "$PID" --branch "$BID" --database neondb \
  --name agent_ro --access read_only --schema app --output json

echo "# read_write role, scoped to the app schema" | tee -a "$OUT"
run $CLI roles create --project-id "$PID" --branch "$BID" --database neondb \
  --name agent_rw --access read_write --schema app --output json

echo "roles created. recorded in $OUT (passwords removed)"
echo "next: npm run matrix"
