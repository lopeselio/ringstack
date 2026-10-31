#!/usr/bin/env bash
# Download the pinned zolana CLI release binary and verify it against the
# release SHA256SUMS. `zolana dev start` then fetches and verifies the rest
# (programs, prover, Photon, account snapshot) on its own, caching them under
# ~/.config/zolana/cache/<tag>/.
set -euo pipefail

ZOLANA_TAG="${ZOLANA_TAG:-v0.6.0-alpha}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/.zolana/bin"
BASE="https://github.com/helius-labs/zolana/releases/download/$ZOLANA_TAG"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
  Linux-x86_64) PLATFORM=linux-x64 ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m) (release ships darwin-arm64, linux-x64)" >&2; exit 1 ;;
esac

ASSET="zolana-$PLATFORM-$ZOLANA_TAG"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ASSET"
curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"

EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}')"
[ -n "$EXPECTED" ] || { echo "no checksum for $ASSET in SHA256SUMS" >&2; exit 1; }
ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "checksum mismatch for $ASSET" >&2; exit 1; }

install -m 0755 "$TMP/$ASSET" "$BIN_DIR/zolana"
echo "Installed $BIN_DIR/zolana ($ZOLANA_TAG, sha256 $ACTUAL)"
