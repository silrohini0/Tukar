// Shared Poseidon Merkle helpers (match circuits/lib/merkleProof.circom:
// internal node = Poseidon(2), empty leaf = 0, pathIndices = bits of index LSB-first).
import { buildPoseidon } from "circomlibjs";

export async function makePoseidon() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const h2 = (a, b) => F.toObject(poseidon([a, b]));
  const h1 = (a) => F.toObject(poseidon([a]));
  const h3 = (a, b, c) => F.toObject(poseidon([a, b, c]));
  return { poseidon, F, h2, h1, h3 };
}

// Build a depth-`levels` tree from `leaves` (BigInt[]), padded with 0.
// Returns { root, proof(index) -> {pathElements, leafIndex} }.
export function buildTree(h2, leaves, levels) {
  const size = 1 << levels;
  let layer = new Array(size).fill(0n);
  for (let i = 0; i < leaves.length; i++) layer[i] = leaves[i] ?? 0n;

  const layers = [layer];
  for (let l = 0; l < levels; l++) {
    const prev = layers[l];
    const next = new Array(prev.length / 2);
    for (let i = 0; i < next.length; i++) next[i] = h2(prev[2 * i], prev[2 * i + 1]);
    layers.push(next);
  }
  const root = layers[levels][0];

  function proof(index) {
    const pathElements = [];
    let idx = index;
    for (let l = 0; l < levels; l++) {
      const sibling = idx ^ 1;
      pathElements.push(layers[l][sibling]);
      idx = idx >> 1;
    }
    return { pathElements, leafIndex: index };
  }
  return { root, proof };
}
