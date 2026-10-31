#!/bin/bash
# Runs FILE on the probe session's iPhone (.github/workflows/probe-session.yaml) and prints what it printed, waiting at
# most 12 minutes: scripts/probe-session.sh FILE. With --ready it only waits, at most 20 minutes, for the session to be up.
set -euo pipefail
cd "$(dirname "$0")/.."
result() { git fetch --quiet origin probe-results 2> /dev/null && git show "FETCH_HEAD:results/$1" 2> /dev/null; }
if [ "${1:-}" = "--ready" ]; then
  end=$(( SECONDS + 1200 ))
  until result ready.txt; do
    [ $SECONDS -lt $end ] || { echo "the probe session was not up in 20 minutes" >&2; exit 1; }
    sleep 10
  done
  exit
fi
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp "$1" "$dir/run.sh"
git -C "$dir" init --quiet
git -C "$dir" add run.sh
git -C "$dir" -c user.name="probe" -c user.email="probe@users.noreply.github.com" commit --quiet --message "probe: $(basename "$1")"
sha=$(git -C "$dir" rev-parse HEAD)
git -C "$dir" push --quiet --force "$(git remote get-url origin)" HEAD:refs/heads/probe-commands
t=$SECONDS
end=$(( SECONDS + 720 ))
until out=$(result "$sha.txt"); do
  [ $SECONDS -lt $end ] || { echo "no result for $sha in 12 minutes" >&2; exit 1; }
  sleep 5
done
echo "$out"
echo "(round trip $(( SECONDS - t )) s)"
