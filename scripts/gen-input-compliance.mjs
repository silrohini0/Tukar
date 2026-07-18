// Sample input for compliance.circom (levels=10, nDeny=4).
import { makePoseidon, buildTree } from "./merkle.mjs";

const LEVELS = 10;
const { h1, h2 } = await makePoseidon();

// The source key (secret). In the corridor this is the deposit's source identity.
const sourceKey = h1(424242n);

// Allow-list tree containing the source key at index 5 (plus some other members).
const members = [h1(1n), h1(2n), h1(3n), h1(4n), h1(5n)];
const leaves = [];
members.forEach((m, i) => (leaves[i === 4 ? 5 : i] = m)); // put sourceKey-equivalent...
leaves[5] = sourceKey;
const tree = buildTree(h2, leaves, LEVELS);
const { pathElements, leafIndex } = tree.proof(5);

// Deny-list: four sanctioned keys, none equal to the source key.
const denyList = [h1(9001n), h1(9002n), h1(9003n), h1(9004n)];

const input = {
  aspRoot: tree.root.toString(),
  denyList: denyList.map((d) => d.toString()),
  bindHash: "987654321",
  sourceKey: sourceKey.toString(),
  pathElements: pathElements.map((x) => x.toString()),
  leafIndex: leafIndex.toString(),
};

console.log(JSON.stringify(input, null, 2));
