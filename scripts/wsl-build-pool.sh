#!/usr/bin/env bash
# Build the Tukar pool contract WASM (standalone crate) from inside WSL.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POOL="$ROOT/contracts/pool"
OUT="$ROOT/contracts/build"
export PATH="/usr/local/bin:$HOME/.cargo/bin:$PATH"
mkdir -p "$OUT"

cd "$POOL" || { echo "pool dir missing"; exit 1; }
echo "BUILD START $(date)"
stellar contract build --out-dir "$OUT"
code=$?
echo "BUILD EXIT: $code"
ls -la "$OUT/pool.wasm" 2>/dev/null || echo "no pool.wasm"
exit $code
