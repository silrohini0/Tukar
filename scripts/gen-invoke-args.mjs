// Emit the two files the stellar CLI expects for a verifier `verify` call:
//   <name>_soroban_proof.json   -> { "a": <128 hex>, "b": <256 hex>, "c": <128 hex> }  (no 0x)
//   <name>_soroban_public.json  -> ["<decimal>", ...]  (Array<u256>)
// Usage: node scripts/gen-invoke-args.mjs <name>   (default: disclosure)
import { readFileSync, writeFileSync } from "node:fs";

const name = process.argv[2] || "disclosure";
const dir = "circuits/build";
const proofFile = name === "disclosure" ? `${dir}/proof.json` : `${dir}/${name}_proof.json`;
const publicFile = name === "disclosure" ? `${dir}/public.json` : `${dir}/${name}_public.json`;

const proof = JSON.parse(readFileSync(proofFile, "utf8"));
const publicSignals = JSON.parse(readFileSync(publicFile, "utf8"));

const fe = (dec) => BigInt(dec).toString(16).padStart(64, "0");
const g1 = (pt) => fe(pt[0]) + fe(pt[1]);
// G2: snarkjs [c0,c1] -> Soroban c1||c0
const g2 = (pt) => fe(pt[0][1]) + fe(pt[0][0]) + fe(pt[1][1]) + fe(pt[1][0]);

const sorobanProof = { a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) };
const sorobanPublic = publicSignals.map((s) => BigInt(s).toString());

const pOut = name === "disclosure" ? `${dir}/soroban_proof.json` : `${dir}/${name}_soroban_proof.json`;
const sOut = name === "disclosure" ? `${dir}/soroban_public.json` : `${dir}/${name}_soroban_public.json`;
writeFileSync(pOut, JSON.stringify(sorobanProof));
writeFileSync(sOut, JSON.stringify(sorobanPublic));
console.log("wrote", pOut, "and", sOut, `(${sorobanPublic.length} public inputs)`);
