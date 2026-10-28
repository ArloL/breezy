#!/bin/zsh
# Runs server/test against sync.php on PHP's built-in server with a throwaway SQLite database, then the
# Mac's HTTP client against it, and its FakeServer against what sync.php answered: server/test.sh
set -e
cd ${0:A:h}
dir=$(mktemp -d)
trap 'kill $pid 2>/dev/null; rm -rf $dir' EXIT
php -r '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents("schema.sql"));' $dir/test.db
print -r -- "<?php return ['dsn' => 'sqlite:$dir/test.db'];" > $dir/config.php
export BREEZY_CONFIG=$dir/config.php
# a low memory limit, so that what inflates unchecked fails here
php -d memory_limit=64M -S 127.0.0.1:58566 -t . >$dir/php.log 2>&1 &
pid=$!
sleep 1
# else the tests would talk to whatever else serves there, as a dev server left running
kill -0 $pid 2>/dev/null || { print -u2 "php could not serve on 127.0.0.1:58566:"; cat $dir/php.log >&2; exit 1 }
export BREEZY_URL=http://127.0.0.1:58566/sync.php
export BREEZY_CONTRACT=$dir/contract.json
# one file at a time: they share one database, which diag.test.mjs and sync.test.mjs also write straight to, and
# SQLite told a write through sync.php the database was locked
node --test --test-concurrency=1 test/*.test.mjs || { cat $dir/php.log; exit 1 }
swift test --package-path ../BreezyKit --filter 'HTTPTransportTests|ServerContractTests'
