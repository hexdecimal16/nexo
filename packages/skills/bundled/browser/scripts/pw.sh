#!/bin/bash
# Run playwright-cli against one of the user's Chrome profiles through the Playwright Extension.
# Usage: pw.sh <profile> [--raw|--json] <playwright-cli command> [args...]
#        pw.sh --profiles    list profiles with a stored token (names only)
# The token comes from the `playwright-<profile>` entry in credentials.json (set it with
# `nexo settings set-key playwright-<profile>`), or from the older file $NEXO_HOME/playwright-token-<profile>.
# Without a token, Chrome shows the extension's connect page for the user to approve.
set -euo pipefail
home="${NEXO_HOME:-$HOME/.nexo}"
creds="$home/credentials.json"
usage() { echo "usage: pw.sh <profile> <playwright-cli args...> | pw.sh --profiles" >&2; exit 2; }
if [ "${1:-}" = "--profiles" ]; then
  { [ -r "$creds" ] && node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of Object.keys(c))if(/^playwright-[a-z0-9][a-z0-9-]*$/.test(k)&&c[k]&&c[k].apiKey)console.log(k.slice(11))' "$creds"; } || true
  for f in "$home"/playwright-token-*; do [ -r "$f" ] && basename "$f" | sed 's/^playwright-token-//'; done
  exit 0
fi
profile="${1:-}"
[[ "$profile" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || usage
shift
command -v playwright-cli > /dev/null || { echo "pw.sh: playwright-cli not found; install it with: npm install -g @playwright/cli@latest" >&2; exit 1; }
for a in "$@"; do
  case "$a" in
    -*) continue ;;
    eval|run-code) echo "pw.sh: '$a' runs arbitrary code in signed-in pages and is disabled; ask the user first" >&2; exit 3 ;;
    *) break ;;
  esac
done
tok=""
if [ -r "$creds" ]; then
  tok="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((c[process.argv[2]]||{}).apiKey||"")}catch{}' "$creds" "playwright-$profile")"
fi
if [ -z "$tok" ] && [ -r "$home/playwright-token-$profile" ]; then tok="$(cat "$home/playwright-token-$profile")"; fi
if [ -n "$tok" ]; then
  PLAYWRIGHT_MCP_EXTENSION_TOKEN="$tok"
  export PLAYWRIGHT_MCP_EXTENSION_TOKEN
fi
unset tok
exec playwright-cli -s="$profile" "$@"
