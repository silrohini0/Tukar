// Input for merkleUpdate.circom: insert newLeaf at an empty slot, transforming
// oldRoot -> newRoot (levels = 10). Siblings are identical for both roots.
import { makePoseidon, buildTree } from "./merkle.mjs";

const LEVELS = 10;
const { h1, h2, h3 } = await makePoseidon();

// Existing tree has two commitments at indices 0,1; we insert at index 2.
const existing = [h3(600n, h1(1001n), 11n), h3(400n, h1(1002n), 22n)];
const INDEX = 2;
const newLeaf = h3(500n, h1(5001n), 55n);

const oldLeaves = [existing[0], existing[1]]; // index 2 empty (=0)
const newLeaves = [existing[0], existing[1]];
newLeaves[INDEX] = newLeaf;

const oldTree = buildTree(h2, oldLeaves, LEVELS);
const newTree = buildTree(h2, newLeaves, LEVELS);
const { pathElements } = oldTree.proof(INDEX); // siblings identical in both trees

const input = {
  oldRoot: oldTree.root.toString(),
  newLeaf: newLeaf.toString(),
  newRoot: newTree.root.toString(),
  leafIndex: INDEX.toString(),
  pathElements: pathElements.map((x) => x.toString()),
};
console.log(JSON.stringify(input, null, 2));
