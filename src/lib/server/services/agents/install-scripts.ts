/**
 * The one-line installers (SPEC-ENROLMENT 4 and 6.2). Each downloads the agent
 * from this server, checks its SHA-256 and runs `bmuster-agent install`.
 */

/** The server's origin goes into a shell script, so it must be plain. */
function checkedOrigin(origin: string): string {
	if (!/^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(origin)) {
		throw new Error(`Refusing to put an unusual origin into an install script: ${origin}`);
	}
	return origin;
}

export function linuxInstallScript(origin: string): string {
	return `#!/bin/sh
# BMuster agent installer for Linux (systemd).
# Usage: curl -fsSL ${checkedOrigin(origin)}/install.sh | sudo sh -s -- --code XXX-XXX-XXX [--name NAME]
set -eu

URL='${checkedOrigin(origin)}'
CODE=''
NAME=''
while [ $# -gt 0 ]; do
	case "$1" in
		--code) CODE="$2"; shift 2 ;;
		--name) NAME="$2"; shift 2 ;;
		--url) URL="$2"; shift 2 ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

fail() { echo "BMuster: $1" >&2; exit 1; }
[ -n "$CODE" ] || fail "missing --code (make one under Add machine in the console)"
[ "$(id -u)" -eq 0 ] || fail "run as root, e.g. with sudo"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

case "$(uname -m)" in
	x86_64 | amd64) TARGET=x86_64-unknown-linux-gnu ;;
	aarch64 | arm64) TARGET=aarch64-unknown-linux-gnu ;;
	*) fail "unsupported processor: $(uname -m)" ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

MANIFEST=$(curl -fsSL "$URL/agent/v1/releases/latest?target=$TARGET") || fail "this server has no agent build for $TARGET"
SHA=$(printf '%s' "$MANIFEST" | sed -n 's/.*"sha256":"\\([0-9a-f]\\{64\\}\\)".*/\\1/p')
BIN_URL=$(printf '%s' "$MANIFEST" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')
VERSION=$(printf '%s' "$MANIFEST" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
[ -n "$SHA" ] && [ -n "$BIN_URL" ] || fail "the release manifest is not readable"

echo "BMuster: downloading agent $VERSION for $TARGET"
curl -fsSL "$BIN_URL" -o "$TMP/bmuster-agent" || fail "download failed"
echo "$SHA  $TMP/bmuster-agent" | sha256sum -c - >/dev/null 2>&1 || fail "the download does not match its SHA-256; not installing"
chmod 0755 "$TMP/bmuster-agent"

if [ -n "$NAME" ]; then
	"$TMP/bmuster-agent" install --url "$URL" --code "$CODE" --name "$NAME"
else
	"$TMP/bmuster-agent" install --url "$URL" --code "$CODE"
fi
`;
}

export function windowsInstallScript(origin: string): string {
	return `# BMuster agent installer for Windows. Run in PowerShell as Administrator:
# & ([scriptblock]::Create((irm ${checkedOrigin(origin)}/install.ps1))) -Code XXX-XXX-XXX [-Name NAME]
param(
	[Parameter(Mandatory = $true)][string]$Code,
	[string]$Name = '',
	[string]$Url = '${checkedOrigin(origin)}'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw 'BMuster: run PowerShell as Administrator.'
}

$target = 'x86_64-pc-windows-msvc'
$manifest = Invoke-RestMethod "$Url/agent/v1/releases/latest?target=$target"
$download = Join-Path $env:TEMP ("bmuster-agent-" + [guid]::NewGuid() + ".exe")
Write-Host "BMuster: downloading agent $($manifest.version) for $target"
Invoke-WebRequest $manifest.url -OutFile $download -UseBasicParsing
try {
	$hash = (Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($hash -ne $manifest.sha256) { throw 'BMuster: the download does not match its SHA-256; not installing.' }
	$arguments = @('install', '--url', $Url, '--code', $Code)
	if ($Name -ne '') { $arguments += @('--name', $Name) }
	& $download @arguments
	if ($LASTEXITCODE -ne 0) { throw "BMuster: install failed (exit $LASTEXITCODE)." }
} finally {
	Remove-Item $download -Force -ErrorAction SilentlyContinue
}
`;
}
