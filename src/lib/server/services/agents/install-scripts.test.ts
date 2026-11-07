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
});
