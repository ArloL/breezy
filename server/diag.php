<?php
// What a device's app recorded (web/flight.ts), sent by a device of a space when its owner asks or the app sees
// something wrong, and read back with the space's own token by whoever debugs it: geometry, ids and decisions, never a
// card's words. See docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md. Its helpers are sync.php's,
// copied so that sync.php stays as it is.
declare(strict_types=1);

const MAX_REQUEST = 524288;
const WHY = ['asked', 'error', 'sight'];
const PER_HOUR = 20;
const KEEP = 100;
const KEEP_SECONDS = 30 * 86400;
const ORIGINS = ['https://breezy.k5d.de', 'http://localhost:58565'];

function reply(int $status, ?array $body = null): void {
  http_response_code($status);
  if ($body !== null) {
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
  }
  exit;
}

function b64d(mixed $s): ?string {
  if (!is_string($s) || !preg_match('/^[A-Za-z0-9_-]*$/', $s)) return null;
  $t = strtr($s, '-_', '+/');
  $d = base64_decode(str_pad($t, (int)ceil(strlen($t) / 4) * 4, '='), true);
  return $d === false ? null : $d;
}

function b64e(string $d): string {
  return rtrim(strtr(base64_encode($d), '+/', '-_'), '=');
}

function bytes(mixed $s, int $length): ?string {
  $d = b64d($s);
  return $d !== null && strlen($d) === $length ? $d : null;
}

function query(PDO $db, string $sql, array $params): PDOStatement {
  $st = $db->prepare($sql);
  foreach (array_values($params) as $i => $v) $st->bindValue($i + 1, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_LOB);
  $st->execute();
  return $st;
}

/** Raw DEFLATE `$data` inflated; 413 past MAX_REQUEST, 400 when it is not DEFLATE. */
function inflated(string $data): string {
  $z = inflate_init(ZLIB_ENCODING_RAW);
  $out = '';
  foreach (str_split($data, 1024) as $chunk) {
    $part = @inflate_add($z, $chunk, ZLIB_SYNC_FLUSH);
    if ($part === false) reply(400, ['error' => 'encoding']);
    $out .= $part;
    if (strlen($out) > MAX_REQUEST) reply(413);
  }
  if (inflate_get_status($z) !== ZLIB_STREAM_END) reply(400, ['error' => 'encoding']);
  return $out;
}

ini_set('display_errors', '0');
set_exception_handler(function (Throwable $e) {
  error_log((string)$e);
  reply(500, ['error' => 'server']);
});

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ORIGINS, true)) {
  header("Access-Control-Allow-Origin: $origin");
  header('Access-Control-Allow-Headers: Authorization, Content-Encoding, Content-Type');
  header('Access-Control-Allow-Methods: GET, POST');
  header('Access-Control-Max-Age: 86400');
}
header('Vary: Origin');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') reply(204);

$space = bytes($_GET['space'] ?? null, 16);
if ($space === null) reply(400, ['error' => 'space']);
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
  ?? (function_exists('getallheaders') ? (array_change_key_case(getallheaders(), CASE_LOWER)['authorization'] ?? '') : '');
$token = preg_match('/^Bearer ([A-Za-z0-9_-]+)$/', $auth, $m) ? bytes($m[1], 32) : null;
if ($token === null) reply(401);

$config = require (getenv('BREEZY_CONFIG') ?: __DIR__ . '/config.php');
$db = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
// production has no step that changes its schema: the table comes with the first request that needs it
$db->exec('CREATE TABLE IF NOT EXISTS diagnostics (space BINARY(16) NOT NULL, id BINARY(16) NOT NULL, at BIGINT NOT NULL,
  why VARCHAR(8) NOT NULL, data MEDIUMBLOB NOT NULL, PRIMARY KEY (space, id))');

// only a device of a space that exists, as sync.php knows it by its token
$row = query($db, 'SELECT token_hash FROM spaces WHERE id = ?', [$space])->fetch(PDO::FETCH_ASSOC);
if (!$row || !hash_equals($row['token_hash'], hash('sha256', $token, true))) reply(401);
$now = time();

if ($method === 'GET') {
  if (isset($_GET['id'])) {
    $id = bytes($_GET['id'], 16);
    if ($id === null) reply(400, ['error' => 'id']);
    $r = query($db, 'SELECT data FROM diagnostics WHERE space = ? AND id = ?', [$space, $id])->fetch(PDO::FETCH_ASSOC);
    if (!$r) reply(404);
    header('Content-Type: application/json');
    echo is_resource($r['data']) ? stream_get_contents($r['data']) : $r['data'];
    exit;
  }
  $list = [];
  foreach (query($db, 'SELECT id, at, why, LENGTH(data) AS size FROM diagnostics WHERE space = ? ORDER BY at DESC', [$space])->fetchAll(PDO::FETCH_ASSOC) as $r) {
    $list[] = ['id' => b64e(is_resource($r['id']) ? stream_get_contents($r['id']) : $r['id']), 'at' => (int)$r['at'], 'why' => $r['why'], 'size' => (int)$r['size']];
  }
  reply(200, ['recordings' => $list]);
}

if ($method !== 'POST') reply(405);
$body = file_get_contents('php://input', false, null, 0, MAX_REQUEST + 1);
if (strlen($body) > MAX_REQUEST) reply(413);
if (strtolower($_SERVER['HTTP_CONTENT_ENCODING'] ?? '') === 'deflate') $body = inflated($body);
// as objects, so that an empty object in a recording comes back as one
$request = json_decode($body);
if (!is_object($request) || !in_array($request->why ?? null, WHY, true)) reply(400, ['error' => 'why']);
if (!is_object($request->recording ?? null)) reply(400, ['error' => 'recording']);

$recent = (int)query($db, 'SELECT COUNT(*) FROM diagnostics WHERE space = ? AND at > ?', [$space, $now - 3600])->fetchColumn();
if ($recent >= PER_HOUR) reply(429);
$id = random_bytes(16);
query($db, 'INSERT INTO diagnostics (space, id, at, why, data) VALUES (?, ?, ?, ?, ?)',
  [$space, $id, $now, $request->why, json_encode($request->recording, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
// a space keeps its newest, for a month
query($db, 'DELETE FROM diagnostics WHERE space = ? AND at < ?', [$space, $now - KEEP_SECONDS]);
$ids = query($db, 'SELECT id FROM diagnostics WHERE space = ? ORDER BY at DESC', [$space])->fetchAll(PDO::FETCH_COLUMN);
foreach (array_slice($ids, KEEP) as $o) query($db, 'DELETE FROM diagnostics WHERE space = ? AND id = ?', [$space, is_resource($o) ? stream_get_contents($o) : $o]);
reply(200, ['id' => b64e($id)]);
