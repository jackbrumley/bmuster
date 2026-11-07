import type { ServedPin } from '../settings/local-tls.ts';

/**
 * Agent builds the server offers (SPEC-ENROLMENT 6.1, 12), the one-line and
 * manual install commands (SPEC-INSTALL-OPTIONS M1–M4), and the certificate
 * pin they carry in local network mode (L5, L6). Browser-safe.
 */
export const AGENT_TARGETS = [
	'x86_64-unknown-linux-gnu',
	'aarch64-unknown-linux-gnu',
	'x86_64-pc-windows-msvc'
] as const;

export type AgentTarget = (typeof AGENT_TARGETS)[number];

export function isAgentTarget(value: string): value is AgentTarget {
	return AGENT_TARGETS.some((target) => target === value);
}

/** The newest build for one target, as Add machine offers it. */
export type AgentDownload =
	| { kind: 'none'; target: AgentTarget }
	| { kind: 'ready'; target: AgentTarget; version: string; size: number; sha256: string };

/** `sha256:<base64>` → the `sha256//<base64>` curl's `--pinnedpubkey` takes. */
function curlPin(pin: string): string {
	return `sha256//${pin.slice('sha256:'.length)}`;
}

/**
 * The one-line install command. In local network mode the download itself is
 * pinned: `--pinnedpubkey` makes curl accept only the server's own key, and
 * `-k` only switches off the certificate authority check that a self-signed
 * certificate can never pass. Without the pin, `-k` would accept anyone; with
 * it, curl still refuses any other key. Windows uses the curl.exe built into
 * Windows 10 and 11 for the same reason (PowerShell's own download cannot pin).
 */
export function oneLineInstallCommand(
	os: 'linux' | 'windows',
	origin: string,
	code: string,
	pin: ServedPin
): string {
	switch (os) {
		case 'linux':
			return pin.kind === 'pin'
				? `curl -fsSL --pinnedpubkey '${curlPin(pin.pin)}' -k ${origin}/install.sh | sudo sh -s -- --code ${code} --pin-cert ${pin.pin}`
				: `curl -fsSL ${origin}/install.sh | sudo sh -s -- --code ${code}`;
		case 'windows':
			return pin.kind === 'pin'
				? `& ([scriptblock]::Create((curl.exe -fsSL --pinnedpubkey '${curlPin(pin.pin)}' -k ${origin}/install.ps1) -join "\`n")) -Code ${code} -PinCert '${pin.pin}'`
				: `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Code ${code}`;
	}
}

/** The command to run beside a downloaded agent, with the server, join code and any pin filled in. */
export function manualInstallCommand(
	os: 'linux' | 'windows',
	origin: string,
	code: string,
	pin: ServedPin
): string {
	switch (os) {
		case 'linux':
			return `chmod +x bmuster-agent && sudo ./bmuster-agent install --url ${origin} --code ${code}${pin.kind === 'pin' ? ` --pin-cert ${pin.pin}` : ''}`;
		case 'windows':
			return `.\\bmuster-agent.exe install --url ${origin} --code ${code}${pin.kind === 'pin' ? ` --pin-cert '${pin.pin}'` : ''}`;
	}
}
