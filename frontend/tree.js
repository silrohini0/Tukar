// Client-side Poseidon Merkle tree (depth 10), matching circuits/lib/merkleProof.circom
// and the pool's registered roots. Used to register roots and spend notes.
const LEVELS = 10;

export function makeTree(F, poseidon) {
  const h2 = (a, b) => F.toObject(poseidon([a, b]));

  // build a depth-10 tree from BigInt leaves (padded with 0)
  function build(leaves) {
    const size = 1 << LEVELS;
    let layer = new Array(size).fill(0n);
    for (let i = 0; i < leaves.length; i++) layer[i] = leaves[i] ?? 0n;
    const layers = [layer];
    for (let l = 0; l < LEVELS; l++) {
      const prev = layers[l];
      const next = new Array(prev.length / 2);
      for (let i = 0; i < next.length; i++) next[i] = h2(prev[2 * i], prev[2 * i + 1]);
      layers.push(next);
    }
    return layers;
  }

  function root(leaves) {
    return build(leaves)[LEVELS][0];
  }

  // sibling path for an index (same for old/new tree since only that leaf changes)
  function pathElements(leaves, index) {
    const layers = build(leaves);
    const path = [];
    let idx = index;
    for (let l = 0; l < LEVELS; l++) {
      path.push(layers[l][idx ^ 1]);
      idx >>= 1;
    }
    return path;
  }

  return { root, pathElements, LEVELS };
}
