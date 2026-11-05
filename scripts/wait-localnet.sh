#!/usr/bin/env bash
# Block until the zolana localnet started by scripts/localnet.sh is serving:
# validator RPC (getHealth), Photon indexer (getIndexerHealth), prover (/health).
# Usage: scripts/wait-localnet.sh [timeout_seconds]   (default 300)
set -euo pipefail

TIMEOUT="${1:-300}"
RPC="${ZOLANA_RPC_URL:-http://127.0.0.1:8899}"
INDEXER="${ZOLANA_INDEXER_URL:-http://127.0.0.1:8784}"
PROVER="${ZOLANA_PROVER_URL:-http://127.0.0.1:3001}"

rpc_ok() {
  curl -fsS -m 3 -X POST -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\"}" "$1" 2>/dev/null | grep -q '"result":"ok"'
}

deadline=$((SECONDS + TIMEOUT))
for svc in validator indexer prover; do
  until case "$svc" in
      validator) rpc_ok "$RPC" getHealth ;;
      indexer) rpc_ok "$INDEXER" getIndexerHealth ;;
      prover) curl -fsS -m 3 -o /dev/null "$PROVER/health" 2>/dev/null ;;
    esac; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "timed out after ${TIMEOUT}s waiting for $svc" >&2
      exit 1
    fi
    sleep 1
  done
  echo "$svc ready (${SECONDS}s)"
done
