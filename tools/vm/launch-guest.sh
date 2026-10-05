#!/bin/bash
# Runs INSIDE the guest, over SSH. Launch Services preserves the app's TCC identity.
set -euo pipefail
log=/tmp/stc-capture-launch.log
: > "$log"

diagnostics() {
  echo "Capture did not stay running with its helper. Guest log: $log" >&2
  cat "$log" >&2
  echo "Guest crash reports:" >&2
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 \( -name '*Capture*.ips' -o -name '*stc-helper*.ips' \) -print 2>/dev/null >&2 || true
}

if ! open --stdout "$log" --stderr "$log" /Applications/Capture.app >>"$log" 2>&1; then
  diagnostics
  exit 1
fi

# 'open' only acknowledges the request. Require the SAME main/helper processes
# to survive five consecutive observations, within a bounded startup window.
last=""; stable=0
for _ in $(seq 20); do
  main=$(pgrep -f '^/Applications/Capture\.app/Contents/MacOS/Capture( |$)' || true)
  helper=$(pgrep -f '^/Applications/Capture\.app/Contents/Resources/stc-helper( |$)' || true)
  pair="$main/$helper"
  if [ -n "$main" ] && [ -n "$helper" ]; then
    if [ "$pair" = "$last" ]; then stable=$((stable + 1)); else stable=0; fi
    if [ "$stable" -ge 5 ]; then
      echo "Capture and its helper survived startup. Guest log: $log"
      exit 0
    fi
  else
    stable=0
  fi
  last="$pair"
  sleep 1
done
diagnostics
exit 1
