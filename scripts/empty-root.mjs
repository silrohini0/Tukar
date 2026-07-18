import { makePoseidon, buildTree } from "./merkle.mjs";
const { h2 } = await makePoseidon();
const { root } = buildTree(h2, [], 10);
console.log("dec:", root.toString());
console.log("hex:", BigInt(root).toString(16).padStart(64, "0"));
