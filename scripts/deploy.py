#!/usr/bin/env python3
"""Uploads a site from scripts/build-site.sh to breezy.k5d.de over FTPS: scripts/deploy.py SITE

Needs BREEZY_WEB_USER, BREEZY_WEB_PASSWORD, BREEZY_DATABASE_USER and BREEZY_DATABASE_PASSWORD:
locally from mise.local.toml (mise exec -- scripts/deploy.py SITE), in CI from the production
environment. Only files whose hash differs from the live version.json go up; the files that
announce a new version go last, so the service worker never sees a version whose files are not
there yet. Every command times out, and a file that fails is retried on a new connection.
"""

import base64
import ftplib
import io
import json
import os
import ssl
import sys
import time
import urllib.request
from pathlib import Path

HOST = os.environ.get("BREEZY_FTP_HOST", "a2e13.netcup.net")
SITE_URL = os.environ.get("BREEZY_SITE_URL", "https://breezy.k5d.de")
DSN = "mysql:host={};dbname={};charset=utf8mb4".format(
    os.environ.get("BREEZY_DATABASE_HOST", "10.35.46.20"), os.environ.get("BREEZY_DATABASE_NAME", "k115653_breezy"))
LAST = ["index.html", "sw.js", "version.json"]
TIMEOUT = 30
ATTEMPTS = 4


class FTPS(ftplib.FTP_TLS):
    """ProFTPD expects data connections to reuse the control connection's TLS session; without it
    some transfers hang."""

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
        return conn, size


class Uploader:
    def __init__(self):
        self.ftp = None
        self.dirs = set()

    def connect(self):
        self.close()
        self.ftp = FTPS(HOST, timeout=TIMEOUT, context=ssl.create_default_context())
        self.ftp.login(os.environ["BREEZY_WEB_USER"], os.environ["BREEZY_WEB_PASSWORD"])
        self.ftp.prot_p()
        self.dirs = {"httpdocs"}

    def close(self):
        if self.ftp:
            try:
                self.ftp.close()
            except OSError:
                pass
            self.ftp = None

    def makedirs(self, path):
        parts = path.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            d = "/".join(parts[:i])
            if d in self.dirs:
                continue
            try:
                self.ftp.mkd(d)
            except ftplib.error_perm:
                pass  # already there
            self.dirs.add(d)

    def upload(self, data, remote):
        for attempt in range(1, ATTEMPTS + 1):
            try:
                if not self.ftp:
                    self.connect()
                self.makedirs(remote)
                self.ftp.storbinary("STOR " + remote, io.BytesIO(data))
                print("uploaded", remote, flush=True)
                return
            except (OSError, EOFError, ftplib.Error) as error:
                self.close()
                if attempt == ATTEMPTS:
                    raise SystemExit(f"could not upload {remote}: {error}")
                print(f"retrying {remote} after: {error}", flush=True)
                time.sleep(2 * attempt)


def live_files():
    try:
        with urllib.request.urlopen(f"{SITE_URL}/version.json?t={int(time.time())}", timeout=20) as r:
            return json.load(r).get("files", {})
    except (OSError, ValueError):
        return {}


def config_php():
    details = json.dumps({"dsn": DSN, "user": os.environ["BREEZY_DATABASE_USER"],
                          "password": os.environ["BREEZY_DATABASE_PASSWORD"]})
    encoded = base64.b64encode(details.encode()).decode()
    return f"<?php return json_decode(base64_decode('{encoded}'), true);\n".encode()


def main():
    site = Path(sys.argv[1])
    version = json.loads((site / "version.json").read_text())
    live = live_files()
    changed = [f for f, h in sorted(version["files"].items()) if live.get(f) != h and f not in LAST]
    started = time.time()
    up = Uploader()
    # the database's details sit next to sync.php, after the .htaccess that keeps them from browsers
    up.upload((site / ".htaccess").read_bytes(), "httpdocs/.htaccess")
    up.upload(config_php(), "httpdocs/config.php")
    for f in ["sync.php"] + changed + LAST:
        up.upload((site / f).read_bytes(), "httpdocs/" + f)
    up.close()
    print(f"deployed {version['version']} to {SITE_URL}: {len(changed)} changed files in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
