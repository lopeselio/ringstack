#!/usr/bin/env bash
# Runs run-picus inside the Picus Docker image, so picus.sh can drive it:
#
#   PICUS=zk/scripts/picus-docker.sh zk/scripts/picus.sh
#
# Takes run-picus's arguments; the last must be an .r1cs path under the
# current directory, which is mounted at /work. Build the image first
# (`docker build -t picus:v0 <Picus checkout>`, or set PICUS_IMAGE). Exits
# with run-picus's code. A TERM (picus.sh's time limit) kills the container,
# which killing the docker client alone would leave running.
set -uo pipefail
image="${PICUS_IMAGE:-picus:v0}"
args=("$@")
last=$((${#args[@]} - 1))
if ((last < 0)) || [[ "${args[last]}" == /* || ! -f "${args[last]}" ]]; then
  echo "usage: picus-docker.sh [run-picus options] <relative path to .r1cs>" >&2
  exit 2
fi
args[last]="/work/${args[last]}"
name="picus-$$"

docker run --rm --init --name "$name" -v "$PWD:/work:ro" "$image" \
  /Picus/run-picus "${args[@]}" &
client=$!
trap 'docker kill "$name" >/dev/null 2>&1; exit 143' TERM INT
wait "$client"
