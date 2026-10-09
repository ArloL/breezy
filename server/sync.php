<?php
// Breezy's sync server: keeps each space's records, encrypted on the devices, and hands back those
// changed since a version. Responses name the live layer's relay when config.php does.
// A space's epoch changes when its database is restored, so that devices pull
// everything again; records written before that are marked stale. See
// docs/superpowers/specs/2026-10-08-breezy-sync-design.md.
declare(strict_types=1);

const PAGE = 500;
const MAX_BLOB = 65536;
const MAX_REQUEST = 1048576;
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

/** A record as the devices get it; `stale` when it was written before the space's epoch changed. */
function pulled(array $r, string $epoch): array {
  $out = ['id' => b64e($r['id']), 'version' => (int)$r['version'], 'blob' => b64e($r['data'])];
  if ($r['epoch'] !== $epoch) $out['stale'] = true;
  return $out;
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
  foreach (str_split($data, 65536) as $chunk) {
    $part = @inflate_add($z, $chunk, ZLIB_SYNC_FLUSH);
    if ($part === false) reply(400, ['error' => 'encoding']);
    $out .= $part;
    if (strlen($out) > MAX_REQUEST) reply(413);
  }
  if (inflate_get_status($z) !== ZLIB_STREAM_END) reply(400, ['error' => 'encoding']);
  return $out;
}

/** `body` with the relay's address, when the config names one. */
function named(array $body): array {
  global $relay;
  return $relay === null ? $body : $body + ['relay' => $relay];
}

ini_set('display_errors', '0');
set_exception_handler(function (Throwable $e) {
  global $db;
  if (isset($db) && $db->inTransaction()) $db->rollBack();
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
ob_start('ob_gzhandler');

$space = bytes($_GET['space'] ?? null, 16);
if ($space === null) reply(400, ['error' => 'space']);
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
  ?? (function_exists('getallheaders') ? (array_change_key_case(getallheaders(), CASE_LOWER)['authorization'] ?? '') : '');
$token = preg_match('/^Bearer ([A-Za-z0-9_-]+)$/', $auth, $m) ? bytes($m[1], 32) : null;
if ($token === null) reply(401);
$hash = hash('sha256', $token, true);

$config = require (getenv('BREEZY_CONFIG') ?: __DIR__ . '/config.php');
$relay = is_string($config['relay'] ?? null) && preg_match('#^wss?://#', $config['relay']) ? $config['relay'] : null;
$db = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$lock = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';

if ($method === 'GET') {
  $since = filter_var($_GET['since'] ?? '0', FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
  if ($since === false) reply(400, ['error' => 'since']);
  $row = query($db, 'SELECT token_hash, epoch FROM spaces WHERE id = ?', [$space])->fetch(PDO::FETCH_ASSOC);
  if ($row && !hash_equals($row['token_hash'], $hash)) reply(401);
  $records = [];
  if ($row) {
    $st = query($db, 'SELECT id, version, data, epoch FROM records WHERE space = ? AND version > ? ORDER BY version LIMIT ' . PAGE, [$space, $since]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $records[] = pulled($r, $row['epoch']);
  }
  $cursor = $records ? $records[count($records) - 1]['version'] : $since;
  reply(200, named(['records' => $records, 'cursor' => $cursor, 'epoch' => $row ? b64e($row['epoch']) : null]));
}

if ($method !== 'POST') reply(405);
$body = file_get_contents('php://input', false, null, 0, MAX_REQUEST + 1);
if (strlen($body) > MAX_REQUEST) reply(413);
if (strtolower($_SERVER['HTTP_CONTENT_ENCODING'] ?? '') === 'deflate') $body = inflated($body);
$request = json_decode($body, true);
$list = is_array($request) ? ($request['writes'] ?? null) : null;
if (!is_array($list) || array_values($list) !== $list) reply(400, ['error' => 'writes']);
$since = is_array($request) && array_key_exists('since', $request) ? $request['since'] : null;
if ($since !== null && (!is_int($since) || $since < 0)) reply(400, ['error' => 'since']);
$want = null;
if (is_array($request) && array_key_exists('epoch', $request)) {
  $want = bytes($request['epoch'], 16);
  if ($want === null) reply(400, ['error' => 'epoch']);
}
$writes = [];
foreach ($list as $w) {
  $id = is_array($w) ? bytes($w['id'] ?? null, 16) : null;
  $data = is_array($w) ? b64d($w['blob'] ?? null) : null;
  $base = is_array($w) ? ($w['base'] ?? null) : null;
  if ($id === null || $data === null || !is_int($base) || $base < 0 || strlen($data) < 28) reply(400, ['error' => 'write']);
  if (strlen($data) > MAX_BLOB) reply(413);
  $writes[] = [$id, $base, $data];
}

// Concurrent creators of one space deadlock or collide on its key; the loser runs again.
for ($attempt = 1;; $attempt++) {
  try {
    $db->beginTransaction();
    $row = query($db, "SELECT token_hash, version, epoch FROM spaces WHERE id = ?$lock", [$space])->fetch(PDO::FETCH_ASSOC);
    if (!$row && $want !== null) {
      $db->rollBack();
      reply(200, named(['accepted' => [], 'refused' => [], 'epoch' => null]));
    } elseif (!$row) {
      $epoch = random_bytes(16);
      query($db, 'INSERT INTO spaces (id, token_hash, version, epoch) VALUES (?, ?, 0, ?)', [$space, $hash, $epoch]);
      $version = 0;
    } elseif (!hash_equals($row['token_hash'], $hash)) {
      $db->rollBack();
      reply(401);
    } elseif ($want !== null && !hash_equals($row['epoch'], $want)) {
      $db->rollBack();
      reply(200, named(['accepted' => [], 'refused' => [], 'epoch' => b64e($row['epoch'])]));
    } else {
      $version = (int)$row['version'];
      $epoch = $row['epoch'];
    }
    $accepted = [];
    $refused = [];
    foreach ($writes as [$id, $base, $data]) {
      $stored = query($db, 'SELECT id, version, data, epoch FROM records WHERE space = ? AND id = ?', [$space, $id])->fetch(PDO::FETCH_ASSOC);
      // a record the server does not have is taken whatever its base, so that devices can refill a lost database
      if ($stored && (int)$stored['version'] !== $base) {
        $refused[] = pulled($stored, $epoch);
        continue;
      }
      $version++;
      $sql = $stored
        ? 'UPDATE records SET version = ?, data = ?, epoch = ? WHERE space = ? AND id = ?'
        : 'INSERT INTO records (version, data, epoch, space, id) VALUES (?, ?, ?, ?, ?)';
      query($db, $sql, [$version, $data, $epoch, $space, $id]);
      $accepted[] = ['id' => b64e($id), 'version' => $version];
    }
    query($db, 'UPDATE spaces SET version = ? WHERE id = ?', [$version, $space]);
    $db->commit();
    break;
  } catch (PDOException $e) {
    if ($db->inTransaction()) $db->rollBack();
    if ($attempt >= 5 || !in_array((string)$e->getCode(), ['40001', '23000'], true)) throw $e;
    usleep(random_int(5000, 50000));
  }
}
$out = ['accepted' => $accepted, 'refused' => $refused, 'epoch' => b64e($epoch)];
if ($since !== null) {
  $own = array_column($accepted, 'version');
  $rows = query($db, 'SELECT id, version, data, epoch FROM records WHERE space = ? AND version > ? ORDER BY version LIMIT ' . PAGE, [$space, $since])->fetchAll(PDO::FETCH_ASSOC);
  $last = $rows ? (int)$rows[count($rows) - 1]['version'] : 0;
  $out['cursor'] = count($rows) === PAGE ? $last : max($version, $last, $since);
  $out['records'] = array_values(array_map(fn($r) => pulled($r, $epoch), array_filter($rows, fn($r) => !in_array((int)$r['version'], $own, true))));
}
reply(200, named($out));
