#!/bin/zsh
# Runs the benchmark on copies of the given boards: scripts/bench.sh LABEL RUNS BOARD...
# Appends one JSON line per run to build/bench.jsonl. Needs a Release build.
set -e
app=build/Build/Products/Release/Breezy.app/Contents/MacOS/Breezy
label=$1 runs=$2
shift 2
for board in $@; do
  for i in $(seq $runs); do
    dir=$(mktemp -d)
    cp $board $dir/run.breezy
    # the display must be awake for rendering to cost what it costs; a stuck run still ends
    caffeinate -u -t 30 >/dev/null 2>&1 &
    sleep 1
    ( sleep 60; pkill -f "BreezyBench $dir" ) >/dev/null 2>&1 &
    $app -ApplePersistenceIgnoreState YES -BreezyBoard $dir/run.breezy -BreezyBench $dir/out.json 2>/dev/null
    echo "{\"label\":\"$label\",\"board\":\"${board:t:r}\",\"r\":$(cat $dir/out.json)}" >> build/bench.jsonl
    rm -rf $dir
  done
done
