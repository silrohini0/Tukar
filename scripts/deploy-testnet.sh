#!/usr/bin/env bash
set -euo pipefail

# Production-style Stellar testnet deployment helper.
# Prereqs:
#   - stellar CLI installed and authenticated
#   - DEPLOYER_SECRET configured outside git, or a named key already imported
#   - verifier WASMs already built in contracts/build
#
# Required environment:
#   SOURCE_ACCOUNT   Stellar CLI identity name, e.g. corredor2
#   TOKEN_ADDRESS    SAC address custodied by the pool
#   FX_ORACLE        Reflector SEP-40 oracle contract address
#   INITIAL_ROOT     32-byte hex Merkle genesis root
#   ASP_ROOT         32-byte hex ASP allow-list root
#   DENY_LIST_JSON   JSON array of four 32-byte hex deny-list entries

: "${SOURCE_ACCOUNT:?Set SOURCE_ACCOUNT to a Stellar CLI identity name}"
: "${TOKEN_ADDRESS:?Set TOKEN_ADDRESS to the SAC token contract address}"
: "${FX_ORACLE:?Set FX_ORACLE to the Reflector oracle contract address}"
: "${INITIAL_ROOT:?Set INITIAL_ROOT to the 32-byte genesis root hex}"
: "${ASP_ROOT:?Set ASP_ROOT to the 32-byte ASP root hex}"
: "${DENY_LIST_JSON:?Set DENY_LIST_JSON to a JSON array with four deny-list hex values}"

NETWORK="${NETWORK:-testnet}"
OUT="${OUT:-deployments/latest-testnet.json}"

mkdir -p "$(dirname "$OUT")"

deploy_wasm() {
  local wasm="$1"
  stellar contract deploy \
    --wasm "$wasm" \
    --source "$SOURCE_ACCOUNT" \
    --network "$NETWORK"
}

echo "Deploying Tukar verifiers to $NETWORK..."
DISCLOSURE_VERIFIER="$(deploy_wasm contracts/build/disclosure_verifier.wasm)"
TRANSFER_VERIFIER="$(deploy_wasm contracts/build/transfer_verifier.wasm)"
COMPLIANCE_VERIFIER="$(deploy_wasm contracts/build/compliance_verifier.wasm)"
UPDATE_VERIFIER="$(deploy_wasm contracts/build/merkleUpdate_verifier.wasm)"

echo "Deploying pool..."
POOL_ID="$(stellar contract deploy \
  --wasm contracts/build/pool.wasm \
  --source "$SOURCE_ACCOUNT" \
  --network "$NETWORK" \
  -- \
  --admin "$SOURCE_ACCOUNT" \
  --token "$TOKEN_ADDRESS" \
  --transfer_verifier "$TRANSFER_VERIFIER" \
  --compliance_verifier "$COMPLIANCE_VERIFIER" \
  --disclosure_verifier "$DISCLOSURE_VERIFIER" \
  --update_verifier "$UPDATE_VERIFIER" \
  --initial_root "$INITIAL_ROOT" \
  --asp_root "$ASP_ROOT" \
  --deny_list "$DENY_LIST_JSON" \
  --fx_oracle "$FX_ORACLE")"

cat > "$OUT" <<JSON
{
  "network": "$NETWORK",
  "sourceAccount": "$SOURCE_ACCOUNT",
  "pool": "$POOL_ID",
  "verifiers": {
    "disclosure": "$DISCLOSURE_VERIFIER",
    "transfer": "$TRANSFER_VERIFIER",
    "compliance": "$COMPLIANCE_VERIFIER",
    "merkleUpdate": "$UPDATE_VERIFIER"
  },
  "token": "$TOKEN_ADDRESS",
  "fxOracle": "$FX_ORACLE"
}
JSON

echo "Deployment written to $OUT"
