// Validate the exact browser proving flow (fullProve + verify) against the
// shipped circuit artifacts. Covers: valid proof, tampered claim, false witness.
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { readFileSync } from "node:fs";

const WASM = "frontend/circuit/disclosure.wasm";
const ZKEY = "frontend/circuit/disclosure_final.zkey";
const vkey = JSON.parse(readFileSync("frontend/circuit/verification_key.json", "utf8"));

const poseidon = await buildPoseidon();
const F = poseidon.F;

const amount = 5000000000n; // 500 USDC in stroops
const pubKey = 111111111n;
const blinding = 222222222n;
const commitment = F.toObject(poseidon([amount, pubKey, blinding])).toString();

const base = {
  commitment,
  disclosedAmount: amount.toString(),
  auditContextHash: "42",
  amount: amount.toString(),
  pubKey: pubKey.toString(),
  blinding: blinding.toString(),
};

// 1. Valid proof
const { proof, publicSignals } = await snarkjs.groth16.fullProve(base, WASM, ZKEY);
const okValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
console.log("1. valid proof verifies        :", okValid, "(expect true)");
console.log("   publicSignals               :", JSON.stringify(publicSignals));

// 2. Tampered claim: regulator handed a wrong disclosed amount
const tampered = publicSignals.slice();
tampered[1] = (BigInt(publicSignals[1]) + 12345n).toString();
const okTampered = await snarkjs.groth16.verify(vkey, tampered, proof);
console.log("2. tampered claim verifies      :", okTampered, "(expect false)");

// 3. False witness: disclose an amount that contradicts the commitment
let threw = false;
try {
  await snarkjs.groth16.fullProve({ ...base, disclosedAmount: "9999" }, WASM, ZKEY);
} catch { threw = true; }
console.log("3. false witness proof rejected :", threw, "(expect true)");

const allGood = okValid && !okTampered && threw;
console.log(allGood ? "\nALL CHECKS PASSED ✅" : "\nCHECKS FAILED ❌");
process.exit(allGood ? 0 : 1);
