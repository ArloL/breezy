#!/bin/bash
# Keeps 58560–58575, where the local web server, sync.php and the relay listen, from being any connection's own port on
# a CI runner: Linux's and macOS's ephemeral ranges both hold them, and once a long-lived connection on the relay's port
# kept wrangler from starting for every case of a job. Linux reserves them; macOS's range is moved below them. Needs sudo.
set -euo pipefail
case $(uname) in
  Linux) sudo sysctl --write net.ipv4.ip_local_reserved_ports=58560-58575 ;;
  Darwin) sudo sysctl -w net.inet.ip.portrange.first=32768 net.inet.ip.portrange.last=58559 ;;
esac
