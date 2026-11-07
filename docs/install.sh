#!/bin/sh
# BMuster server installer for Linux (docs/specs/SPEC-SERVER-INSTALL.md).
#
#   curl -fsSL https://bmuster.com/install.sh | sudo sh
#   curl -fsSL https://bmuster.com/install.sh | sudo sh -s -- --port 443
#
# Downloads the newest release for this machine from GitHub, checks it
# against the release's SHA256SUMS, and runs `bmuster-server install`, which
# copies it to /opt/bmuster-server, keeps its data in /var/lib/bmuster-server
# and starts the bmuster-server service. Running it again upgrades in place
# and keeps the data. Then it waits for the server and prints the address and
# the first-run setup code.
#
# This installs the BMuster *server*. Agents are installed from the server's
# own Add machine page.
set -eu

REPO="jackbrumley/bmuster"
DEFAULT_PREFIX="/opt/bmuster-server"
DEFAULT_DATA_DIR="/var/lib/bmuster-server"

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
  --archive <file>   Install this release archive instead of downloading one; it is
                     checked against a SHA256SUMS file beside it when there is one
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
x86_64 | amd64) platform="linux-x64" ;;
aarch64 | arm64) platform="linux-arm64" ;;
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

asset="bmuster-server-${platform}.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

# Checks $work/$asset against a SHA256SUMS file ("<hash>  <name>" lines).
verify() {
	expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$1")"
	[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
	actual="$(sha256sum "$work/$asset" | awk '{ print $1 }')"
	[ "$expected" = "$actual" ] || fail "$asset does not match SHA256SUMS (expected $expected, got $actual)"
	say "Checksum verified."
}

if [ -n "$archive" ]; then
	[ -f "$archive" ] || fail "$archive does not exist"
	cp "$archive" "$work/$asset"
	sums="$(dirname "$archive")/SHA256SUMS"
	if [ -f "$sums" ]; then
		verify "$sums"
	else
		say "No SHA256SUMS beside $archive, so it was not checked."
	fi
else
	# Asset names carry no version, so the newest release needs no GitHub API call.
	if [ -n "$version" ]; then
		base="https://github.com/${REPO}/releases/download/${version}"
	else
		base="https://github.com/${REPO}/releases/latest/download"
	fi
	say "Downloading ${base}/${asset}"
	curl -fsSL --retry 3 --connect-timeout 15 -o "$work/$asset" "${base}/${asset}" ||
		fail "could not download $asset (is there a release${version:+ $version} for $platform?)"
	curl -fsSL --retry 3 --connect-timeout 15 -o "$work/SHA256SUMS" "${base}/SHA256SUMS" ||
		fail "could not download SHA256SUMS for the release"
	verify "$work/SHA256SUMS"
fi

tar -xzf "$work/$asset" -C "$work" || fail "could not unpack $asset"
launcher="$work/bmuster-server/bmuster-server"
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

address="$("$prefix/bmuster-server" status --prefix "$prefix" --data-dir "$data_dir" | sed -n 's/^Address:[[:space:]]*//p')"
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
echo "  Status:      sudo ${prefix}/bmuster-server status"
echo "  Log:         journalctl -u bmuster-server -f"
echo "  Uninstall:   sudo ${prefix}/bmuster-server uninstall  (add --purge to delete the data)"
