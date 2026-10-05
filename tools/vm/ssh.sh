#!/bin/bash
# tools/vm/ssh.sh <vm> [command…]   — shell into (or run a command in) a running VM.
source "$(dirname "$0")/common.sh"; need_tart
vm="${1:?usage: ssh.sh <vm> [cmd]}"; shift
vm_ssh "$vm" "$@"
