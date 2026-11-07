# BMuster server installer for Windows (docs/specs/SPEC-SERVER-INSTALL.md).
#
# In PowerShell as Administrator:
#   irm https://bmuster.com/install.ps1 | iex
# With options:
#   & ([scriptblock]::Create((irm https://bmuster.com/install.ps1))) -Port 443
#
# Downloads the newest release from GitHub, checks it against the release's
# SHA256SUMS, and runs `bmuster-server.exe install`, which copies it to
# C:\Program Files\BMuster Server, keeps its data in
# C:\ProgramData\BMuster Server and starts the "BMuster Server" service.
# Running it again upgrades in place and keeps the data. Then it waits for the
# server and prints the address and the first-run setup code.
#
# This installs the BMuster *server*. Agents are installed from the server's
# own Add machine page.
param(
	# Install this release (for example v0.4.0) instead of the newest.
	[string]$Version = '',
	# Port for a new install (default 8443); an upgrade keeps its port.
	[int]$Port = 0,
	# Program folder (default C:\Program Files\BMuster Server).
	[string]$Prefix = '',
	# Data folder (default C:\ProgramData\BMuster Server).
	[string]$DataDir = '',
	# Install the files and settings only: no service, no Administrator needed.
	[switch]$NoService,
	# Install this release archive instead of downloading one.
	[string]$Archive = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
# The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'jackbrumley/bmuster'
$Asset = 'bmuster-server-windows-x64.zip'

function Say([string]$Message) {
	Write-Host "bmuster: $Message"
}

# Throws rather than exits: under `irm | iex` an exit would close the window.
function Fail([string]$Message) {
	throw "bmuster: $Message"
}

function Test-Sha256([string]$File, [string]$SumsFile) {
	$expected = $null
	foreach ($line in Get-Content -LiteralPath $SumsFile) {
		$fields = $line.Trim() -split '\s+'
		if ($fields.Count -ge 2 -and $fields[1].TrimStart('*') -eq $Asset) {
			$expected = $fields[0].ToLowerInvariant()
		}
	}
	if ($null -eq $expected) { Fail "$Asset is not listed in SHA256SUMS" }
	$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
	if ($expected -ne $actual) { Fail "$Asset does not match SHA256SUMS (expected $expected, got $actual)" }
	Say 'Checksum verified.'
}

if ($env:OS -ne 'Windows_NT') { Fail 'this installer is for Windows; on Linux use install.sh' }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { Fail "there is no BMuster server for Windows on $arch yet" }

if (-not $NoService) {
	$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
	if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
		Fail 'run PowerShell as Administrator (right-click, Run as administrator) and try again'
	}
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
	Fail 'this installer needs curl.exe, which comes with Windows 10 (1803) and later'
}

if ($Prefix -eq '') { $Prefix = Join-Path $env:ProgramFiles 'BMuster Server' }
if ($DataDir -eq '') { $DataDir = Join-Path $env:ProgramData 'BMuster Server' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('bmuster-server-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
	$zip = Join-Path $work $Asset
	if ($Archive -ne '') {
		if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Fail "$Archive does not exist" }
		Copy-Item -LiteralPath $Archive -Destination $zip
		$sums = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Archive)) 'SHA256SUMS'
		if (Test-Path -LiteralPath $sums) { Test-Sha256 $zip $sums } else { Say "No SHA256SUMS beside $Archive, so it was not checked." }
	} else {
		# Asset names carry no version, so the newest release needs no GitHub API call.
		$base = if ($Version -ne '') { "https://github.com/$Repo/releases/download/$Version" } else { "https://github.com/$Repo/releases/latest/download" }
		Say "Downloading $base/$Asset"
		try {
			Invoke-WebRequest -UseBasicParsing -Uri "$base/$Asset" -OutFile $zip
			Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
		} catch {
			Fail "could not download the release ($($_.Exception.Message))"
		}
		Test-Sha256 $zip (Join-Path $work 'SHA256SUMS')
	}

	Expand-Archive -LiteralPath $zip -DestinationPath $work
	$launcher = Join-Path $work 'bmuster-server\bmuster-server.exe'
	if (-not (Test-Path -LiteralPath $launcher)) { Fail "$Asset has no bmuster-server.exe" }

	$arguments = @('install', '--prefix', $Prefix, '--data-dir', $DataDir)
	if ($Port -ne 0) { $arguments += @('--port', "$Port") }
	if ($NoService) { $arguments += '--no-service' }
	# Only what Node writes from now on counts when looking for a setup code.
	$log = Join-Path $DataDir 'server.log'
	$logStart = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { 0 }
	& $launcher @arguments
	if ($LASTEXITCODE -ne 0) { Fail "bmuster-server install failed (exit $LASTEXITCODE)" }
} finally {
	Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoService) { return }

$listenPort = 3000
foreach ($line in Get-Content -LiteralPath (Join-Path $DataDir 'server.env')) {
	if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $listenPort = [int]$Matches[1] }
}

# Waits for GET /readyz on this machine. The server may use its own
# certificate (local network mode), which nothing can vouch for yet, so this
# one local probe skips the certificate check (-k); it sends nothing secret.
Say 'Waiting for the server to start...'
$ready = $false
for ($try = 0; $try -lt 90 -and -not $ready; $try++) {
	& curl.exe -fsk --max-time 2 "https://127.0.0.1:$listenPort/readyz" 2>$null | Out-Null
	if ($LASTEXITCODE -ne 0) { & curl.exe -fs --max-time 2 "http://127.0.0.1:$listenPort/readyz" 2>$null | Out-Null }
	if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 }
}
if (-not $ready) { Fail "the server did not become ready on port $listenPort; see $log" }

$address = ''
foreach ($line in & (Join-Path $Prefix 'bmuster-server.exe') status --prefix $Prefix --data-dir $DataDir) {
	if ($line -match '^Address:\s*(.+)$') { $address = $Matches[1] }
}
$code = ''
if (Test-Path -LiteralPath $log) {
	$stream = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
	try {
		if ($stream.Length -ge $logStart) { [void]$stream.Seek($logStart, 'Begin') }
		$newText = (New-Object IO.StreamReader($stream)).ReadToEnd()
	} finally {
		$stream.Dispose()
	}
	foreach ($found in [regex]::Matches($newText, 'first-run setup code: ([A-Z0-9-]+)')) { $code = $found.Groups[1].Value }
}

Write-Host ''
Write-Host 'BMuster Server is running.'
Write-Host ''
Write-Host "  Open:        $address"
if ($code -ne '') {
	Write-Host "  Setup code:  $code   (asked for once, on the setup page)"
} else {
	Write-Host '  No setup code was printed, so this server is already set up: sign in.'
	Write-Host "  To look for one: Select-String 'setup code' '$log' | Select-Object -Last 1"
}
Write-Host ''
if ($address.StartsWith('https://')) {
	Write-Host '  The browser warns the first time: the server uses its own certificate'
	Write-Host '  (local network mode). That is expected on your own network; after setup,'
	Write-Host "  Add machine shows the certificate's fingerprint to compare."
}
Write-Host "  Windows Firewall now allows TCP port $listenPort."
Write-Host "  Status:      & '$Prefix\bmuster-server.exe' status"
Write-Host "  Log:         $log"
Write-Host "  Uninstall:   & '$Prefix\bmuster-server.exe' uninstall  (add --purge to delete the data)"
