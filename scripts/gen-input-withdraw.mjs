// Input for a WITHDRAW: transfer circuit with publicAmount = 50 (value leaving
// the shielded set). Fresh input notes (distinct nullifiers from the transfer
// demo). outputs sum = inputs sum + publicAmount, satisfying sumIn+pa==sumOut.
import { makePoseidon, buildTree } from "./merkle.mjs";

const LEVELS = 10;
const { h1, h2, h3 } = await makePoseidon();

const ins = [
  { amount: 600n, privKey: 3001n, blinding: 71n, index: 2 },
  { amount: 400n, privKey: 3002n, blinding: 72n, index: 9 },
].map((n) => {
  const pubKey = h1(n.privKey);
  return { ...n, pubKey, commitment: h3(n.amount, pubKey, n.blinding) };
});
const leaves = [];
for (const n of ins) leaves[n.index] = n.commitment;
const tree = buildTree(h2, leaves, LEVELS);

const PUBLIC = 50n; // amount withdrawn to the public
const outs = [
  { amount: 700n, pubKey: h1(4001n), blinding: 73n },
  { amount: 350n, pubKey: h1(4002n), blinding: 74n }, // 1050 = 1000 + 50
].map((o) => ({ ...o, commitment: h3(o.amount, o.pubKey, o.blinding) }));

const input = {
  root: tree.root.toString(),
  publicAmount: PUBLIC.toString(),
  extDataHash: "424242",
  inputNullifier: ins.map((n) => h3(n.commitment, BigInt(n.index), n.privKey).toString()),
  outputCommitment: outs.map((o) => o.commitment.toString()),
  inAmount: ins.map((n) => n.amount.toString()),
  inPrivKey: ins.map((n) => n.privKey.toString()),
  inBlinding: ins.map((n) => n.blinding.toString()),
  inLeafIndex: ins.map((n) => n.index.toString()),
  inPathElements: ins.map((n) => tree.proof(n.index).pathElements.map((x) => x.toString())),
  outAmount: outs.map((o) => o.amount.toString()),
  outPubkey: outs.map((o) => o.pubKey.toString()),
  outBlinding: outs.map((o) => o.blinding.toString()),
};
console.log(JSON.stringify(input, null, 2));
