#!/usr/bin/env bash
# reconcile-tee.sh — make the on-chain machine registration match the live TEE key.
#
# The machine key CANNOT be persisted: tee-node generates it in memory on every
# boot (crypto.GenerateKey in internal/node.Initialize) and never writes it to
# disk, so no docker volume helps. Simulated mode mirrors real TEE semantics —
# a restarted container is a new machine. What this script converges instead is
# the registry: register the live key if needed (via post-build.sh), then pause
# every other active machine we own so instructions stop routing to dead keys.
#
# Idempotent — safe to run on every boot. start-services.sh runs it
# automatically for coston/coston2; run it by hand after any container restart
# you did outside start-services.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log() { echo -e "${GREEN}[reconcile-tee]${NC} $*"; }
die() { echo -e "${RED}[reconcile-tee] ERROR:${NC} $*" >&2; exit 1; }

# post-build.sh and the tools read the same .env; export everything for go run.
if [[ -f "$PROJECT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi

EXT_PROXY_URL="${EXT_PROXY_URL:-http://localhost:6674}"
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
ADDRESSES_FILE="${ADDRESSES_FILE:-$PROJECT_DIR/config/coston2/deployed-addresses.json}"
[[ "$ADDRESSES_FILE" == /* ]] || ADDRESSES_FILE="$PROJECT_DIR/$ADDRESSES_FILE"

cd "$PROJECT_DIR/tools"

# First pass: exits 0 when the live key is already PRODUCTION (and prunes
# stale machines), 3 when the live key still needs registration.
rc=0
go run ./cmd/reconcile-tee -a "$ADDRESSES_FILE" -c "$CHAIN_URL" -p "$EXT_PROXY_URL" || rc=$?

if [[ $rc -eq 3 ]]; then
    log "Live key unregistered — running post-build.sh to register it"
    "$SCRIPT_DIR/post-build.sh" || die "post-build.sh failed"
    log "Registration done — pruning stale machines"
    go run ./cmd/reconcile-tee -a "$ADDRESSES_FILE" -c "$CHAIN_URL" -p "$EXT_PROXY_URL" \
        || die "reconcile still failing after registration"
elif [[ $rc -ne 0 ]]; then
    die "reconcile-tee failed (exit $rc)"
fi

log "On-chain registration matches the live TEE key"

# The contract's settle() trusts teeAddress; sync it to the machine that will
# actually sign results, or every settlement reverts with "bad TEE signature".
"$SCRIPT_DIR/extension-post-setup.sh" || die "extension-post-setup.sh failed"
