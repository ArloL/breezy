#!/bin/zsh
# Runs the in-app self-tests (see Breezy/Support/SelfTest.swift) on copies of scripts/selftest/*.breezy:
# scripts/selftest.sh [CONFIGURATION], Debug by default. Exits 1 if any check fails, else 2 if any could not look, as
# pixel checks cannot behind a locked or sleeping screen.
app=build/Build/Products/${1:-Debug}/Breezy.app/Contents/MacOS/Breezy
failed=0
skipped=0
for fixture in ${0:a:h}/selftest/*.breezy; do
  dir=$(mktemp -d)
  cp $fixture $dir/board.breezy
  # animations stall while the display sleeps behind a locked screen
  caffeinate -u -t 15 >/dev/null 2>&1 &
  sleep 1
  ( sleep 40; pkill -f "BreezySelfTest ${fixture:t:r}" ) >/dev/null 2>&1 &
  watchdog=$!
  out=$($app -ApplePersistenceIgnoreState YES -BreezyBoard $dir/board.breezy -BreezySelfTest ${fixture:t:r} 2>/dev/null)
  code=$?
  line=$(print -r -- $out | grep -E '^(PASS|FAIL|SKIP)')
  [[ -z $line ]] && { line="FAIL ${fixture:t:r}: no result (exit $code)"; code=1 }
  print -r -- $line
  case $code in
    0) ;;
    2) skipped=1 ;;
    *) failed=1 ;;
  esac
  kill $watchdog 2>/dev/null
  rm -r $dir
done
(( failed )) && exit 1
(( skipped )) && { echo "some checks could not look: wake and unlock the screen, then run again"; exit 2 }
exit 0
