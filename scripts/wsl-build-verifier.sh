#!/usr/bin/env bash
# Build a BN254 Groth16 verifier WASM with a given VK embedded, from inside WSL.
# Usage: bash scripts/wsl-build-verifier.sh <vk-relative-path> <out-wasm-name>
#   e.g. bash scripts/wsl-build-verifier.sh circuits/build/transfer_vk.json transfer_verifier.wasm
set -uo pipefail

VK_REL="${1:?vk path relative to repo root}"
OUT_NAME="${2:?output wasm name}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$ROOT/_reference/stellar-private-payments"
OUT="$ROOT/contracts/build"
export VERIFIER_VK_JSON="$ROOT/$VK_REL"
export PATH="/usr/local/bin:$HOME/.cargo/bin:$PATH"

mkdir -p "$OUT"
echo "BUILD START $(date) — VK=$VK_REL -> $OUT_NAME"
[ -f "$VERIFIER_VK_JSON" ] || { echo "VK missing: $VERIFIER_VK_JSON"; exit 1; }

cd "$REF" || { echo "REF dir missing"; exit 1; }
stellar contract build --package circom-groth16-verifier --out-dir "$OUT"
code=$?
if [ $code -eq 0 ] && [ -f "$OUT/circom_groth16_verifier.wasm" ]; then
  cp "$OUT/circom_groth16_verifier.wasm" "$OUT/$OUT_NAME"
  echo "OK -> $OUT/$OUT_NAME ($(wc -c < "$OUT/$OUT_NAME") bytes)"
fi
echo "BUILD EXIT: $code"
exit $code
