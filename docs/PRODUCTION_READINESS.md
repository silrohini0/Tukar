# Production Readiness Report

## Executive Summary

Tukar is a Soroban privacy-pool corridor with a static browser demo and a Next.js
wallet app. The smart contract architecture is mature for a testnet submission:
the pool owns custody, builds verifier inputs internally, pins transfer IO
counts, persists ordered Merkle leaves, and emits activity events for indexing.

This review added CI/CD structure, repeatable root scripts, Next lint config, a
deployment helper, and this readiness record. Local deterministic checks pass:
15/15 frontend Merkle unit tests, 36/36 Soroban contract tests, Next typecheck,
and Next production build.

## Architecture Review

- Contracts: one stateful pool plus four Groth16 verifier contracts.
- Inter-contract communication: pool calls verifier contracts and the Reflector
  SEP-40 FX oracle; token custody uses the Stellar Asset Contract client.
- Frontend: static demo at `frontend/` for the ZK corridor, plus a Next wallet app
  under `apps/web/`.
- Event stream: pool emits `deposit`, `withdraw`, `transfer`, and `root` events;
  the browser reads recent activity through Stellar RPC `getEvents` and uses
  durable contract state (`leaf_count`/`leaf_range`) for authoritative tree sync.

## Smart Contract Audit

Security properties verified in code and tests:

- Access control: admin-only ASP root, deny list, and FX oracle updates.
- Custody binding: deposits require token transfer and amount-binding disclosure
  proof; withdrawals bind released amount to negative public amount.
- Double-spend protection: nullifier set and fixed 2-in/2-out public-input split.
- Tree integrity: root advances only with `register_root_verified`; leaf must be a
  backed commitment, inserted once, at the contract's current leaf index.
- Oracle safety: stale, missing, thin, or non-positive FX data fails closed.
- Event emissions: root, deposit, transfer, and withdraw events are emitted for
  off-chain indexing and UI updates.

## Testing Report

Local outputs captured during this review:

```text
npm run test:unit
=== 15/15 unit tests passed ===
```

```text
cargo test --manifest-path contracts/pool/Cargo.toml
test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

```text
npm --prefix apps/web run typecheck
tsc --noEmit
```

```text
npm --prefix apps/web run build
Compiled successfully
Generating static pages (5/5)
```

Coverage note: there is no instrumentation-based coverage report configured for
the Rust contract or browser tests. Current evidence is deterministic pass/fail
coverage across the named contract scenarios and frontend Merkle/tree behavior.

## Deployment Verification

Current testnet deployment is recorded in `deployments/testnet.json`.

- Pool: `CD4CIE7IZSU5J7ZHVPQVEMYKO6CP7RTU3XT7TGUNUCOLKZGINVQZKFFS`
- Disclosure verifier: `CCJ6MERPOPXKF6OWEUC6WXPOEYJEHVWX2GTZKHQJIHWXUZKXD4MAV3ET`
- Transfer verifier: `CACSB6NBWKQNRLN7GODIUQ7JJBLDPSFDTS7J73ZSNWOXQWVWNFGKT5XD`
- Compliance verifier: `CCPQG73RUCO4TTNZAX2I2BJHFWWPFJI6KVMLLPMBZIAG5XQI3CT43MFP`
- Merkle update verifier: `CD6WAS6UMLJRSVYO3V74VW2JDBTR3ENYIQIKX6FRNHVHMAI2AUQ4E3HY`
- Pool deploy tx: `ed44eff8f1a20a00c5df5cafeef3633be39b4844b32be9fbaec52698103aa52f`
- Disclosure verifier deploy tx: `5acd8533c17bcaff5fb90957620b9a6a36b6afa8d13b04f14976bf80130129d3`
- Transfer verifier deploy tx: `143e97679712331af04b0eb7f0bd574c35659516dd3ef8aecb38973aca053d80`
- Compliance verifier deploy tx: `d79678beae7383908010747a5277baa2e47965ecbcac9802facba10ea73352d2`
- Merkle update verifier deploy tx: `0a511d6f48b4a27c7112d79c4cbed97f169e03fc37a6f51ac0a18087d1d99f10`
- Fresh contract interaction tx: `cedf03f5838152bc8e2acda1161a6e4c290fad2bc1298f90997d384d43ec4048`
  (`pool.poseidon_hash(1,2)` returned
  `0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a`)

## CI/CD

`.github/workflows/ci.yml` now runs on push and pull request. The sequence is:

1. checkout
2. setup Node.js and Rust
3. install root and web dependencies
4. lint
5. typecheck
6. frontend unit tests
7. smart contract tests
8. frontend build
9. artifact collection/upload

The Soroban WASM build step is included as a non-blocking artifact step because
CI runners may not have the Stellar CLI preinstalled by default. To make it
blocking, install the Stellar CLI in the workflow image first.

## Deployment Workflow

Use `scripts/deploy-testnet.sh` with environment variables documented in the
script. Secrets must stay in the Stellar CLI key store or CI secret manager, not
in git. Rollback is by redeploying the last known-good contract set and updating
frontend contract IDs from the deployment JSON.

## Remaining Risks

- No professional third-party audit has been performed.
- Public demo key is intentionally shared for testnet demo convenience and must
  never be reused for production custody.
- Full public testnet deposit/withdraw click-through currently depends on
  funding the deployed pool's specific testnet USDC issuer.
- Browser E2E requires Chromium execution permissions on macOS or a normal CI
  Linux runner.
- Instrumented coverage thresholds are not yet configured.
