#!/bin/sh
# Usage: curl -fsSL @TUMPEL_ORIGIN@/v1/releases/install.sh | sh
set -eu

origin="@TUMPEL_ORIGIN@"
dir="${TUMPEL_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  printf 'tumpel install failed: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "tumpel runs on Linux, and this machine runs $(uname -s). Run this command on a Linux machine."

case "$(uname -m)" in
  x86_64 | amd64) architecture=Amd64 ;;
  aarch64 | arm64) architecture=Arm64 ;;
  *) fail "tumpel has no build for $(uname -m) processors. Run this command on an x86_64 Linux machine." ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is not installed. Install curl, then run this command again."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is not installed. Install coreutils, then run this command again."

release=$(curl -fsSL "$origin/v1/releases/current") ||
  fail "could not read the current release from $origin. Check your network connection, then run this command again."

expected=$(printf '%s' "$release" | tr -d ' \t\r\n' | sed -n 's/.*"clis":\[\([^]]*\)\].*/\1/p' | tr '}' '\n' |
  grep "\"architecture\":\"$architecture\"" | sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p')
[ -n "$expected" ] || fail "the current release has no tumpel CLI for $(uname -m) machines. Run this command on an x86_64 Linux machine."

mkdir -p "$dir" || fail "could not create $dir. Set TUMPEL_INSTALL_DIR to a folder you can write to, then run this command again."
download="$dir/.tumpel-download.$$"
trap 'rm -f "$download"' EXIT

curl -fsSL "$origin/v1/releases/cli/$architecture" -o "$download" ||
  fail "could not download the tumpel CLI from $origin. Check your network connection, then run this command again."

actual=$(sha256sum "$download" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] ||
  fail "the downloaded CLI does not match the checksum the release publishes. Run this command again; if it fails again, report it at https://github.com/mvhenten/tumpel/issues/new."

chmod 755 "$download"
mv -f "$download" "$dir/tumpel"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) printf 'Add %s to your PATH to run tumpel by name.\n' "$dir" ;;
esac

printf 'Installed tumpel in %s. Sign in with:\n\n  tumpel login --endpoint %s\n' "$dir" "$origin"
