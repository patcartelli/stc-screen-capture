# Shared settings for tools/vm/*.sh — sourced, not run.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="ghcr.io/cirruslabs/macos-tahoe-base:latest"
BASE="stc-base"
GRANTED="stc-granted"
RUN_PREFIX="stc-run-"
KEY="$HOME/.ssh/stc-vm"
APP="${STC_VM_APP:-$REPO/release/mac-arm64/Capture.app}"
# Disposable clones reuse guest host keys/IPs. Only use these options for these VMs.
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5
  -o ConnectionAttempts=1 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

need_tart() { command -v tart >/dev/null || { echo "tart not installed — run tools/vm/setup.sh" >&2; exit 1; }; }
vm_exists() { tart list --source local --quiet | grep -qx "$1"; }
vm_ip() { tart ip --wait 180 "$1"; }
vm_ssh() { local vm="$1"; shift; ssh "${SSH_OPTS[@]}" "admin@$(vm_ip "$vm")" "$@"; }

# No host directory is shared: the guest receives only the packaged app via scp.
vm_start() {
  local vm="$1"; shift
  nohup tart run "$vm" "$@" >"/tmp/$vm.log" 2>&1 </dev/null &
  VM_PID=$!
  echo "booting $vm (log: /tmp/$vm.log)…"
}

vm_boot() {
  local vm="$1" ip
  vm_start "$vm"
  ip=$(vm_ip "$vm")
  for _ in $(seq 30); do
    if ssh "${SSH_OPTS[@]}" "admin@$ip" true 2>/dev/null; then return 0; fi
    if ! kill -0 "$VM_PID" 2>/dev/null; then cat "/tmp/$vm.log" >&2; return 1; fi
    sleep 2
  done
  echo "Cannot log in to $vm using $KEY. Re-run tools/vm/setup.sh to repair stc-base, then create a fresh clone. Old clones keep their old SSH setup." >&2
  return 1
}

# Used only for VMs started by this shell. Do not freeze a golden image mid-write.
vm_shutdown() {
  local vm="$1"
  vm_ssh "$vm" 'sync; sudo -n shutdown -h now' || true
  for _ in $(seq 60); do
    if ! kill -0 "$VM_PID" 2>/dev/null; then wait "$VM_PID"; return; fi
    sleep 1
  done
  echo "$vm did not shut down cleanly; it is NOT ready to clone. See /tmp/$vm.log." >&2
  return 1
}

vm_install_app() (
  local vm="$1" tmp
  [ -d "$APP" ] || { echo "no $APP — run: npm run app:package" >&2; exit 1; }
  codesign --verify --deep --strict "$APP"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  ditto -c -k --keepParent "$APP" "$tmp/Capture.zip"
  scp "${SSH_OPTS[@]}" "$tmp/Capture.zip" "admin@$(vm_ip "$vm"):/tmp/Capture.zip"
  vm_ssh "$vm" 'set -e; rm -rf /Applications/Capture.app; ditto -x -k /tmp/Capture.zip /Applications; codesign --verify --deep --strict /Applications/Capture.app; rm /tmp/Capture.zip'
  echo "installed and verified Capture.app in $vm"
)

vm_launch_app() {
  vm_ssh "$1" 'bash -s' <"$REPO/tools/vm/launch-guest.sh"
}
