// Convert a snarkjs Groth16 proof.json + public.json into the byte components
// expected by the Soroban BN254 verifier contract.
//
// Key subtlety: Soroban BN254 G2 points use **c1||c0 (imaginary||real)** byte
// ordering, while snarkjs stores Fq2 as [c0, c1] (real, imaginary). For every G2
// coordinate we therefore emit c1 first, then c0. Each field element is a
// 32-byte big-endian value.
//
// Usage:
//   node scripts/proof-to-soroban.mjs circuits/build/proof.json circuits/build/public.json
//
// Output: JSON with a (G1,64B), b (G2,128B), c (G1,64B), proof256 (concatenated),
// and publicInputs (array of 32B Fr hex), all as 0x-prefixed hex.
import { readFileSync } from "node:fs";

const [, , proofPath, publicPath] = process.argv;
if (!proofPath || !publicPath) {
  console.error("usage: node proof-to-soroban.mjs <proof.json> <public.json>");
  process.exit(1);
}

const proof = JSON.parse(readFileSync(proofPath, "utf8"));
const publicSignals = JSON.parse(readFileSync(publicPath, "utf8"));

// decimal string -> 32-byte big-endian hex (no 0x)
function fe(dec) {
  let h = BigInt(dec).toString(16);
  if (h.length > 64) throw new Error(`field element too large: ${dec}`);
  return h.padStart(64, "0");
}

// G1 [x, y, "1"] -> x||y (64 bytes)
function g1(pt) {
  return fe(pt[0]) + fe(pt[1]);
}

// G2 [[x_c0, x_c1], [y_c0, y_c1], ...] -> Soroban c1||c0 per coord (128 bytes)
function g2(pt) {
  const [x, y] = pt;
  // swap each Fq2: emit c1 (imaginary) before c0 (real)
  return fe(x[1]) + fe(x[0]) + fe(y[1]) + fe(y[0]);
}

const a = g1(proof.pi_a);
const b = g2(proof.pi_b);
const c = g1(proof.pi_c);
const proof256 = a + b + c; // 64 + 128 + 64 = 256 bytes

const publicInputs = publicSignals.map((s) => "0x" + fe(s));

const out = {
  a: "0x" + a,
  b: "0x" + b,
  c: "0x" + c,
  proof256: "0x" + proof256,
  publicInputs,
};

console.log(JSON.stringify(out, null, 2));
