#!/bin/bash
# tools/vm/reset-tcc.sh <vm> — revoke Capture's grants inside a running VM
# without throwing the VM away (same commands the README gives for the host).
source "$(dirname "$0")/common.sh"; need_tart
vm="${1:?usage: reset-tcc.sh <vm>}"
vm_ssh "$vm" 'for s in ScreenCapture ListenEvent Accessibility Microphone Camera; do sudo tccutil reset $s com.studiocartelli.capture; done'
