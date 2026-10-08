#!/bin/bash
# Builds the web app and the sync server into OUT as breezy.k5d.de serves them, from the repo root:
# scripts/build-site.sh OUT [VERSION]. With VERSION the ⋯ menu shows it and version.json lists every
# file the service worker keeps offline; without it the page keeps its placeholder version.
set -euo pipefail
out=$1
version=${2:-}
rm -rf "$out"
mkdir -p "$out"
cp -R web/. "$out/"
rm -r "$out/test" "$out/package.json"
if [[ -n $version ]]; then
  sed -i.orig "s/data-version=\"dev\"/data-version=\"${version}\"/" "$out/index.html"
  rm "$out/index.html.orig"
  grep --fixed-strings --quiet "data-version=\"${version}\"" "$out/index.html"
  node scripts/make-web-version.mjs "$out" "$version"
fi
# after the version file, which lists what the service worker keeps offline: not these
cp server/sync.php server/.htaccess "$out/"
