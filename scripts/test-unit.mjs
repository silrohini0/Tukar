// Frontend UNIT tests (pure logic, no browser, no network). Covers the client-side
// Poseidon Merkle tree (frontend/tree.js) that builds roots + inclusion paths for
// deposits/withdraws — the piece that MUST agree with the deployed pool's genesis
// root and with circuits/lib/merkleProof.circom. Zero-dependency: Node assert +
// circomlibjs (already a dev dep).
//
//   node scripts/test-unit.mjs
import assert from "node:assert/strict";
import { buildPoseidon } from "circomlibjs";
import { makeTree } from "../frontend/tree.js";

const poseidon = await buildPoseidon();
const F = poseidon.F;
const h2 = (a, b) => F.toObject(poseidon([a, b]));
const tree = makeTree(F, poseidon);

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log("  ✅ " + name); passed++; } catch (e) { console.log("  ❌ " + name + " — " + (e.message || e)); failed++; } };

// The empty depth-10 root the pool was deployed with (deployments/testnet.json +
// scripts/empty-root.mjs). If tree.js ever diverges from that, deposits break.
const GENESIS = BigInt("0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2");

console.log("Frontend unit tests — client Merkle tree (frontend/tree.js)\n");

t("LEVELS is 10 (depth-10 tree)", () => assert.equal(tree.LEVELS, 10));
t("empty-tree root == deployed genesis root", () => assert.equal(tree.root([]), GENESIS));
t("adding a leaf changes the root", () => assert.notEqual(tree.root([123456789n]), GENESIS));
t("root is deterministic", () => assert.equal(tree.root([1n, 2n, 3n]).toString(), tree.root([1n, 2n, 3n]).toString()));
t("leaf order matters (root depends on positions)", () => assert.notEqual(tree.root([1n, 2n]), tree.root([2n, 1n])));
t("pathElements length == LEVELS (10 siblings)", () => assert.equal(tree.pathElements([1n, 2n, 3n], 1).length, 10));

// Inclusion-proof soundness: reconstruct the root from a leaf + its sibling path the
// way circuits/lib/merkleProof.circom does (DualMux: bit 0 => hash(cur,sib), else
// hash(sib,cur)). Every real leaf must reconstruct exactly the tree root.
const reconstruct = (leaf, index, path) => {
  let cur = leaf, idx = index;
  for (const sib of path) { cur = (idx & 1) === 0 ? h2(cur, sib) : h2(sib, cur); idx >>= 1; }
  return cur;
};
const leaves = [11n, 22n, 33n, 44n, 55n, 66n, 77n];
for (let i = 0; i < leaves.length; i++) {
  t(`inclusion proof verifies for leaf #${i}`, () =>
    assert.equal(reconstruct(leaves[i], i, tree.pathElements(leaves, i)), tree.root(leaves)));
}
t("a WRONG leaf does NOT reconstruct the root (proof soundness)", () =>
  assert.notEqual(reconstruct(999999n, 0, tree.pathElements(leaves, 0)), tree.root(leaves)));
t("an empty slot's path reconstructs from leaf 0 (merkleUpdate 'empty slot' property)", () =>
  assert.equal(reconstruct(0n, leaves.length, tree.pathElements(leaves, leaves.length)), tree.root(leaves)));

console.log(`\n=== ${passed}/${passed + failed} unit tests passed ===`);
process.exit(failed === 0 ? 0 : 1);
