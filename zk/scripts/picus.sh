#!/usr/bin/env bash
# Exports the gadget circuits (and with --all the escrow's) in Picus's R1CS
# format and runs Picus (https://github.com/Veridise/Picus) on each: every
# wire that is not a declared proof input must be uniquely determined by the
# inputs. Needs `run-picus` on PATH (or PICUS=/path/to/run-picus) and, ideally,
# cvc5 with finite-field support; z3 copes only with small, Poseidon-free
# circuits.
#
#   zk/scripts/picus.sh [--all]
#
# Environment: PICUS_SOLVER (default cvc5), PICUS_QUERY_MS (per SMT query,
# default 5000 as in Picus), PICUS_LIMIT_S (per circuit, default 300 as in
# upstream's harness; a run past it is killed and reported unknown).
#
# Verdicts follow run-picus's exit code, as upstream's harness reads it:
# 8 safe, 9 unsafe, 0 unknown. The script exits 1 if any circuit is unsafe
# and 2 if run-picus fails.
set -uo pipefail
cd "$(dirname "$0")/.."
picus="${PICUS:-run-picus}"
solver="${PICUS_SOLVER:-cvc5}"
query_ms="${PICUS_QUERY_MS:-5000}"
limit_s="${PICUS_LIMIT_S:-300}"
out=target/picus
command -v "$picus" >/dev/null || { echo "run-picus not found; set PICUS" >&2; exit 2; }

circuits=(threshold-only allowlist-depth4)
cargo run --release -q -p ringstack-zk-gadgets --features harness --example picus_export -- "$out" >/dev/null || exit 2
if [[ "${1:-}" == "--all" ]]; then
  # 6,000 to 16,000 constraints with Poseidon throughout: expect unknown.
  circuits+=(escrow-refund escrow-release escrow-create)
  cargo run --release -q -p milestone-escrow --features circuits --example picus_export -- "$out" >/dev/null || exit 2
fi

# Each run starts in its own process group (job control on just for the
# launch, so bash prints no job notices), and a time limit stops the group:
# Racket and every solver it has started or is about to start. TERM first, so
# a wrapper can clean up; then KILL what is left.
stop() {
  kill -TERM -- "-$1" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 -- "-$1" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- "-$1" 2>/dev/null || true
}

unsafe=0
for name in "${circuits[@]}"; do
  printf '%-18s ' "$name"
  log="$out/$name.log"
  set -m
  "$picus" --solver "$solver" --timeout "$query_ms" "$out/$name.r1cs" >"$log" 2>&1 &
  pid=$!
  set +m
  waited=0
  while kill -0 "$pid" 2>/dev/null && ((waited < limit_s)); do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    # bash reports the killed job on stderr when it reaps it; keep that out.
    { stop "$pid"; wait "$pid"; } 2>/dev/null
    echo "unknown (killed after ${limit_s}s)"
    continue
  fi
  wait "$pid"
  case $? in
    8) echo safe ;;
    9) echo "UNSAFE (counterexample in $log)"; unsafe=1 ;;
    0) echo "unknown (solver timed out)" ;;
    *) echo "run-picus failed, see $log"; exit 2 ;;
  esac
done
exit "$unsafe"
