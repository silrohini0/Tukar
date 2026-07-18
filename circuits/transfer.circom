pragma circom 2.1.6;

// Tukar — Shielded transfer (JoinSplit) circuit
// -----------------------------------------------------------------------------
// The private core of the corridor. Spends nIns input notes and creates nOuts
// output notes, proving — without revealing amounts or owners:
//   * ownership of each input note (knowledge of its private key),
//   * correct nullifier per input (prevents double-spending),
//   * Merkle membership of each spent note in the pool tree,
//   * value conservation: sum(in) + publicAmount == sum(out).
// publicAmount is the only public value (positive = deposit, negative = withdraw,
// zero = pure private transfer). Derived from the Tornado-Nova JoinSplit design.
//
// Note scheme (shared with disclosure.circom):
//   pubKey     = Poseidon(privKey)
//   commitment = Poseidon(amount, pubKey, blinding)
//   nullifier  = Poseidon(commitment, leafIndex, privKey)
// -----------------------------------------------------------------------------

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./lib/merkleProof.circom";

template Transfer(levels, nIns, nOuts) {
    // ---- PUBLIC ----
    signal input root;            // pool Merkle root
    signal input publicAmount;    // ext amount (deposit +, withdraw -, transfer 0)
    signal input extDataHash;     // binds external data (recipient, relayer, ...)
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- PRIVATE ----
    signal input inAmount[nIns];
    signal input inPrivKey[nIns];
    signal input inBlinding[nIns];
    signal input inLeafIndex[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKey[nIns];
    component inCommit[nIns];
    component inIdxBits[nIns];
    component inTree[nIns];
    component inNull[nIns];
    component inRange[nIns];

    var sumIn = 0;

    for (var i = 0; i < nIns; i++) {
        // pubKey = Poseidon(privKey)
        inKey[i] = Poseidon(1);
        inKey[i].inputs[0] <== inPrivKey[i];

        // commitment = Poseidon(amount, pubKey, blinding)
        inCommit[i] = Poseidon(3);
        inCommit[i].inputs[0] <== inAmount[i];
        inCommit[i].inputs[1] <== inKey[i].out;
        inCommit[i].inputs[2] <== inBlinding[i];

        // Merkle path indices from the leaf index bits
        inIdxBits[i] = Num2Bits(levels);
        inIdxBits[i].in <== inLeafIndex[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCommit[i].out;
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
            inTree[i].pathIndices[j] <== inIdxBits[i].out[j];
        }
        // Enforce root match only for real (non-zero) inputs; zero-amount inputs
        // are dummies and skip the check.
        (inTree[i].root - root) * inAmount[i] === 0;

        // nullifier = Poseidon(commitment, leafIndex, privKey)
        inNull[i] = Poseidon(3);
        inNull[i].inputs[0] <== inCommit[i].out;
        inNull[i].inputs[1] <== inLeafIndex[i];
        inNull[i].inputs[2] <== inPrivKey[i];
        inNull[i].out === inputNullifier[i];

        // Range-check inputs to 248 bits too (defense-in-depth). Outputs are already
        // bounded (below); bounding inputs makes value conservation provably
        // wrap-free instead of relying on the inductive invariant that every tree
        // leaf commits to a <2^248 amount. A zero-value dummy input passes trivially.
        inRange[i] = Num2Bits(248);
        inRange[i].in <== inAmount[i];

        sumIn += inAmount[i];
    }

    component outCommit[nOuts];
    component outRange[nOuts];
    var sumOut = 0;

    for (var i = 0; i < nOuts; i++) {
        outCommit[i] = Poseidon(3);
        outCommit[i].inputs[0] <== outAmount[i];
        outCommit[i].inputs[1] <== outPubkey[i];
        outCommit[i].inputs[2] <== outBlinding[i];
        outCommit[i].out === outputCommitment[i];

        // range-check outputs to 248 bits to prevent field-wrap value forgery
        outRange[i] = Num2Bits(248);
        outRange[i].in <== outAmount[i];

        sumOut += outAmount[i];
    }

    // distinct nullifiers (no double-spend within the tx)
    var pairs = nIns * (nIns - 1) \ 2;
    component sameNull[pairs];
    var p = 0;
    for (var a = 0; a < nIns - 1; a++) {
        for (var b = a + 1; b < nIns; b++) {
            sameNull[p] = IsEqual();
            sameNull[p].in[0] <== inputNullifier[a];
            sameNull[p].in[1] <== inputNullifier[b];
            sameNull[p].out === 0;
            p++;
        }
    }

    // value conservation
    sumIn + publicAmount === sumOut;

    // bind external data (cannot be malleated)
    signal extSq;
    extSq <== extDataHash * extDataHash;
}

component main { public [ root, publicAmount, extDataHash, inputNullifier, outputCommitment ] } = Transfer(10, 2, 2);
