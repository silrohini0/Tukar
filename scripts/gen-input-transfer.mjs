// Sample input for transfer.circom (levels=10, 2-in 2-out, pure private transfer).
import { makePoseidon, buildTree } from "./merkle.mjs";

const LEVELS = 10;
const { h1, h2, h3 } = await makePoseidon();

// Two input notes owned by the sender, total 1000 USDC (stroops scaled down for demo).
const ins = [
  { amount: 600n, privKey: 1001n, blinding: 11n, index: 3 },
  { amount: 400n, privKey: 1002n, blinding: 22n, index: 7 },
].map((n) => {
  const pubKey = h1(n.privKey);
  const commitment = h3(n.amount, pubKey, n.blinding);
  return { ...n, pubKey, commitment };
});

// Build the pool tree containing both input commitments.
const leaves = [];
for (const n of ins) leaves[n.index] = n.commitment;
const tree = buildTree(h2, leaves, LEVELS);

// Two output notes (re-split 700/300), pure transfer so publicAmount = 0.
const outs = [
  { amount: 700n, pubKey: h1(2001n), blinding: 33n },
  { amount: 300n, pubKey: h1(2002n), blinding: 44n },
].map((o) => ({ ...o, commitment: h3(o.amount, o.pubKey, o.blinding) }));

const input = {
  root: tree.root.toString(),
  publicAmount: "0",
  extDataHash: "123456789",
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
