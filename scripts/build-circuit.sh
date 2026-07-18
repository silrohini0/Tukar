#!/usr/bin/env bash
# Generic: compile -> trusted setup -> prove -> verify a circuit.
# Usage: bash scripts/build-circuit.sh <name> <ptauPower> <input-gen.mjs>
#   <name>        circuit file circuits/<name>.circom (and main component)
#   <ptauPower>   powers-of-tau size 2^power (>= ceil(log2 constraints))
#   <input-gen>   node script printing input.json to stdout
set -euo pipefail

NAME="${1:?circuit name}"
POW="${2:?ptau power}"
GEN="${3:?input generator}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CIRCOM="$(command -v circom || echo ./tools/bin/circom.exe)"
SNARKJS="npx --no-install snarkjs"
BUILD="circuits/build"
mkdir -p "$BUILD"

echo "==> [1/5] Compiling $NAME.circom"
"$CIRCOM" "circuits/$NAME.circom" --r1cs --wasm --sym -l node_modules -o "$BUILD"
$SNARKJS r1cs info "$BUILD/$NAME.r1cs" | grep -i constraints || true

# Phase-1 = the REAL Hermez perpetual Powers-of-Tau ceremony (a multi-party
# ceremony — no locally-known toxic waste), exactly what the DEPLOYED verifiers
# were built from. We deliberately do NOT `powersoftau new` a local phase-1: that
# would have locally-known waste AND a different phase-1, so the rebuilt zkeys
# wouldn't match the on-chain verifiers. 2^14 covers every circuit here
# (transfer is the largest at 15884 < 16384 constraints).
PTAU="$BUILD/pot14_hez.ptau"
HEZ_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau"
if [ ! -f "$PTAU" ]; then
  echo "==> [2/5] Fetching Hermez phase-1 ptau (powersOfTau28_hez_final_14)"
  curl -fSL "$HEZ_URL" -o "$PTAU"
else
  echo "==> [2/5] Reusing Hermez phase-1 ptau $PTAU"
fi

# Reproducibility: reuse the committed proving key if present. snarkjs trusted
# setup is NOT bit-reproducible, so regenerating it would invalidate the already
# deployed verifier. Delete circuits/build/${NAME}_final.zkey to force a new setup
# (then you must rebuild + redeploy that verifier).
if [ -f "$BUILD/${NAME}_final.zkey" ]; then
  echo "==> [3/5] Reusing existing ${NAME}_final.zkey (committed key)"
else
  echo "==> [3/5] Groth16 setup"
  $SNARKJS groth16 setup "$BUILD/$NAME.r1cs" "$PTAU" "$BUILD/${NAME}_0.zkey"
  $SNARKJS zkey contribute "$BUILD/${NAME}_0.zkey" "$BUILD/${NAME}_final.zkey" --name=k1 -v -e="corredor $NAME key"
fi
$SNARKJS zkey export verificationkey "$BUILD/${NAME}_final.zkey" "$BUILD/${NAME}_vk.json"
# Reproducibility assertion: prove the zkey's phase-2 was built on the Hermez
# phase-1 above (this is what makes the "no locally-known toxic waste" claim true
# and checkable). Fails loudly if a stale local-ptau key ever sneaks back in.
$SNARKJS zkey verify "$BUILD/$NAME.r1cs" "$PTAU" "$BUILD/${NAME}_final.zkey"

echo "==> [4/5] Input + witness + proof"
node "$GEN" > "$BUILD/${NAME}_input.json"
$SNARKJS wtns calculate "$BUILD/${NAME}_js/${NAME}.wasm" "$BUILD/${NAME}_input.json" "$BUILD/${NAME}.wtns"
$SNARKJS groth16 prove "$BUILD/${NAME}_final.zkey" "$BUILD/${NAME}.wtns" "$BUILD/${NAME}_proof.json" "$BUILD/${NAME}_public.json"

echo "==> [5/5] Verify"
$SNARKJS groth16 verify "$BUILD/${NAME}_vk.json" "$BUILD/${NAME}_public.json" "$BUILD/${NAME}_proof.json"
echo "OK: $NAME verified. Public signals:"
cat "$BUILD/${NAME}_public.json"; echo
