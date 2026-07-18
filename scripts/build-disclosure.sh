#!/usr/bin/env bash
# Compile -> trusted setup -> prove -> verify the Tukar disclosure circuit.
# End-to-end proof that the ZK works (Groth16 over BN254, snarkjs default curve).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CIRCOM="$(command -v circom || echo ./tools/bin/circom.exe)"
SNARKJS="npx --no-install snarkjs"
BUILD="circuits/build"
mkdir -p "$BUILD"

echo "==> [1/6] Compiling disclosure.circom"
"$CIRCOM" circuits/disclosure.circom --r1cs --wasm --sym -l node_modules -o "$BUILD"

echo "==> [2/6] Powers of Tau — REAL Hermez phase-1 ceremony (no locally-known waste)"
# Same Hermez phase-1 the deployed verifier was built from (and the same 2^14 ptau
# the other three circuits use), NOT a fresh local one — a local phase-1 has
# locally-known toxic waste and a different phase-1, so its zkey wouldn't match the
# on-chain verifier. Disclosure is only 671 constraints, so 2^14 is ample.
PTAU="$BUILD/pot14_hez.ptau"
HEZ_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau"
if [ ! -f "$PTAU" ]; then
  curl -fSL "$HEZ_URL" -o "$PTAU"
fi

# Reproducibility: reuse the committed proving key if present (snarkjs setup is
# not bit-reproducible; regenerating it would invalidate the deployed verifier).
if [ -f "$BUILD/disclosure_final.zkey" ]; then
  echo "==> [3/6] Reusing existing disclosure_final.zkey (committed key)"
else
  echo "==> [3/6] Groth16 setup (phase 2)"
  $SNARKJS groth16 setup "$BUILD/disclosure.r1cs" "$PTAU" "$BUILD/disclosure_0000.zkey"
  $SNARKJS zkey contribute "$BUILD/disclosure_0000.zkey" "$BUILD/disclosure_final.zkey" --name="corredor-key" -v -e="corredor entropy two"
fi
$SNARKJS zkey export verificationkey "$BUILD/disclosure_final.zkey" "$BUILD/verification_key.json"
# Assert the zkey derives from the Hermez phase-1 (makes the no-waste claim checkable).
$SNARKJS zkey verify "$BUILD/disclosure.r1cs" "$PTAU" "$BUILD/disclosure_final.zkey"

echo "==> [4/6] Generate sample input"
node scripts/gen-input.mjs > "$BUILD/input.json"

echo "==> [5/6] Witness + proof"
$SNARKJS wtns calculate "$BUILD/disclosure_js/disclosure.wasm" "$BUILD/input.json" "$BUILD/witness.wtns"
$SNARKJS groth16 prove "$BUILD/disclosure_final.zkey" "$BUILD/witness.wtns" "$BUILD/proof.json" "$BUILD/public.json"

echo "==> [6/6] Verify"
$SNARKJS groth16 verify "$BUILD/verification_key.json" "$BUILD/public.json" "$BUILD/proof.json"

echo ""
echo "==> Public signals (commitment, disclosedAmount, auditContextHash):"
cat "$BUILD/public.json"
echo ""
echo "Done. Constraint count:"
"$CIRCOM" circuits/disclosure.circom --r1cs -l node_modules -o "$BUILD" 2>&1 | grep -i "constraints" || true
