#!/bin/zsh
# Serves sync.php at http://127.0.0.1:58566/sync.php with a SQLite database in build/, for trying sync
# between the Mac app and the web app on this Mac: server/dev.sh
set -e
here=${0:A:h}
root=${here:h}
cd $here
mkdir -p $root/build
db=$root/build/sync-dev.db
# a database from before record epochs is started afresh
current='$db = new PDO("sqlite:" . $argv[1]); exit(in_array("epoch", array_column($db->query("PRAGMA table_info(records)")->fetchAll(), "name")) ? 0 : 1);'
if [[ ! -s $db ]] || ! php -r $current $db; then
  rm -f $db
  php -r '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents("schema.sql"));' $db
fi
# the relay npm --prefix relay run dev serves; BREEZY_DEV_RELAY= leaves it out
relay=${BREEZY_DEV_RELAY-ws://127.0.0.1:58568/}
print -r -- "<?php return ['dsn' => 'sqlite:$db'${relay:+, 'relay' => '$relay'}];" > $root/build/sync-dev-config.php
BREEZY_CONFIG=$root/build/sync-dev-config.php exec php -S 127.0.0.1:58566 -t .
