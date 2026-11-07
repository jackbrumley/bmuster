/**
 * The one-line installers (SPEC-ENROLMENT 4 and 6.2). Each downloads the agent
 * from this server, checks its SHA-256 and runs `bmuster-agent install`. In
 * local network mode (SPEC-INSTALL-OPTIONS L5, L6) the command passes the
 * certificate pin: every download in the script then accepts only the
 * server's own key, and the agent is told to trust only that key.
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
# Usage: curl -fsSL ${checkedOrigin(origin)}/install.sh | sudo sh -s -- --code XXX-XXX-XXX [--name NAME] [--pin-cert sha256:...]
set -eu

URL='${checkedOrigin(origin)}'
CODE=''
NAME=''
PIN=''
while [ $# -gt 0 ]; do
	case "$1" in
		--code) CODE="$2"; shift 2 ;;
		--name) NAME="$2"; shift 2 ;;
		--url) URL="$2"; shift 2 ;;
		--pin-cert) PIN="$2"; shift 2 ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

fail() { echo "BMuster: $1" >&2; exit 1; }
[ -n "$CODE" ] || fail "missing --code (make one under Add machine in the console)"
if [ -n "$PIN" ]; then
	printf '%s' "$PIN" | grep -Eq '^sha256:[A-Za-z0-9+/]{43}=$' || fail "--pin-cert must look like sha256: and 44 base64 characters"
fi

# Local network mode: --pinnedpubkey accepts only the server's own key; -k
# only skips the certificate authority check a self-signed certificate
# cannot pass. Any other key is still refused.
fetch() {
	if [ -n "$PIN" ]; then
		curl -fsSL --pinnedpubkey "sha256//\${PIN#sha256:}" -k "$@"
	else
		curl -fsSL "$@"
	fi
}
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

MANIFEST=$(fetch "$URL/agent/v1/releases/latest?target=$TARGET") || fail "could not get the agent build for $TARGET from $URL (see the error above)"
SHA=$(printf '%s' "$MANIFEST" | sed -n 's/.*"sha256":"\\([0-9a-f]\\{64\\}\\)".*/\\1/p')
BIN_URL=$(printf '%s' "$MANIFEST" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')
VERSION=$(printf '%s' "$MANIFEST" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
[ -n "$SHA" ] && [ -n "$BIN_URL" ] || fail "the release manifest is not readable"

echo "BMuster: downloading agent $VERSION for $TARGET"
fetch "$BIN_URL" -o "$TMP/bmuster-agent" || fail "download failed"
echo "$SHA  $TMP/bmuster-agent" | sha256sum -c - >/dev/null 2>&1 || fail "the download does not match its SHA-256; not installing"
chmod 0755 "$TMP/bmuster-agent"

set -- install --url "$URL" --code "$CODE"
if [ -n "$NAME" ]; then
	set -- "$@" --name "$NAME"
fi
if [ -n "$PIN" ]; then
	set -- "$@" --pin-cert "$PIN"
fi
"$TMP/bmuster-agent" "$@"
`;
}

export function windowsInstallScript(origin: string): string {
	return `# BMuster agent installer for Windows. Run in PowerShell as Administrator:
# & ([scriptblock]::Create((irm ${checkedOrigin(origin)}/install.ps1))) -Code XXX-XXX-XXX [-Name NAME] [-PinCert sha256:...]
param(
	[Parameter(Mandatory = $true)][string]$Code,
	[string]$Name = '',
	[string]$Url = '${checkedOrigin(origin)}',
	[string]$PinCert = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw 'BMuster: run PowerShell as Administrator.'
}

# Local network mode: accept only a server certificate whose public key
# (SubjectPublicKeyInfo) has this SHA-256, for this script's downloads only.
$previousCheck = [Net.ServicePointManager]::ServerCertificateValidationCallback
if ($PinCert -ne '') {
	if ($PinCert -cnotmatch '^sha256:[A-Za-z0-9+/]{43}=$') {
		throw 'BMuster: -PinCert must look like sha256: and 44 base64 characters.'
	}
	if ($PSVersionTable.PSEdition -eq 'Core') {
		throw 'BMuster: in local network mode, run this in Windows PowerShell (powershell.exe), which can check the certificate pin.'
	}
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	$expectedPin = $PinCert
	[Net.ServicePointManager]::ServerCertificateValidationCallback = {
		param($requestSender, $certificate, $chain, $sslErrors)
		if ($null -eq $certificate) { return $false }
		$der = $certificate.GetRawCertData()
		# One DER header at $at: @(header size, content length).
		$header = {
			param([int]$at)
			$length = [int]$der[$at + 1]
			$size = 2
			if ($length -ge 0x80) {
				$count = $length -band 0x7F
				$length = 0
				for ($k = 0; $k -lt $count; $k++) { $length = $length * 256 + [int]$der[$at + 2 + $k] }
				$size = 2 + $count
			}
			, @($size, $length)
		}
		# Certificate, then TBSCertificate; skip the version, serial, signature,
		# issuer, validity and subject; what follows is subjectPublicKeyInfo.
		$at = (& $header 0)[0]
		$at = $at + (& $header $at)[0]
		if ($der[$at] -eq 0xA0) { $h = & $header $at; $at = $at + $h[0] + $h[1] }
		for ($n = 0; $n -lt 5; $n++) { $h = & $header $at; $at = $at + $h[0] + $h[1] }
		$h = & $header $at
		$spki = New-Object byte[] ($h[0] + $h[1])
		[Array]::Copy($der, $at, $spki, 0, $spki.Length)
		$hash = [Security.Cryptography.SHA256]::Create().ComputeHash($spki)
		('sha256:' + [Convert]::ToBase64String($hash)) -ceq $expectedPin
	}.GetNewClosure()
}

$target = 'x86_64-pc-windows-msvc'
$download = Join-Path $env:TEMP ("bmuster-agent-" + [guid]::NewGuid() + ".exe")
try {
	$manifest = Invoke-RestMethod "$Url/agent/v1/releases/latest?target=$target"
	Write-Host "BMuster: downloading agent $($manifest.version) for $target"
	Invoke-WebRequest $manifest.url -OutFile $download -UseBasicParsing
	$hash = (Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($hash -ne $manifest.sha256) { throw 'BMuster: the download does not match its SHA-256; not installing.' }
	$arguments = @('install', '--url', $Url, '--code', $Code)
	if ($Name -ne '') { $arguments += @('--name', $Name) }
	if ($PinCert -ne '') { $arguments += @('--pin-cert', $PinCert) }
	& $download @arguments
	if ($LASTEXITCODE -ne 0) { throw "BMuster: install failed (exit $LASTEXITCODE)." }
} finally {
	[Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCheck
	Remove-Item $download -Force -ErrorAction SilentlyContinue
}
`;
}
