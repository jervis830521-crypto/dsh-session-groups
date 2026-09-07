#!/bin/bash
# Build dsh-plugin-session-groups:
#   1. junction-link type dependencies from the dsh checkout (cordis, webserver host types)
#   2. tsc: src/host -> lib (Node ESM, .ts suffixes rewritten to .js)
#   3. tsdown: src/client/index.tsx -> lib/client.js (browser closure-factory artifact)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  for c in "E:/BaiduSyncdisk/Agent-dev/_20-vendor/_00-deepseek-harness" "/e/BaiduSyncdisk/Agent-dev/_20-vendor/_00-deepseek-harness"; do
    if [ -d "$c/packages" ]; then CHECKOUT="$c"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi
echo "build: checkout $CHECKOUT"

TSC="$CHECKOUT/node_modules/.bin/tsc"
TSDOWN="$CHECKOUT/node_modules/.bin/tsdown"
[ -f "$TSC" ] || TSC="$TSC.cmd"
[ -f "$TSDOWN" ] || TSDOWN="$TSDOWN.cmd"

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
  echo "build: linked node_modules/$1 -> $target"
}

echo "=== Linking type dependencies ==="
mkdir -p node_modules/@deepseek-ai
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg @deepseek-ai/dsh-host-webserver packages/host/webserver

echo "=== Compiling host (tsc) ==="
"$TSC" -p tsconfig.json

echo "=== Bundling client (tsdown) ==="
"$TSDOWN" --config tsdown.config.ts

echo "=== Build complete ==="
ls -la lib/