#!/bin/sh
set -eu

env_file=${1:-.env.docker}
[ -f "$env_file" ] || { echo "$env_file is missing." >&2; exit 2; }

value() {
  awk -F= -v wanted="$1" '$1 == wanted {sub(/^[^=]*=/, ""); value=$0} END {print value}' "$env_file"
}

bind=$(value SERVER_BIND_IP)
port=$(value SERVER_HOST_PORT)
[ -n "$bind" ] || bind=0.0.0.0
[ -n "$port" ] || port=8097

echo
echo "FileList Streaming is ready."
echo "Web app addresses:"
case "$bind" in
  0.0.0.0|::|'')
    echo "  http://localhost:$port"
    ;;
  127.0.0.1|localhost)
    echo "  http://localhost:$port"
    ;;
  *:*)
    echo "  http://[$bind]:$port"
    ;;
  *)
    echo "  http://$bind:$port"
    ;;
esac

case "$bind" in
  0.0.0.0|::|'')
    if command -v hostname >/dev/null 2>&1; then
      hostname -I 2>/dev/null | tr ' ' '\n' | awk 'NF && $0 !~ /^127\./ && $0 != "::1" {print}' | while IFS= read -r address; do
        case "$address" in
          *:*) echo "  http://[$address]:$port" ;;
          *) echo "  http://$address:$port" ;;
        esac
      done
    fi
    ;;
esac
echo "Use a non-localhost address for the Tizen TV or another device on the LAN."
