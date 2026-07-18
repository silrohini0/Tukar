pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// Selects (out[0], out[1]) = (in[0], in[1]) when s==0, swapped when s==1.
template DualMux() {
    signal input in[2];
    signal input s;       // 0 or 1
    signal output out[2];
    s * (1 - s) === 0;    // boolean
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Binary Merkle inclusion proof using Poseidon(2) for internal nodes.
// pathIndices[i] == 0 -> current node is the LEFT child at level i, else RIGHT.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component mux[levels];
    component hash[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        mux[i] = DualMux();
        mux[i].in[0] <== cur[i];
        mux[i].in[1] <== pathElements[i];
        mux[i].s <== pathIndices[i];

        hash[i] = Poseidon(2);
        hash[i].inputs[0] <== mux[i].out[0];
        hash[i].inputs[1] <== mux[i].out[1];
        cur[i + 1] <== hash[i].out;
    }
    root <== cur[levels];
}
