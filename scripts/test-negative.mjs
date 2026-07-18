// QA soundness tests for the transfer and compliance circuits.
// Confirms: (1) valid inputs prove, (2) inputs that violate a core constraint
// CANNOT produce a proof (witness generation fails).
import * as snarkjs from "snarkjs";
import { existsSync } from "node:fs";
import { makePoseidon, buildTree } from "./merkle.mjs";

const { h1, h2, h3 } = await makePoseidon();
const LEVELS = 10;
let pass = 0, fail = 0;

async function expectProve(name, wasm, zkey, input) {
  try {
    await snarkjs.groth16.fullProve(input, wasm, zkey);
    console.log(`  ✅ ${name}: proved (expected)`); pass++;
  } catch (e) {
    console.log(`  ❌ ${name}: FAILED to prove but should have`); fail++;
  }
}
async function expectReject(name, wasm, zkey, input) {
  try {
    await snarkjs.groth16.fullProve(input, wasm, zkey);
    console.log(`  ❌ ${name}: proved but should have been REJECTED`); fail++;
  } catch (e) {
    console.log(`  ✅ ${name}: rejected (expected)`); pass++;
  }
}

// ---------- transfer ----------
function transferInput() {
  const ins = [
    { amount: 600n, privKey: 1001n, blinding: 11n, index: 3 },
    { amount: 400n, privKey: 1002n, blinding: 22n, index: 7 },
  ].map((n) => {
    const pubKey = h1(n.privKey);
    return { ...n, pubKey, commitment: h3(n.amount, pubKey, n.blinding) };
  });
  const leaves = [];
  for (const n of ins) leaves[n.index] = n.commitment;
  const tree = buildTree(h2, leaves, LEVELS);
  const outs = [
    { amount: 700n, pubKey: h1(2001n), blinding: 33n },
    { amount: 300n, pubKey: h1(2002n), blinding: 44n },
  ].map((o) => ({ ...o, commitment: h3(o.amount, o.pubKey, o.blinding) }));
  return {
    root: tree.root.toString(), publicAmount: "0", extDataHash: "123456789",
    inputNullifier: ins.map((n) => h3(n.commitment, BigInt(n.index), n.privKey).toString()),
    outputCommitment: outs.map((o) => o.commitment.toString()),
    inAmount: ins.map((n) => n.amount.toString()), inPrivKey: ins.map((n) => n.privKey.toString()),
    inBlinding: ins.map((n) => n.blinding.toString()), inLeafIndex: ins.map((n) => n.index.toString()),
    inPathElements: ins.map((n) => tree.proof(n.index).pathElements.map((x) => x.toString())),
    outAmount: outs.map((o) => o.amount.toString()), outPubkey: outs.map((o) => o.pubKey.toString()),
    outBlinding: outs.map((o) => o.blinding.toString()),
  };
}

// ---------- compliance ----------
function complianceInput() {
  const sourceKey = h1(424242n);
  const leaves = []; [h1(1n), h1(2n), h1(3n), h1(4n)].forEach((m, i) => (leaves[i] = m));
  leaves[5] = sourceKey;
  const tree = buildTree(h2, leaves, LEVELS);
  const { pathElements, leafIndex } = tree.proof(5);
  return {
    aspRoot: tree.root.toString(),
    denyList: [h1(9001n), h1(9002n), h1(9003n), h1(9004n)].map((d) => d.toString()),
    bindHash: "987654321", sourceKey: sourceKey.toString(),
    pathElements: pathElements.map((x) => x.toString()), leafIndex: leafIndex.toString(),
  };
}

// Prefer freshly-built artifacts when present (local dev), else fall back to the
// committed frontend/circuit/* — so this soundness suite also runs in CI, which only
// has the committed artifacts (circuits/build/ is gitignored).
const pick = (build, committed) => (existsSync(build) ? build : committed);
const TW = pick("circuits/build/transfer_js/transfer.wasm", "frontend/circuit/transfer.wasm");
const TZ = pick("circuits/build/transfer_final.zkey", "frontend/circuit/transfer_final.zkey");
const CW = pick("circuits/build/compliance_js/compliance.wasm", "frontend/circuit/compliance.wasm");
const CZ = pick("circuits/build/compliance_final.zkey", "frontend/circuit/compliance_final.zkey");

console.log("transfer:");
await expectProve("valid", TW, TZ, transferInput());
const t1 = transferInput(); t1.outAmount[0] = "701";           // breaks value conservation
await expectReject("broken value conservation", TW, TZ, t1);
const t2 = transferInput(); t2.inputNullifier[0] = "12345";    // wrong nullifier
await expectReject("forged nullifier", TW, TZ, t2);

console.log("compliance:");
await expectProve("valid", CW, CZ, complianceInput());
const c1 = complianceInput(); c1.denyList[0] = c1.sourceKey;   // source IS deny-listed
await expectReject("source on deny-list", CW, CZ, c1);
const c2 = complianceInput(); c2.aspRoot = "42";               // not a member of allow-list
await expectReject("wrong ASP root (non-member)", CW, CZ, c2);

console.log(`\n${fail === 0 ? "ALL SOUNDNESS CHECKS PASSED ✅" : "SOUNDNESS CHECKS FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
