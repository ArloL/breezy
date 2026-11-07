#!/bin/sh
# Runs the hold rules' and frame tests, then the relay under wrangler dev with test/relay.test.mjs against it: relay/test.sh
set -e
cd "$(dirname "$0")"
npm install --silent
node --test test/holds.test.mjs test/frames.test.mjs
dir=$(mktemp -d)
npx wrangler dev --port 58568 --persist-to "$dir" >"$dir/dev.log" 2>&1 &
trap 'pkill -f "wrangler dev --port 58568"; rm -rf "$dir"' EXIT
i=0
while [ $i -lt 120 ]; do curl --silent --output /dev/null http://127.0.0.1:58568/ && break; sleep 0.5; i=$((i + 1)); done
BREEZY_RELAY=ws://127.0.0.1:58568/ node --test --test-force-exit test/relay.test.mjs || { cat "$dir/dev.log"; exit 1; }
