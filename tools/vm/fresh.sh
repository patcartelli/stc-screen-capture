#!/bin/bash
# Throwaway VM with the current build installed.
#   tools/vm/fresh.sh            clean TCC state — first-run / permission prompts
#   tools/vm/fresh.sh --granted  grants already in place — straight to recording
# Tear down with tools/vm/clean.sh (or just close the window and run clean later).
source "$(dirname "$0")/common.sh"; need_tart
case "${1:-}" in
  "") src="$BASE" ;;
  --granted) src="$GRANTED" ;;
  *) echo "usage: fresh.sh [--granted]" >&2; exit 1 ;;
esac
[ -d "$APP" ] || { echo "no $APP — run: npm run app:package" >&2; exit 1; }
vm_exists "$src" || { echo "$src missing — see tools/vm/README.md"; exit 1; }
vm="${RUN_PREFIX}$(date +%m%d-%H%M%S)"
tart clone "$src" "$vm"          # APFS copy-on-write: instant, ~0 extra disk
vm_boot "$vm"
vm_install_app "$vm"
vm_launch_app "$vm"
echo "running: $vm   (ssh: tools/vm/ssh.sh $vm)"
# Keep the runner owned by this command. Agent/terminal process supervisors can
# reap orphaned background children even when nohup ignores SIGHUP.
echo "Keep this command open while testing. Close the VM window or press Ctrl+C to stop."
trap 'tart stop "$vm" 2>/dev/null || true; exit 130' INT
trap 'tart stop "$vm" 2>/dev/null || true; exit 143' TERM
wait "$VM_PID"
