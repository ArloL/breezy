<?php
// Copy to config.php, which git ignores, and fill in the database. `relay` is the live layer's relay; leave it out for none.
return ['dsn' => 'mysql:host=localhost;dbname=breezy;charset=utf8mb4', 'user' => 'breezy', 'password' => '', 'relay' => 'wss://breezy-relay.example.workers.dev/'];
