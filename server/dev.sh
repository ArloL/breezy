#!/bin/zsh
# Serves sync.php at http://127.0.0.1:58566/sync.php with a SQLite database in build/, for trying sync
# between the Mac app and the web app on this Mac: server/dev.sh
set -e
here=${0:A:h}
root=${here:h}
cd $here
mkdir -p $root/build
db=$root/build/sync-dev.db
[[ -s $db ]] || php -r '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents("schema.sql"));' $db
print -r -- "<?php return ['dsn' => 'sqlite:$db'];" > $root/build/sync-dev-config.php
BREEZY_CONFIG=$root/build/sync-dev-config.php exec php -S 127.0.0.1:58566 -t .
