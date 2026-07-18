// Emit the ASP allow-list witness for the KEY-ON-FROM compliance model: each
// allow-list leaf is a field derived from an APPROVED Stellar account
// (`field(addr) = keccak256(addr ScVal XDR) mod r`). A deposit proves that the
// authenticated depositor's `field(from)` is a member — so the proof authenticates
// THIS depositor, not just "some member". The demo key is approved (index 0) so the
// no-install demo works; the rest are inert padding (no one holds those accounts).
//
// field(demoKey) = keccak256(addr ScVal XDR) mod r, computed here directly via the
// Stellar SDK + js-sha3 (same derivation as the contract's on-chain `field(from)`
// and the frontend's addrField()) — MUST match on both sides.
import { makePoseidon, buildTree } from "./merkle.mjs";
import { writeFileSync } from "node:fs";
import { nativeToScVal } from "@stellar/stellar-sdk";
import sha3 from "js-sha3";

const LEVELS = 10;
const N = 16;
const FIELD_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// The demo key's Stellar address (the throwaway key embedded in frontend/stellar.js).
const DEMO_ADDRESS = process.env.DEMO_ADDRESS || "GA2DZZWGTZ4NGGNM3FQERYXLCHXQ2XXRC7OCHUFCXDC5D4HLEYFF4IWM";
const DEMO_FIELD = (() => {
  const xdr = nativeToScVal(DEMO_ADDRESS, { type: "address" }).toXDR();
  return BigInt("0x" + sha3.keccak256(xdr)) % FIELD_R;
})();
const { h1, h2 } = await makePoseidon();

// Allow-list: the demo key at index 0 + inert padding members.
const sources = [DEMO_FIELD];
for (let i = 1; i < N; i++) sources.push(h1(BigInt(2000 + i)));
const tree = buildTree(h2, sources, LEVELS);

const members = sources.map((sk, i) => {
  const { pathElements, leafIndex } = tree.proof(i);
  return {
    sourceKey: sk.toString(),
    leafIndex: leafIndex.toString(),
    pathElements: pathElements.map((x) => x.toString()),
  };
});

// Deny-list = field(sanctioned account) using the SAME keccak256(addr XDR) mod r
// derivation as sourceKey, so the non-membership check is semantically real (a
// deposit proves field(from) is none of these specific sanctioned accounts). These
// are 4 deterministic "sanctioned" testnet accounts (fixed ed25519 seeds 0x91..0x94):
//   GCGKMMKF..., GDDNBR4W..., GAI72RLR..., GAHDJQCF...
const DENY_SANCTIONED = [
  "3082132687368863516150381708866164029952132851772459186640452982606694939745",
  "12744456281845219501046754656790092100606383966049268766255332742813719532583",
  "6228627607882016519908452747090894579594818906802039072243571290666355853281",
  "17052486854034810142609536060076645562758373809480125614291672959189632001501",
];

const witness = {
  aspRoot: tree.root.toString(),
  denyList: DENY_SANCTIONED,
  members, // member 0 == field(demo key); the frontend matches by field(from)
  sourceKey: members[0].sourceKey,
  leafIndex: members[0].leafIndex,
  pathElements: members[0].pathElements,
};
writeFileSync("frontend/circuit/asp-witness.json", JSON.stringify(witness));
console.log("wrote frontend/circuit/asp-witness.json — demo key approved at index 0");
console.log("aspRoot dec:", witness.aspRoot);
console.log("aspRoot hex:", BigInt(witness.aspRoot).toString(16).padStart(64, "0"));
