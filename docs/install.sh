#!/bin/sh
# BMuster server installer for Linux (docs/specs/SPEC-SERVER-INSTALL.md).
#
#   curl -fsSL https://bmuster.com/install.sh | sudo sh
#   curl -fsSL https://bmuster.com/install.sh | sudo sh -s -- --port 443
#
# Downloads the newest release for this machine from GitHub with its signed
# manifest, checks the manifest's Ed25519 signature against the BMuster
# release key printed below (OpenSSL 3), then the archive's size and SHA-256
# against the manifest, and runs `bmuster-server install`, which puts it in
# /opt/bmuster-server/releases/<version> (with /opt/bmuster-server/current
# pointing at it), keeps its data in /var/lib/bmuster-server and starts the
# bmuster-server service. From then on the server updates itself (Update now
# on the console's Updates page). Running this again upgrades in place and
# keeps the data. Then it waits for the server and prints the address and the
# first-run setup code. Nothing unsigned is ever installed.
#
# This installs the BMuster *server*. Agents are installed from the server's
# own Add machine page.
set -eu

REPO="jackbrumley/bmuster"
DEFAULT_PREFIX="/opt/bmuster-server"
DEFAULT_DATA_DIR="/var/lib/bmuster-server"
# The BMuster release public key (agent/crates/agent/release-key.pub, as
# SubjectPublicKeyInfo). Its private half stays offline; it signs every
# release manifest, and the server updater and agents trust the same key.
RELEASE_KEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA4fsv0lh4Z/b/FM4RTf65gzD2la6wUJyfYcWto3RIXjs=
-----END PUBLIC KEY-----"
SIGNING_DOMAIN="BMUSTER-SERVER-UPDATE-1"

usage() {
	cat <<'EOF'
BMuster server installer

Usage: install.sh [options]

Options:
  --version <tag>    Install this release (for example v0.4.0) instead of the newest
  --port <port>      Port for a new install (default 8443); an upgrade keeps its port
  --prefix <dir>     Program folder (default /opt/bmuster-server)
  --data-dir <dir>   Data folder (default /var/lib/bmuster-server)
  --no-service       Install the files and settings only: no service, no system user,
                     no root needed (for testing, or to run it yourself)
  --archive <file>   Install this release archive (bmuster-app-<target>.tar.gz) instead of
                     downloading one; its signed manifest (bmuster-app-<target>.json)
                     must be beside it
  -h, --help         Show this help
EOF
}

say() {
	printf 'bmuster: %s\n' "$*"
}

fail() {
	printf 'bmuster: error: %s\n' "$*" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || fail "this installer needs $1; install it and try again"
}

version=""
port=""
prefix=""
data_dir=""
no_service=false
archive=""

while [ $# -gt 0 ]; do
	case "$1" in
	--version | --port | --prefix | --data-dir | --archive)
		[ $# -ge 2 ] || fail "$1 needs a value"
		case "$1" in
		--version) version="$2" ;;
		--port) port="$2" ;;
		--prefix) prefix="$2" ;;
		--data-dir) data_dir="$2" ;;
		--archive) archive="$2" ;;
		esac
		shift 2
		;;
	--no-service)
		no_service=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) fail "unknown option $1 (see --help)" ;;
	esac
done

[ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux; on Windows use install.ps1"

case "$(uname -m)" in
x86_64 | amd64) target="x86_64-unknown-linux-gnu" ;;
aarch64 | arm64) target="aarch64-unknown-linux-gnu" ;;
armv7l | armv6l) fail "BMuster needs a 64-bit system; on a Raspberry Pi, install the 64-bit Raspberry Pi OS" ;;
*) fail "there is no BMuster server for $(uname -m) yet" ;;
esac

if [ "$no_service" = false ] && [ "$(id -u)" -ne 0 ]; then
	fail "run this as root, for example: curl -fsSL https://bmuster.com/install.sh | sudo sh"
fi
if [ "$no_service" = false ] && [ ! -d /run/systemd/system ]; then
	fail "systemd is not running on this machine; BMuster runs as a systemd service (or use --no-service)"
fi

need tar
need sha256sum
need mktemp
need curl
need openssl
case "$(openssl version 2>/dev/null)" in
"OpenSSL "[3-9].*) ;;
*) fail "this installer needs OpenSSL 3 or later to check the release signature (found: $(openssl version 2>/dev/null || echo none))" ;;
esac

asset="bmuster-app-${target}.tar.gz"
manifest="bmuster-app-${target}.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

# Checks $work/$manifest's signature with the release key, then reads the
# signed payload: the release's version and the archive's size and SHA-256.
# Only a payload whose signature checks out is ever read.
verify_manifest() {
	[ "$(wc -c <"$work/$manifest")" -le 32768 ] || fail "$manifest is too large to be a release manifest"
	envelope="$(cat "$work/$manifest")"
	payload_b64="$(printf '%s' "$envelope" | sed -n 's/^{"payload":"\([A-Za-z0-9+/=]*\)","signature":"[A-Za-z0-9+/=]*"}$/\1/p')"
	signature_b64="$(printf '%s' "$envelope" | sed -n 's/^{"payload":"[A-Za-z0-9+/=]*","signature":"\([A-Za-z0-9+/=]*\)"}$/\1/p')"
	[ -n "$payload_b64" ] && [ -n "$signature_b64" ] || fail "$manifest is not a signed release manifest"
	printf '%s' "$payload_b64" | openssl base64 -d -A >"$work/payload.json" || fail "$manifest has a damaged payload"
	printf '%s' "$signature_b64" | openssl base64 -d -A >"$work/signature" || fail "$manifest has a damaged signature"
	printf '%s\n' "$SIGNING_DOMAIN" >"$work/signed"
	cat "$work/payload.json" >>"$work/signed"
	printf '%s\n' "$RELEASE_KEY_PEM" >"$work/release-key.pem"
	openssl pkeyutl -verify -pubin -inkey "$work/release-key.pem" -rawin \
		-in "$work/signed" -sigfile "$work/signature" >/dev/null 2>&1 ||
		fail "$manifest is not signed by the BMuster release key; nothing was installed"
	payload="$(cat "$work/payload.json")"
	signed_version="$(printf '%s' "$payload" | sed -n 's/.*"version":"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p')"
	signed_target="$(printf '%s' "$payload" | sed -n 's/.*"target":"\([a-z0-9_-]*\)".*/\1/p')"
	signed_archive="$(printf '%s' "$payload" | sed -n 's/.*"archive":"\([A-Za-z0-9._-]*\)".*/\1/p')"
	signed_bytes="$(printf '%s' "$payload" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')"
	signed_sha256="$(printf '%s' "$payload" | sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p')"
	[ -n "$signed_version" ] && [ -n "$signed_bytes" ] && [ -n "$signed_sha256" ] ||
		fail "$manifest's signed payload is not understood"
	[ "$signed_target" = "$target" ] || fail "$manifest is for $signed_target, not this machine ($target)"
	[ "$signed_archive" = "$asset" ] || fail "$manifest names $signed_archive, not $asset"
	say "Signature verified: BMuster $signed_version for $target."
}

# Checks $work/$asset against the signed size and SHA-256.
verify_archive() {
	actual_bytes="$(wc -c <"$work/$asset" | tr -d ' ')"
	[ "$actual_bytes" = "$signed_bytes" ] || fail "$asset is $actual_bytes bytes, but the signed size is $signed_bytes"
	actual="$(sha256sum "$work/$asset" | awk '{ print $1 }')"
	[ "$actual" = "$signed_sha256" ] || fail "$asset does not match its signed SHA-256 (expected $signed_sha256, got $actual)"
	say "Archive verified."
}

if [ -n "$archive" ]; then
	[ -f "$archive" ] || fail "$archive does not exist"
	beside="$(dirname "$archive")/$manifest"
	[ -f "$beside" ] || fail "there is no signed manifest $manifest beside $archive, so it was not installed"
	cp "$beside" "$work/$manifest"
	verify_manifest
	cp "$archive" "$work/$asset"
else
	# Asset names carry no version, so the newest release needs no GitHub API call.
	if [ -n "$version" ]; then
		base="https://github.com/${REPO}/releases/download/${version}"
	else
		base="https://github.com/${REPO}/releases/latest/download"
	fi
	say "Downloading ${base}/${manifest}"
	curl -fsSL --retry 3 --connect-timeout 15 --max-filesize 32768 -o "$work/$manifest" "${base}/${manifest}" ||
		fail "could not download $manifest (is there a release${version:+ $version} for $target?)"
	verify_manifest
	if [ -n "$version" ] && [ "v$signed_version" != "$version" ]; then
		fail "the signed manifest is for $signed_version, not $version"
	fi
	say "Downloading ${base}/${asset}"
	curl -fsSL --retry 3 --connect-timeout 15 --max-filesize "$signed_bytes" -o "$work/$asset" "${base}/${asset}" ||
		fail "could not download $asset"
fi
verify_archive

mkdir "$work/bundle"
tar -xzf "$work/$asset" -C "$work/bundle" || fail "could not unpack $asset"
launcher="$work/bundle/bmuster-server"
[ -x "$launcher" ] || fail "$asset has no bmuster-server launcher"

set -- install
[ -n "$prefix" ] && set -- "$@" --prefix "$prefix"
[ -n "$data_dir" ] && set -- "$@" --data-dir "$data_dir"
[ -n "$port" ] && set -- "$@" --port "$port"
[ "$no_service" = true ] && set -- "$@" --no-service
started="$(date +%s)"
"$launcher" "$@"

if [ "$no_service" = true ]; then
	exit 0
fi

prefix="${prefix:-$DEFAULT_PREFIX}"
data_dir="${data_dir:-$DEFAULT_DATA_DIR}"
listen_port="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' "$data_dir/server.env" | tail -n 1)"
listen_port="${listen_port:-3000}"

# Waits for GET /readyz on this machine. The server may use its own
# certificate (local network mode), which nothing can vouch for yet, so this
# one local probe skips the certificate check (-k); it sends nothing secret.
say "Waiting for the server to start..."
ready=false
tries=0
while [ $tries -lt 90 ]; do
	if curl -fsk --max-time 2 "https://127.0.0.1:${listen_port}/readyz" >/dev/null 2>&1 ||
		curl -fs --max-time 2 "http://127.0.0.1:${listen_port}/readyz" >/dev/null 2>&1; then
		ready=true
		break
	fi
	tries=$((tries + 1))
	sleep 1
done
if [ "$ready" = false ]; then
	fail "the server did not become ready on port ${listen_port}; see: journalctl -u bmuster-server -e"
fi

address="$("$prefix/current/bmuster-server" status --prefix "$prefix" --data-dir "$data_dir" | sed -n 's/^Address:[[:space:]]*//p')"
code="$(journalctl -u bmuster-server --since "@${started}" -o cat --no-pager 2>/dev/null |
	sed -n 's/.*first-run setup code: \([A-Z0-9-]*\).*/\1/p' | tail -n 1)"

echo
echo "BMuster Server is running."
echo
echo "  Open:        ${address}"
if [ -n "$code" ]; then
	echo "  Setup code:  ${code}   (asked for once, on the setup page)"
else
	echo "  No setup code was printed, so this server is already set up: sign in."
	echo "  To look for one: journalctl -u bmuster-server | grep 'setup code' | tail -n 1"
fi
echo
case "$address" in
https://*)
	echo "  The browser warns the first time: the server uses its own certificate"
	echo "  (local network mode). That is expected on your own network; after setup,"
	echo "  Add machine shows the certificate's fingerprint to compare."
	;;
esac
echo "  If a firewall runs on this machine, allow TCP port ${listen_port}."
echo "  Updates:     automatic and signed; the console's Updates page has Update now."
echo "  Status:      sudo ${prefix}/current/bmuster-server status"
echo "  Log:         journalctl -u bmuster-server -f"
echo "  Uninstall:   sudo ${prefix}/current/bmuster-server uninstall  (add --purge to delete the data)"
