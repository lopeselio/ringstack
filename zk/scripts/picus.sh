#!/usr/bin/env bash
# Exports the gadget circuits (and with --all the escrow's) in Picus's R1CS
# format and runs Picus (https://github.com/Veridise/Picus) on each: every
# wire that is not a declared proof input must be uniquely determined by the
# inputs. Needs `run-picus` on PATH (or PICUS=/path/to/run-picus) and, ideally,
# cvc5 with finite-field support; z3 copes only with small, Poseidon-free
# circuits. To use Picus's Docker image instead (it is x86 only; the picus
# workflow runs it on GitHub's runners), set PICUS=zk/scripts/picus-docker.sh.
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
[[ "$limit_s" =~ ^[1-9][0-9]*$ ]] || { echo "PICUS_LIMIT_S must be whole seconds, got '$limit_s'" >&2; exit 2; }

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
# a wrapper (picus-docker.sh) can stop its container, with time for a slow
# Docker daemon to answer; then KILL what is left.
stop() {
  kill -TERM -- "-$1" 2>/dev/null
  for _ in $(seq 30); do
    kill -0 -- "-$1" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- "-$1" 2>/dev/null || true
}

# An interrupted script stops the run in progress, which is in its own group
# and so does not get the terminal's Ctrl-C.
pid=
trap '[[ -n "$pid" ]] && stop "$pid" 2>/dev/null; exit 130' INT TERM

echo "solver $solver, ${query_ms}ms per query, ${limit_s}s per circuit"
unsafe=0
for name in "${circuits[@]}"; do
  printf '%-18s ' "$name"
  log="$out/$name.log"
  set -m
  "$picus" --solver "$solver" --timeout "$query_ms" "$out/$name.r1cs" </dev/null >"$log" 2>&1 &
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
    pid=
    echo "unknown (killed after ${limit_s}s)"
    continue
  fi
  wait "$pid"
  code=$?
  pid=
  case $code in
    8) echo safe ;;
    9) echo "UNSAFE (counterexample in $log)"; unsafe=1 ;;
    0) echo "unknown (solver timed out)" ;;
    *) echo "run-picus failed, see $log"; exit 2 ;;
  esac
done
exit "$unsafe"
