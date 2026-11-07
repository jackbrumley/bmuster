import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { linuxInstallScript, windowsInstallScript } from './install-scripts.ts';

describe('install scripts (A3)', () => {
	it('download from this server, check the SHA-256 and run the agent installer', () => {
		const linux = linuxInstallScript('https://bmuster.example.org');
		expect(linux).toContain("URL='https://bmuster.example.org'");
		expect(linux).toContain('/agent/v1/releases/latest?target=$TARGET');
		expect(linux).toContain('sha256sum -c');
		expect(linux).toContain('install --url "$URL" --code "$CODE"');

		const windows = windowsInstallScript('https://bmuster.example.org');
		expect(windows).toContain("[string]$Url = 'https://bmuster.example.org'");
		expect(windows).toContain('Get-FileHash');
		expect(windows).toContain("@('install', '--url', $Url, '--code', $Code)");
	});

	it('refuses an origin that could break out of the script', () => {
		expect(() => linuxInstallScript("https://x.org'; rm -rf /; '")).toThrow();
		expect(() => windowsInstallScript('https://x.org$(evil)')).toThrow();
	});

	it('L6: the Linux script downloads with the pin when given --pin-cert, and passes it on', () => {
		const linux = linuxInstallScript('https://192.168.1.20:3000');
		expect(linux).toContain('--pin-cert) PIN="$2"');
		expect(linux).toContain("grep -Eq '^sha256:[A-Za-z0-9+/]{43}=$'");
		expect(linux).toContain('curl -fsSL --pinnedpubkey "sha256//${PIN#sha256:}" -k "$@"');
		expect(linux).toContain('MANIFEST=$(fetch "$URL/agent/v1/releases/latest?target=$TARGET")');
		expect(linux).toContain('fetch "$BIN_URL" -o "$TMP/bmuster-agent"');
		expect(linux).toContain('set -- "$@" --pin-cert "$PIN"');
		expect(linux).not.toMatch(/^curl /m);
		// The script is valid POSIX shell.
		expect(() => execFileSync('sh', ['-n'], { input: linux })).not.toThrow();
	});

	it('L6: the Windows script checks the certificate key hash for its own downloads only', () => {
		const windows = windowsInstallScript('https://192.168.1.20:3000');
		expect(windows).toContain("[string]$PinCert = ''");
		expect(windows).toContain('[Net.ServicePointManager]::ServerCertificateValidationCallback = {');
		expect(windows).toContain('[Security.Cryptography.SHA256]::Create().ComputeHash($spki)');
		expect(windows).toContain("('sha256:' + [Convert]::ToBase64String($hash)) -ceq $expectedPin");
		// Restored when the script ends, so the rest of the session is unaffected.
		expect(windows).toContain(
			'[Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCheck'
		);
		expect(windows).toContain("$arguments += @('--pin-cert', $PinCert)");
		// Plain ASCII, so it reads the same in every Windows code page.
		expect(windows).toMatch(/^[ -~\t\n\r]*$/);
	});
});
