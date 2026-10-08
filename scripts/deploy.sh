#!/bin/bash
# Uploads a built site to breezy.k5d.de over FTPS: scripts/deploy.sh SITE_DIR
# Needs BREEZY_WEB_USER and BREEZY_WEB_PASSWORD; with BREEZY_CONFIG_FILE set it also uploads that file
# as the sync server's config.php, above the web root. The files that announce a new version go up
# last, so the service worker never sees a version whose files are not there yet. Files the
# site no longer has stay on the server.
set -euo pipefail
site=$1
host=${BREEZY_FTP_HOST:-a2e13.netcup.net}
config=$(mktemp)
trap 'rm -f "$config"' EXIT
escape() { local s=${1//\\/\\\\}; printf '%s' "${s//\"/\\\"}"; }
printf 'user = "%s:%s"\n' "$(escape "$BREEZY_WEB_USER")" "$(escape "$BREEZY_WEB_PASSWORD")" > "$config"

upload() {
  curl --silent --show-error --fail --ssl-reqd --config "$config" --ftp-create-dirs \
    --upload-file "$site/$1" "ftp://$host/httpdocs/$1"
  echo "uploaded $1"
}

if [[ -n ${BREEZY_CONFIG_FILE:-} ]]; then
  curl --silent --show-error --fail --ssl-reqd --config "$config" \
    --upload-file "$BREEZY_CONFIG_FILE" "ftp://$host/config.php"
  echo "uploaded config.php"
fi

last=(index.html sw.js version.json)
while IFS= read -r f; do
  [[ " ${last[*]} " == *" $f "* ]] || upload "$f"
done < <(cd "$site" && find . -type f | sed 's#^\./##' | sort)
for f in "${last[@]}"; do
  if [[ -f $site/$f ]]; then upload "$f"; fi
done
