#!/bin/bash
# Stop and delete every disposable stc-run-* VM. Leaves stc-base and stc-granted.
source "$(dirname "$0")/common.sh"; need_tart
for vm in $(tart list --quiet | grep "^$RUN_PREFIX" || true); do
  tart stop "$vm" 2>/dev/null || true
  tart delete "$vm" && echo "deleted $vm"
done
