#!/bin/bash
# One-time (and again whenever the signing cert or bundle ID changes):
# clone stc-base -> stc-granted, install Capture, and you click the grants by hand.
# Grants are keyed to com.studiocartelli.capture + the "STC Dev Signing" cert,
# so they survive every later rebuild signed with that cert.
source "$(dirname "$0")/common.sh"; need_tart
vm_exists "$GRANTED" && { echo "$GRANTED exists. Delete it first: tart delete $GRANTED"; exit 1; }
tart clone "$BASE" "$GRANTED"
vm_boot "$GRANTED"
vm_install_app "$GRANTED"
vm_launch_app "$GRANTED"
cat <<MSG

In the $GRANTED window: start a recording in Capture and approve Screen Recording,
Input Monitoring, and Microphone when asked (System Settings will
open; the guest password is "admin"). Relaunch Capture if macOS asks you to.
MSG
read -r -p "Press Return once every grant is approved… "
vm_shutdown "$GRANTED"
echo "saved $GRANTED."
