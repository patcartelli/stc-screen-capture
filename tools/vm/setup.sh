#!/bin/bash
# One-time: install Tart, pull macOS 26, make the stc-base golden VM.
source "$(dirname "$0")/common.sh"

install_tart_release() {
  # Fallback when the Homebrew tap's formula is broken. Tart must be run via the
  # binary inside tart.app (it carries a provisioning profile), so we put a tiny
  # exec wrapper on PATH rather than a symlink — same thing the formula does.
  local dir="$HOME/Applications"; mkdir -p "$dir"
  local tmp; tmp=$(mktemp -d)
  curl -fL -o "$tmp/tart.tar.gz" https://github.com/cirruslabs/tart/releases/latest/download/tart.tar.gz
  tar -xzf "$tmp/tart.tar.gz" -C "$tmp"
  rm -rf "$dir/tart.app" && mv "$tmp/tart.app" "$dir/tart.app"
  local bin="$(brew --prefix 2>/dev/null || echo /usr/local)/bin/tart"
  printf '#!/bin/sh\nexec "%s/tart.app/Contents/MacOS/tart" "$@"\n' "$dir" > "$bin"
  chmod +x "$bin"
  echo "installed $dir/tart.app  (wrapper: $bin)"
}
command -v tart >/dev/null || brew install cirruslabs/cli/tart || install_tart_release
command -v tart >/dev/null && tart --version

if ! vm_exists "$BASE"; then
  free_gb=$(df -g "$HOME" | awk 'NR==2{print $4}')
  if [ "$free_gb" -lt 70 ]; then
    echo "Only ${free_gb} GB free; free at least 70 GB before downloading the base image." >&2
    exit 1
  fi
  tart clone "$IMAGE" "$BASE"
  tart set "$BASE" --cpu 4 --memory 8192 --display 1280x800
  # The OCI cache is a second full copy of the image; the local VM is all we need.
  tart prune --entries=caches || true
fi

mkdir -p "$(dirname "$KEY")"
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -f "$KEY" -C stc-vm
# Recover a missing/stale public half without replacing the existing private key.
ssh-keygen -y -f "$KEY" > "$KEY.pub"

vm_start "$BASE" --no-graphics
ip=$(vm_ip "$BASE")
# A DHCP lease can exist before sshd is ready. Bound the wait, then allow a
# password ONLY for bootstrap; every normal VM command uses BatchMode=yes.
ready=false
for _ in $(seq 60); do
  if nc -z -G 2 "$ip" 22 2>/dev/null; then ready=true; break; fi
  if ! kill -0 "$VM_PID" 2>/dev/null; then cat "/tmp/$BASE.log" >&2; exit 1; fi
  sleep 2
done
$ready || { echo "SSH service never became ready in $BASE" >&2; exit 1; }
if ! ssh "${SSH_OPTS[@]}" "admin@$ip" true 2>/dev/null; then
  echo 'Installing the SSH key. The guest password is: admin'
  ssh-copy-id -i "$KEY.pub" -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "admin@$ip"
fi
# This must pass without a password before the base is declared ready.
vm_ssh "$BASE" 'set -e; sw_vers; sudo -n true; echo "key-only SSH and passwordless sudo: verified"; spctl --status || true'
vm_shutdown "$BASE"
echo "done. $BASE is ready. Existing clones must be recreated to inherit the repaired key."
echo "Next: npm run app:package, then tools/vm/fresh.sh"
