import { afterEach, describe, expect, it } from 'vitest';
import { getCommandResultInput, runCommandInput } from '#lib/schemas/mcp/tools.ts';
import { runViewSchema } from '#lib/schemas/commands/commands.ts';
import {
	agentAttaches,
	agentFinishes,
	agentPrints,
	asAsked,
	connect,
	disconnectAgents,
	setUpAssistantRuns,
	unwrapped,
	wrapperReport
} from '#tests/helpers/assistant-runs.ts';
import { listAuditOfKinds } from '../audit/audit.ts';
import { getCommandResultTool, resultText, runCommandTool } from '../mcp/command-tools.ts';
import { approvalViewFor } from './approval-views.ts';
import { approveRun } from './assistant-runs.ts';
import { startRun } from './commands.ts';
import { runOutputFor, runViewFor } from './run-views.ts';

/**
 * Honest results (SPEC-COMMANDS C25–C29, SPEC-MCP M48): a PowerShell machine runs its command
 * inside the observe-only wrapper and reports how many errors it wrote; people and assistants
 * see that, and only ever the command as written.
 */

afterEach(disconnectAgents);

/** Awkward on purpose: quotes, $(…), backticks, a here-string and non-ASCII. */
const COMMAND = [
	'Get-CimInstance -ClassName Win32_Nope "it\'s" `"quoted`"',
	'$size = $(Get-Item C:\\).Length',
	"$note = @'\nGröße 東京 “typographic”\n'@",
	'Write-Output $note'
].join('\n');

/** Pat's assistant asks to run COMMAND on office (Windows), and Pat approves it as asked. */
async function onOffice() {
	const setUp = await setUpAssistantRuns();
	const { relay, machine, assistantOf, tools, consoleAs } = setUp;
	const tickets = connect(machine.office);
	const pat = await assistantOf('pat');
	const asked = await runCommandTool(
		tools(pat),
		runCommandInput.parse({
			machines: ['office'],
			shell: 'powershell',
			command: COMMAND,
			reason: 'Check the disk'
		})
	);
	const runId = asked.kind === 'ok' ? asked.output.runId : '';
	const card = approvalViewFor(consoleAs('pat'), runId);
	await approveRun(consoleAs('pat'), runId, asAsked(COMMAND, 60_000, 1));
	const [ticket] = tickets;
	if (ticket === undefined) throw new Error('office was sent no ticket');
	const peer = agentAttaches(relay, ticket);
	return {
		...setUp,
		pat,
		runId,
		card,
		ticket,
		print: (stream: 'stdout' | 'stderr', text: string) => {
			agentPrints(relay, ticket, peer, stream, text);
		},
		finish: (exitCode: number) => {
			agentFinishes(relay, ticket, peer, exitCode);
		}
	};
}

const read = (runId: string) => getCommandResultInput.parse({ runId, waitSeconds: 0 });

describe('the wrapper on a Windows machine (SPEC-COMMANDS C25, C26)', () => {
	it('C25: the ticket names the wrapper, which carries the command byte for byte', async () => {
		const { ticket } = await onOffice();
		expect(ticket.purpose.shell).toBe('powershell');
		expect(ticket.purpose.command).not.toContain('Win32_Nope');
		expect(ticket.purpose.command).toContain('BMUSTER-PS-1');
		expect(unwrapped(ticket)).toBe(COMMAND);
	});

	it('C26: errors reported are kept, and the report never reaches the output', async () => {
		const { database, runner, people, machine, clock, runId, ticket, print, finish } =
			await onOffice();
		print('stdout', 'Größe\r\n');
		print('stderr', 'Get-CimInstance : Invalid class "Win32_Nope"\r\n');
		print('stderr', wrapperReport(ticket, 3).slice(0, 20));
		const live = runOutputFor(database, people.pat, runId, machine.office, runner, clock.now);
		expect(live).toMatchObject({ kind: 'live' });
		expect(live?.kind === 'live' && live.stderr).not.toContain('BMUSTER');
		print('stderr', wrapperReport(ticket, 3).slice(20));
		finish(0);
		expect(runOutputFor(database, people.pat, runId, machine.office, runner, clock.now)).toEqual({
			kind: 'kept',
			stdout: 'Größe\r\n',
			stderr: 'Get-CimInstance : Invalid class "Win32_Nope"\r\n',
			stdoutTruncated: false,
			stderrTruncated: false
		});
		const row = runViewFor(database, people.pat, runId, runner)?.machines[0];
		expect(row).toMatchObject({
			status: 'succeeded',
			exitCode: 0,
			errorsReported: 3,
			wroteToStderr: true
		});
		expect(runViewSchema.parse(runViewFor(database, people.pat, runId, runner))).toBeDefined();
	});

	it('C26: a marker the command prints itself stays as output and is not trusted', async () => {
		const { database, runner, people, machine, clock, runId, ticket, print, finish } =
			await onOffice();
		const fake = wrapperReport(ticket, 0);
		print('stderr', `oops\r\n${fake}`);
		print('stderr', 'more after it\r\n');
		finish(0);
		expect(
			runOutputFor(database, people.pat, runId, machine.office, runner, clock.now)
		).toMatchObject({ stderr: `oops\r\n${fake}more after it\r\n` });
		expect(runViewFor(database, people.pat, runId, runner)?.machines[0]).toMatchObject({
			status: 'succeeded',
			errorsReported: null
		});
	});
});

describe('the original command everywhere (SPEC-COMMANDS C28)', () => {
	it('C28: approval card, results and audit show the command as written; the audit names the wrapper', async () => {
		const { database, runner, people, runId, card, ticket, print, finish } = await onOffice();
		print('stderr', wrapperReport(ticket, 2));
		finish(0);
		expect(card?.command).toBe(COMMAND);
		expect(runViewFor(database, people.pat, runId, runner)?.scripts).toEqual([
			{ osFamily: 'windows', shell: 'powershell', command: COMMAND }
		]);
		const records = listAuditOfKinds(database, {
			kinds: ['command-run-requested', 'command-run-started', 'command-run-machine'],
			sinceMs: 0,
			limit: 10
		});
		const all = JSON.stringify(records);
		expect(all).not.toContain('BMUSTER');
		expect(all).not.toContain('FromBase64String');
		const started = records.find((record) => record.kind === 'command-run-started');
		expect(started?.detail).toMatchObject({ 'Windows command': COMMAND });
		const result = records.find((record) => record.kind === 'command-run-machine');
		expect(result?.detail).toMatchObject({
			result: 'Succeeded',
			'exit code': '0',
			'errors reported': '2',
			wrapper: 'ps-1'
		});
	});
});

describe('sh, bash and cmd as written (SPEC-COMMANDS C29)', () => {
	it('C29: a bash command runs as written; stderr is recorded as information only', async () => {
		const { database, relay, machine, people, runner, consoleAs } = await setUpAssistantRuns();
		const tickets = connect(machine.mint);
		const command = 'apt-get update; false | true';
		const started = await startRun(consoleAs('pat'), {
			machineIds: [machine.mint],
			scripts: [{ osFamily: 'linux', shell: 'bash', command }],
			timeoutMs: 60_000,
			confirmCount: 1,
			recheck: { kind: 'none' },
			rerunOf: null
		});
		const runId = started.kind === 'started' ? started.runId : '';
		const [ticket] = tickets;
		if (ticket === undefined) throw new Error('mint was sent no ticket');
		expect(ticket.purpose.command).toBe(command);
		const peer = agentAttaches(relay, ticket);
		agentPrints(relay, ticket, peer, 'stderr', 'W: slow mirror\n');
		agentFinishes(relay, ticket, peer, 0);
		expect(runViewFor(database, people.pat, runId, runner)?.machines[0]).toMatchObject({
			status: 'succeeded',
			errorsReported: null,
			wroteToStderr: true
		});
		const records = listAuditOfKinds(database, {
			kinds: ['command-run-machine'],
			sinceMs: 0,
			limit: 5
		});
		expect(records[0]?.detail).not.toHaveProperty('wrapper');
		expect(records[0]?.detail).toMatchObject({ 'wrote to stderr': 'yes' });
	});
});

describe('errors reported to assistants (SPEC-MCP M48)', () => {
	it('M48: get_command_result gives errorsReported and wroteToStderr, and the text says so', async () => {
		const { tools, pat, runId, ticket, print, finish } = await onOffice();
		print('stderr', `Invalid class\r\n${wrapperReport(ticket, 4)}`);
		finish(0);
		const result = await getCommandResultTool(tools(pat), read(runId));
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.output.machines[0]).toMatchObject({
			status: 'succeeded',
			exitCode: 0,
			errorsReported: 4,
			wroteToStderr: true
		});
		expect(result.output.output?.stderr.text).toBe('Invalid class\r\n');
		expect(resultText(result.output)).toContain('- office: Finished with errors (4), exit 0');
	});

	it('M48: a machine that has not finished has neither yet', async () => {
		const { tools, pat, runId } = await onOffice();
		const result = await getCommandResultTool(tools(pat), read(runId));
		expect(result.kind === 'ok' && result.output.machines[0]).toMatchObject({
			status: 'running',
			errorsReported: null,
			wroteToStderr: null
		});
	});
});
