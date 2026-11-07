#!/bin/sh
# Runs the in-app self-tests (see Breezy/Support/SelfTest.swift) on copies of scripts/selftest/*.breezy:
# scripts/selftest.sh [CONFIGURATION], Debug by default. Exits 1 if any check fails, else 2 if any could not look, as
# pixel checks cannot behind a locked or sleeping screen.
app=build/Build/Products/${1:-Debug}/Breezy.app/Contents/MacOS/Breezy
failed=0
skipped=0
for fixture in "$(cd "$(dirname "$0")" && pwd)"/selftest/*.breezy; do
  name=$(basename "$fixture" .breezy)
  dir=$(mktemp -d)
  cp "$fixture" "$dir/board.breezy"
  # animations stall while the display sleeps behind a locked screen
  caffeinate -u -t 15 >/dev/null 2>&1 &
  sleep 1
  ( sleep 40; pkill -f "BreezySelfTest $name" ) >/dev/null 2>&1 &
  watchdog=$!
  out=$("$app" -ApplePersistenceIgnoreState YES -BreezyBoard "$dir/board.breezy" -BreezySelfTest "$name" 2>/dev/null)
  code=$?
  line=$(printf '%s\n' "$out" | grep -E '^(PASS|FAIL|SKIP)')
  [ -z "$line" ] && { line="FAIL $name: no result (exit $code)"; code=1; }
  printf '%s\n' "$line"
  case $code in
    0) ;;
    2) skipped=1 ;;
    *) failed=1 ;;
  esac
  kill $watchdog 2>/dev/null
  rm -r "$dir"
done
[ $failed = 1 ] && exit 1
[ $skipped = 1 ] && { echo "some checks could not look: wake and unlock the screen, then run again"; exit 2; }
exit 0
