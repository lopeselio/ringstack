#!/usr/bin/env bash
# Exports the gadget and escrow circuits in Picus's R1CS format and runs Picus
# (https://github.com/Veridise/Picus) on each: every wire that is not a declared
# proof input must be uniquely determined by the inputs. Needs `run-picus` on
# PATH (or PICUS=/path/to/run-picus) and, ideally, cvc5 with finite-field
# support; z3 works only for small, Poseidon-free circuits.
#
#   zk/scripts/picus.sh [SMT query timeout in ms, default 5000 as in Picus]
set -euo pipefail
cd "$(dirname "$0")/.."
query_timeout="${1:-5000}"
picus="${PICUS:-run-picus}"
solver="${PICUS_SOLVER:-cvc5}"
out=target/picus
command -v "$picus" >/dev/null || { echo "run-picus not found; set PICUS" >&2; exit 2; }

cargo run --release -q -p ringstack-zk-gadgets --features harness --example picus_export -- "$out"
cargo run --release -q -p milestone-escrow --features circuits --example picus_export -- "$out"

# Smallest first: the gadgets are the tractable targets.
for name in threshold-only threshold-committed allowlist-depth4 escrow-refund escrow-release escrow-create; do
  printf '%-22s ' "$name"
  if result=$("$picus" --solver "$solver" --timeout "$query_timeout" "$out/$name.r1cs" 2>&1); then
    verdict=$(echo "$result" | grep -E -o "\b(safe|unsafe|unknown)\b" | tail -1 || true)
    echo "${verdict:-$(echo "$result" | tail -1)}"
  else
    echo "error: $(echo "$result" | tail -1)"
  fi
done
