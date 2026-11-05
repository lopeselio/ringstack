#!/usr/bin/env bash
# Start the zolana localnet: validator :8899, Photon indexer :8784, prover :3001.
#
# NOTE: this is the v0.6.0-alpha stack. The repo's SDK is 0.8, which refuses the
# v0.6 prover (older attestation protocol and proving keys); zolana 0.8 ships no
# local-stack binaries. See docs/devnet.md. Kept for reference until it does.
# Run scripts/install-zolana.sh first. Returns once all three are ready and
# leaves them running in the background (logs in test-ledger/); stop them with
# `scripts/localnet.sh --stop`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZOLANA="$ROOT/.zolana/bin/zolana"
[ -x "$ZOLANA" ] || { echo "zolana CLI missing; run scripts/install-zolana.sh" >&2; exit 1; }

exec "$ZOLANA" dev start "$@"
