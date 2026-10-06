#!/bin/zsh
# Runs the in-app self-tests (see Breezy/Support/SelfTest.swift) on copies of scripts/selftest/*.breezy.
# Needs a Debug build. Exits non-zero if any check fails.
app=build/Build/Products/Debug/Breezy.app/Contents/MacOS/Breezy
failed=0
for fixture in ${0:a:h}/selftest/*.breezy; do
  dir=$(mktemp -d)
  cp $fixture $dir/board.breezy
  # animations stall while the display sleeps behind a locked screen
  caffeinate -u -t 15 >/dev/null 2>&1 &
  ( sleep 40; pkill -f "BreezySelfTest ${fixture:t:r}" ) >/dev/null 2>&1 &
  watchdog=$!
  $app -ApplePersistenceIgnoreState YES -BreezyBoard $dir/board.breezy -BreezySelfTest ${fixture:t:r} 2>/dev/null | grep -E '^(PASS|FAIL)' || { echo "FAIL ${fixture:t:r}: no result"; failed=1; }
  [[ ${pipestatus[1]} -ne 0 ]] && failed=1
  kill $watchdog 2>/dev/null
  rm -r $dir
done
exit $failed
