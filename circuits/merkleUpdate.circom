pragma circom 2.1.6;

// Tukar — Merkle tree update circuit (trustless root registration)
// -----------------------------------------------------------------------------
// Proves that inserting `newLeaf` at an empty slot of a tree whose root is
// `oldRoot` yields exactly `newRoot`. The operator must supply this proof to
// advance the pool's root, so they cannot register an arbitrary root — only a
// correct single-leaf insertion onto the current root. This removes the trust in
// the operator for tree *integrity* (G6).
//
// Public  : oldRoot, newLeaf, newRoot, leafIndex
// Private : pathElements[levels]
//
// leafIndex is PUBLIC so the pool can pin it to its own LeafCount: without that
// binding, a prover could attest insertion at any empty slot while the contract
// stores the leaf at LeafCount — desyncing the durable leaf list from the root and
// bricking the shared accumulator (a cheap griefing DoS). Binding it closes that.
// -----------------------------------------------------------------------------

include "circomlib/circuits/bitify.circom";
include "./lib/merkleProof.circom";

template MerkleUpdate(levels) {
    signal input oldRoot;
    signal input newLeaf;
    signal input newRoot;

    signal input leafIndex;
    signal input pathElements[levels];

    component idx = Num2Bits(levels);
    idx.in <== leafIndex;

    // root with the slot still EMPTY (leaf = 0) must equal oldRoot
    component oldT = MerkleProof(levels);
    oldT.leaf <== 0;
    // root with newLeaf inserted must equal newRoot — same siblings
    component newT = MerkleProof(levels);
    newT.leaf <== newLeaf;

    for (var i = 0; i < levels; i++) {
        oldT.pathElements[i] <== pathElements[i];
        oldT.pathIndices[i] <== idx.out[i];
        newT.pathElements[i] <== pathElements[i];
        newT.pathIndices[i] <== idx.out[i];
    }

    oldRoot === oldT.root;
    newRoot === newT.root;
}

component main { public [ oldRoot, newLeaf, newRoot, leafIndex ] } = MerkleUpdate(10);
