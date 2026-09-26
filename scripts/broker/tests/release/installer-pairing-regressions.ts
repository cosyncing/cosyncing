/** Run the shipped pairing tail with fixture CLI replies, without installing any artifacts. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Check = (name: string, ok: boolean, detail?: string) => void;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function section(source: string, start: string, end?: string): string {
  const begin = source.indexOf(start);
  if (begin < 0) throw new Error('pairing fixture boundary is missing');
  if (end === undefined) return source.slice(begin);
  const finish = source.indexOf(end, begin);
  if (finish < 0) throw new Error('pairing fixture boundary is missing');
  return source.slice(begin, finish);
}

const LISTENER_URL = 'http://127.0.0.1:7735';
/** A pairing id the tail's own validator accepts: `pair_` plus 20-32 base64url characters. */
const PAIRING_ID = 'pair_fixturepairingid00000';
/** Stands in for the QR payload. It must never reach the log or the operator's status lines. */
const OFFER_QR = 'fixture-one-use-qr-payload';

/**
 * What either installer must write as the readiness step's detail for one document.
 *
 * Shared by both branches on purpose: an operator asks "what did the installer see" once and may be
 * reading a Windows log or a POSIX one, so the same document has to leave the same word behind.
 */
const readinessDetail = (readiness: unknown): string => {
  if (readiness === undefined) return 'unreadable';
  const document = readiness as { ok?: boolean; detailCodes?: string[] };
  const codes = (document.detailCodes ?? []).join(',');
  return codes !== '' ? codes : document.ok === true ? 'ready' : 'not-ready';
};

interface Fixture {
  readiness?: unknown;
  readinessExit?: number;
  pairFails?: boolean;
  pairError?: string;
  /**
   * What `pair --json` prints when it exits 0. Absent means the well-formed offer below; a string is
   * printed verbatim, which is how a reply that is not JSON at all is reproduced.
   */
  pairReply?: unknown;
  acceptance?: unknown;
  acceptanceExit?: number;
  /**
   * Make the installer's own staging file impossible to create, which is what an unwritable state home does.
   * The shell installer runs for real -- see `lockStateHomeForStaging` -- and the PowerShell stub of its
   * staging helper throws, so both branches get the failure the fixture claims to have set up.
   */
  stagingFails?: boolean;
}

const readinessReady = { schemaVersion: 1, product: 'cosyncing', ok: true,
  listener: { ready: true, url: LISTENER_URL, port: 7735 }, detailCodes: [] };
const readinessUnreachable = { schemaVersion: 1, product: 'cosyncing', ok: false,
  listener: { ready: false, url: LISTENER_URL, port: 7735 }, detailCodes: ['internal-endpoint-unreachable'] };
const readinessForeign = { schemaVersion: 1, product: 'cosyncing', ok: false,
  listener: { ready: false, url: LISTENER_URL, port: 7735 }, detailCodes: ['internal-endpoint-identity-mismatch'] };
// A cosyncing endpoint that answered without authenticating this installation's token: the health payload
// names the product and withholds the machine label. Not the foreign-service case above, and no more proof
// that the responder is THIS broker than the case above is proof that it is somebody else's.
const readinessUnauthenticated = { schemaVersion: 1, product: 'cosyncing', ok: false,
  listener: { ready: false, url: LISTENER_URL, port: 7735 }, detailCodes: ['internal-endpoint-unauthenticated'] };
const accepted = { schemaVersion: 1, ok: true, pairingId: PAIRING_ID,
  state: 'accepted', peerId: 'peer_fixture' };
const pending = { schemaVersion: 1, ok: true, pairingId: PAIRING_ID, state: 'pending' };
const unverifiable = { schemaVersion: 1, ok: false, pairingId: PAIRING_ID, state: 'unverifiable' };

interface Case {
  name: string;
  fixture: Fixture;
  /** Substring the tail must print for the handoff step that decided the run. */
  expect?: string;
  /**
   * Substring BOTH installers must put in the operator's skip line.
   *
   * Reserved for sentences an operator reads the same way on either host, which is the whole reason two
   * installers are run against one table of cases.
   */
  skipPhrase?: string;
  /** The operator-facing line, including the branch after the offer command. */
  publicPhrase?: string;
  /** Claims that must not be made in either installer's output. */
  forbidPublic?: string[];
  /** A lost offer response has no published file, but is deliberately reported as unverified. */
  unverifiedOffer?: boolean;
  /** Substrings the state-home log must contain, in order. */
  log?: string[];
  /** The one-use offer must be created exactly once, and only when the listener proved ready. */
  offers?: 0 | 1;
  paired?: boolean;
}

const cases: Case[] = [
  { name: 'client paired', fixture: { readiness: readinessReady, acceptance: accepted },
    expect: 'the broker accepted peer peer_fixture', paired: true, offers: 1,
    log: ['step=readiness exit=0', 'step=offer exit=0 detail=created', 'step=acceptance exit=0 detail=accepted'] },
  { name: 'client never came', fixture: { readiness: readinessReady, acceptance: pending },
    expect: 'not paired yet', paired: true, offers: 1,
    log: ['step=acceptance exit=0 detail=pending'] },
  { name: 'acceptance unverifiable', fixture: { readiness: readinessReady, acceptance: unverifiable },
    expect: 'could not be confirmed', paired: true, offers: 1,
    log: ['step=acceptance exit=1 detail=unverifiable'] },
  { name: 'readiness timed out', fixture: { readiness: readinessUnreachable, readinessExit: 1 },
    expect: 'did not report ready (detail: internal-endpoint-unreachable)', offers: 0,
    log: ['step=readiness exit=1 detail=internal-endpoint-unreachable'] },
  { name: 'foreign service answered', fixture: { readiness: readinessForeign, readinessExit: 1 },
    expect: 'answered as something other than this broker', offers: 0, log: undefined },
  // The same endpoint, the same product name, and a credential it will not take. A foreign service is the
  // wrong diagnosis, and so is "this is our own broker": a second installation reached over a WSL port
  // relay answers precisely this way, because the machine label is withheld from any caller the responder
  // will not authenticate. Both installers name the endpoint, and neither sends the operator to `setup`,
  // which rewrites this machine's token and nothing anybody else's.
  { name: 'endpoint refuses the local credential',
    fixture: { readiness: readinessUnauthenticated, readinessExit: 1 },
    expect: "did not accept this installation's credential",
    skipPhrase: "did not accept this installation's credential", offers: 0,
    log: ['step=readiness exit=1 detail=internal-endpoint-unauthenticated'] },
  // A 200 whose body this script cannot use. Each of these used to leave the log saying `detail=created`
  // (shell) or saying nothing at all (PowerShell) above an install with no handoff, and then the
  // confirmation step asked the broker about an offer that had never reached any client.
  { name: 'offer reply has no pairing id',
    fixture: { readiness: readinessReady, pairReply: { schemaVersion: 1 } },
    expect: 'could not be published (detail: offer-reply-invalid)', offers: 1,
    log: ['step=offer exit=1 detail=offer-reply-invalid'] },
  { name: 'offer reply is not JSON',
    fixture: { readiness: readinessReady, pairReply: 'gateway returned an empty body' },
    expect: 'could not be published (detail: offer-reply-unreadable)', offers: 1,
    log: ['step=offer exit=1 detail=offer-reply-unreadable'] },
  // The shape that used to be the worst of the three: the id passes on its own, so it was kept and asked
  // about, while nothing was ever written for the client to read.
  { name: 'offer reply has an id but no QR',
    fixture: { readiness: readinessReady, pairReply: { schemaVersion: 1, pairingId: PAIRING_ID } },
    expect: 'could not be published (detail: offer-reply-invalid)', offers: 1,
    log: ['step=offer exit=1 detail=offer-reply-invalid'] },
  { name: 'offer request lost its answer',
    fixture: { readiness: readinessReady, pairFails: true, acceptance: accepted,
      pairError: '[error] pairing-create-unverified: The broker did not answer the pairing-offer request.\n' },
    expect: 'No handoff file was written. An unused offer may exist; wait five minutes',
    publicPhrase: 'No handoff file was written. An unused offer may exist; wait five minutes',
    forbidPublic: ['the broker did not issue a pairing offer', 'Pair by hand with:'],
    unverifiedOffer: true,
    offers: 1,
    log: ['step=offer exit=1 detail=pairing-create-unverified'] },
  // The installer's OWN write, not the broker's. The shell made its staging file outside the step's
  // failure handling, so a state home that could not take the file ended the whole installer under
  // `set -e`: no handoff line, no reason, and an install that looked like it had merely finished.
  { name: 'offer cannot be staged',
    fixture: { readiness: readinessReady, stagingFails: true },
    expect: 'could not be published (detail: offer-file-unwritable)', offers: 1,
    log: ['step=offer exit=1 detail=offer-file-unwritable'] },
  { name: 'agent status failure with ready listener',
    fixture: { readiness: { ...readinessReady, ok: false, detailCodes: ['agent-roster-unreadable'] },
      readinessExit: 1, acceptance: accepted },
    expect: 'the broker accepted peer peer_fixture', paired: true, offers: 1 },
  { name: 'no readiness document', fixture: { readinessExit: 1 },
    expect: 'Pairing handoff: skipped', offers: 0 },
  { name: 'foreign product in the document',
    fixture: { readiness: { ...readinessReady, product: 'other' }, acceptance: accepted },
    expect: 'did not report ready', offers: 0 },
  { name: 'unverified listener',
    fixture: { readiness: { ...readinessReady, listener: { url: LISTENER_URL } }, acceptance: accepted },
    expect: 'did not report ready', offers: 0 },
  { name: 'nonlocal listener',
    fixture: { readiness: { ...readinessReady,
      listener: { ready: true, url: 'http://example.invalid' } }, acceptance: accepted },
    expect: 'did not report ready', offers: 0 },
];

function shellTail(source: string): string {
  return section(source, 'HANDOFF_HOME="$STATE_HOME"');
}

/**
 * Read a handoff file the way the assertions want: a file that is not the document it claims to be is
 * `undefined`, so the case fails with its own detail instead of taking the whole run down with a parse
 * error that says nothing about which installer wrote it.
 */
function handoffDocument(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function fixtureApplication(): string {
  return `
    import { appendFileSync } from 'node:fs';
    const argv = process.argv.slice(2);
    // Record every CLI call, so "the offer was created exactly once" is measured rather than assumed.
    if (process.env.FIXTURE_CALLS) appendFileSync(process.env.FIXTURE_CALLS, argv.join(' ') + '\\n');
    const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
    if (argv[0] === 'status') {
      // The handoff must ask the readiness question and nothing else: the full status report reads the
      // session roster, which makes the broker busier while the installer is asking whether it is busy.
      if (argv[1] !== '--json' || argv[2] !== '--readiness') process.exit(3);
      const document = parse(process.env.FIXTURE_READINESS ?? '');
      if (document !== undefined) console.log(JSON.stringify(document));
      process.exit(Number(process.env.FIXTURE_READINESS_EXIT ?? 0));
    }
    if (argv[0] !== 'pair') process.exit(2);
    if (argv[1] === '--status') {
      const document = parse(process.env.FIXTURE_ACCEPTANCE ?? '');
      if (document !== undefined) console.log(JSON.stringify(document));
      // The exit code follows the verdict, as it does in the real CLI: no answer is not a success.
      process.exit(Number(process.env.FIXTURE_ACCEPTANCE_EXIT
        ?? (document !== undefined && document.ok === false ? 1 : 0)));
    }
    if (process.env.FIXTURE_PAIR_FAIL === '1') {
      process.stderr.write(process.env.FIXTURE_PAIR_ERROR ?? '[error] pairing-create-failed: no offer\\n');
      process.exit(1);
    }
    // A reply the tail has to cope with rather than the one this fixture would choose: an exit code of 0
    // says the offer was created, and every case that reaches this point has already decided to trust it.
    if (process.env.FIXTURE_OFFER_REPLY) {
      console.log(process.env.FIXTURE_OFFER_REPLY);
      process.exit(0);
    }
    // The tail passes --broker-url last, so its value follows the flag. Pinning a position here would hand
    // back undefined and every handoff in this file would fail on its way to writing the offer.
    const urlAt = argv.indexOf('--broker-url') + 1;
    console.log(JSON.stringify({ schemaVersion: 1, pairingId: process.env.FIXTURE_PAIRING_ID,
      qr: process.env.FIXTURE_QR, brokerUrl: argv[urlAt],
      expiresAt: new Date(Date.now() + 300_000).toISOString() }));
  `;
}

/**
 * Make the state home unable to take a new file, which is what a root-owned or frozen one is.
 *
 * The handoff log lives INSIDE the same home as the offer file, so the log directory and file are created
 * first and left writable: a case about the record an installer leaves behind cannot be asserted if the run
 * cannot leave it. Appending needs write on the file, not on its directory, so the locked parent still
 * takes the log line and refuses the staging file. The mode is not restored here -- the caller does that
 * once the run is over, so the fixture can still delete the tree.
 */
function lockStateHomeForStaging(root: string): void {
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'pairing-handoff.log'), '');
  chmodSync(logs, 0o700);
  chmodSync(join(logs, 'pairing-handoff.log'), 0o600);
  chmodSync(root, 0o500);
}

function runShellTail(root: string, source: string, fixture: Fixture): {
  stdout: string; code: number; log: string; calls: string[]; offers: number;
} {
  const app = join(root, 'fixture-app.ts');
  writeFileSync(app, fixtureApplication());
  const launcher = join(root, 'fixture-client');
  writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The scratch the tail redirects its CLI output into, kept OUT of the state home because one case makes
  // that home unwritable on purpose and the run still has to record what it did.
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const path = join(root, 'handoff.sh');
  writeFileSync(path, 'set -eu\numask 077\n'
    + `STATE_HOME=${shellQuote(root)}\nWORK=${shellQuote(work)}\nBUN_BIN=${shellQuote(process.execPath)}\n`
    + `APPLICATION=${shellQuote(app)}\nCLIENT_CONTAINER=''\nCLIENT_SKIP=''\nCLIENT_RUNNING=''\n`
    + `CLIENT_LAUNCH=${shellQuote(launcher)}\nOS=Linux\nVERSION='fixture'\n`
    + shellTail(source));
  if (fixture.stagingFails) lockStateHomeForStaging(root);
  const result = Bun.spawnSync(['sh', path], {
    env: { ...process.env,
      FIXTURE_CALLS: join(work, 'fixture-calls.log'),
      FIXTURE_READINESS: fixture.readiness === undefined ? '' : JSON.stringify(fixture.readiness),
      // Omitted unless the case pins it, so the fake CLI derives its exit code from the document's own
      // verdict the way the real one does. Pinning "0" here would let a failing report exit 0.
      ...(fixture.readinessExit === undefined ? {} : { FIXTURE_READINESS_EXIT: String(fixture.readinessExit) }),
      FIXTURE_PAIR_FAIL: fixture.pairFails ? '1' : '0',
      FIXTURE_PAIR_ERROR: fixture.pairError ?? '',
      // A string is passed through as the CLI's own bytes; anything else is the document to print.
      FIXTURE_OFFER_REPLY: fixture.pairReply === undefined ? ''
        : typeof fixture.pairReply === 'string' ? fixture.pairReply : JSON.stringify(fixture.pairReply),
      FIXTURE_ACCEPTANCE: fixture.acceptance === undefined ? '' : JSON.stringify(fixture.acceptance),
      ...(fixture.acceptanceExit === undefined ? {} : { FIXTURE_ACCEPTANCE_EXIT: String(fixture.acceptanceExit) }),
      FIXTURE_PAIRING_ID: PAIRING_ID, FIXTURE_QR: OFFER_QR },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  const logFile = join(root, 'logs', 'pairing-handoff.log');
  if (fixture.stagingFails) chmodSync(root, 0o700);
  const calls = existsSync(join(work, 'fixture-calls.log'))
    ? readFileSync(join(work, 'fixture-calls.log'), 'utf8').split('\n').filter((line) => line.length > 0)
    : [];
  return {
    stdout: result.stdout.toString() + result.stderr.toString(),
    code: result.exitCode,
    log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
    calls,
    // Offer POSTs, counted from what the tail actually ran.
    offers: calls.filter((line) => line.startsWith('pair --json')).length,
  };
}

/** The reply the fake CLI gives the offer step: the fixture's, or the one a healthy broker would give. */
function offerReplyOf(fixture: Fixture): string {
  if (fixture.pairReply !== undefined) {
    return typeof fixture.pairReply === 'string'
      ? fixture.pairReply
      : JSON.stringify(fixture.pairReply);
  }
  return JSON.stringify({
    schemaVersion: 1, pairingId: PAIRING_ID, qr: OFFER_QR, brokerUrl: LISTENER_URL,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
}

/**
 * The PowerShell branch: the three-way verdict on its own, then the readiness gate and the offer step
 * together.
 *
 * The offer step is run here rather than argued about from the shell branch because it is a second
 * implementation of the same sequence, and the bug this covers -- a reply that leaves a log line, or a
 * pairing id, behind without a handoff file -- was only in that one.
 */
function powerShellChecks(check: Check, source: string, executable: string, root: string): void {
  // Get-HandoffOutcome reads its answer through Get-JsonProperty. Without that helper in the snippet the
  // missing command is swallowed by the function's own catch, so all six verdicts would come back
  // "unverifiable" and the test would pass on a broken template.
  const jsonHelper = section(source, 'function Get-JsonProperty {', '\n<#');
  const helpers = `${jsonHelper}\n${
    section(source, 'function Get-HandoffOutcome {', '\n<#\nOne bounded line per')}`;
  // The offer step reduces a failed CLI run to the detail code on its stderr, so the gate needs that helper
  // too. Left out, the whole offer-failure branch dies on a missing function and the case below fails for
  // a reason that has nothing to do with what it is testing.
  const nativeHelper = section(source, 'function Get-NativeErrorDetail {', '\n<#');
  // Through the offer step and up to the skip announcement, so the sequence that writes the log -- and the
  // sentence the operator reads when it did not work -- are both the shipped ones.
  const gate = section(source,
    "  $readiness = Invoke-Native -FilePath $bunBin -ArgumentList @($application, 'status', '--json', '--readiness')",
    '  try {\n    Start-Process');
  const run = (script: string): string => {
    const result = Bun.spawnSync([executable, '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    return result.stdout.toString() + result.stderr.toString();
  };
  const outcomes: Array<[string, string, string]> = [
    // The broker records the peer; the client saving that peer's credential is a later step in another
    // process, so the installer may say the first and must not say the second.
    ['accepted', JSON.stringify({ ok: true, state: 'accepted', peerId: 'peer_fixture' }),
      'the broker accepted peer peer_fixture'],
    ['pending', JSON.stringify({ ok: true, state: 'pending' }), 'not paired yet'],
    ['expired', JSON.stringify({ ok: true, state: 'expired' }), 'expired before anything accepted it'],
    ['not-found', JSON.stringify({ ok: true, state: 'not-found' }), 'no longer holds that pairing offer'],
    ['unverifiable', JSON.stringify({ ok: false, state: 'unverifiable' }), 'could not be confirmed'],
    ['unreadable answer', 'not json at all', 'could not be confirmed'],
  ];
  for (const [name, json, expected] of outcomes) {
    const output = run(`$ErrorActionPreference='Stop'\n${helpers}\n`
      + `$answer = Get-HandoffOutcome -Json ${psQuote(json)} -ClientLaunch 'cosyncing.exe' `
      + `-BunBin 'bun.exe' -Application 'cosyncing.exe'\n`
      + `Write-Output "STATE=$($answer.State)"\nWrite-Output $answer.Message\n`);
    check(`PowerShell pairing outcome: ${name}`,
      output.includes(expected) && !output.includes(OFFER_QR), output.trim());
  }
  for (const scenario of cases) {
    const fixture = scenario.fixture;
    // Spelled out once, because each of them is a reply the shipped installer has to cope with rather than
    // one this fixture would choose.
    const readinessDocument = fixture.readiness === undefined ? '' : JSON.stringify(fixture.readiness);
    const offerReply = fixture.pairFails ? '' : offerReplyOf(fixture);
    const offerError = fixture.pairError ?? '[error] pairing-create-failed: no offer\n';
    // A state home of its own, because the offer step writes into it. The name is the case's, so a failure
    // says which run left which file behind.
    const stateHome = join(root, `ps-${scenario.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    mkdirSync(stateHome, { recursive: true });
    const script = `$ErrorActionPreference='Stop'\n`
      // Same as the shipped installer: an unassigned variable is an error here, so a step that reads before
      // it writes fails in the fixture as it would on a customer's machine.
      + `Set-StrictMode -Version Latest\n`
      + `${jsonHelper}\n${nativeHelper}\n`
      + '$script:LogLines = @()\n'
      // Every CLI call as the gate made it, so "the offer was created exactly once" and "nothing was ever
      // confirmed about an offer that was never published" are measured rather than assumed.
      + '$script:Calls = @()\n'
      + 'function Add-HandoffLog { param($Path, $Step, $ExitCode, $Detail)'
      + ' $script:LogLines = $script:LogLines + "step=$Step exit=$ExitCode detail=$Detail" }\n'
      + 'function New-StagingPath { param($Parent, $Prefix)'
      // The installer's own write, and the case where it cannot happen: the helper named for that step is
      // the one that fails, which is also how the shell case is arranged (a state home that refuses the
      // staging file) rather than by breaking something the step does afterwards.
      + (fixture.stagingFails === true ? ' throw "cannot create a file in $Parent";' : '')
      + ' return (Join-Path $Parent ($Prefix + [Guid]::NewGuid().ToString("N"))) }\n'
      + 'function Set-OwnerOnlySecurity { param($Path, $Kind) }\n'
      + `$bunBin='fixture'; $application='fixture'; $handoffSkip=''; $handoffOfferUnverified=$false; `
      + `$listenerUrl=''; $listenerPort=''; `
      + `$pairingId=''\n`
      + `$stateHome=${psQuote(stateHome)}\n`
      + `$pairingPath=Join-Path $stateHome 'client-pairing.json'\n`
      + `$handoffLogPath=Join-Path (Join-Path $stateHome 'logs') 'pairing-handoff.log'\n`
      + `function Invoke-Native { param($FilePath, $ArgumentList)\n`
      + `  $script:Calls = $script:Calls + ($ArgumentList -join ' ')\n`
      + `  $reply = switch ($ArgumentList[1]) {\n`
      + `    'status' { ${psQuote(readinessDocument)} }\n`
      + `    'pair' { ${psQuote(offerReply)} }\n`
      + `    default { '' } }\n`
      + `  $code = switch ($ArgumentList[1]) {\n`
      + `    'status' { ${fixture.readinessExit ?? 0} }\n`
      + `    'pair' { ${fixture.pairFails ? 1 : 0} }\n`
      + `    default { 0 } }\n`
      + `  $err = switch ($ArgumentList[1]) {\n`
      + `    'pair' { ${psQuote(fixture.pairFails ? offerError : '')} }\n`
      + `    default { '' } }\n`
      + `  return [pscustomobject] @{ ExitCode = $code; StdOut = $reply; StdErr = $err } }\n`
      + `${gate}\nWrite-Output "LISTENER=$listenerUrl"\nWrite-Output "SKIP=$handoffSkip"`
      + `\nWrite-Output "DETAIL=$readinessDetail"\nWrite-Output "PAIRINGID=$pairingId"`
      + `\nWrite-Output "FILE=$(Test-Path -LiteralPath $pairingPath)"\n`
      + `foreach ($call in $script:Calls) { Write-Output "CALL $call" }\n`
      + `foreach ($line in $script:LogLines) { Write-Output "LOG $line" }\n`;
    const output = run(script);
    // The gate is asked whether it let the offer run; the skip line is asked whether the run handed
    // anything over, which is a different question now that the offer step can fail on its own.
    const opened = output.includes(`LISTENER=${LISTENER_URL}`);
    const offers = output.split('\n')
      .filter((line) => line.startsWith('CALL ') && line.includes(' pair --json')).length;
    // Only the two steps this slice runs. What became of a published offer is the verdict branch above.
    const logged = (scenario.log ?? [])
      .filter((entry) => entry.startsWith('step=readiness') || entry.startsWith('step=offer'))
      .every((entry) => output.includes(`LOG ${entry}`));
    const published = output.includes('FILE=True');
    const askedAbout = output.includes(`PAIRINGID=${PAIRING_ID}`);
    const logLines = output.split('\n').filter((line) => line.startsWith('LOG ')).join('\n');
    const skipLine = output.split('\n').find((line) => line.startsWith('SKIP=')) ?? '';
    check(`PowerShell pairing handoff: ${scenario.name}`,
      !output.includes('Exception')
        && (scenario.offers === 1 ? opened && offers === 1 : !opened && offers === 0)
        && (opened || /^SKIP=\S/m.test(output))
        // Both installers owe the operator the same sentence for the same fault. For a credential the
        // endpoint would not take, that sentence may not point at `setup` either: rewriting this machine's
        // token says nothing about an endpoint whose owner is unknown.
        && (!scenario.skipPhrase || (skipLine.includes(scenario.skipPhrase)
          && !skipLine.toLowerCase().includes('setup')))
        && (!scenario.publicPhrase || output.includes(scenario.publicPhrase))
        && (scenario.forbidPublic ?? []).every((phrase) => !output.includes(phrase))
        && output.includes(`DETAIL=${readinessDetail(fixture.readiness)}`)
        && logged
        // A handoff file, and a pairing id kept to ask about, only when the offer step said it published one.
        && published === (scenario.paired === true)
        && askedAbout === (scenario.paired === true)
        // The confirmation step belongs to a published offer and to nothing else.
        && !output.includes(' pair --status')
        // Same rule as the shell log: the offer is a credential until it is redeemed.
        && !logLines.includes(OFFER_QR) && !logLines.includes(PAIRING_ID),
      output.trim());
  }
}

export function installerPairingRegressions(check: Check, powerShell?: string): void {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-tail-'));
  try {
    if (process.platform !== 'win32') {
      const source = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.sh'), 'utf8');
      // The case that needs an unwritable state home cannot be made to fail by a user that write
      // permissions do not bind, so it is skipped by that user rather than quietly passing on a
      // directory it never locked. The same fault is still asserted on the PowerShell side, where the
      // staging helper is the stub that throws.
      const canLockStateHome = (process.getuid?.() ?? 1) !== 0;
      for (const scenario of cases) {
        if (scenario.fixture.stagingFails && !canLockStateHome) continue;
        const runRoot = join(root, scenario.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
        mkdirSync(runRoot, { recursive: true });
        const result = runShellTail(runRoot, source, scenario.fixture);
        const file = join(runRoot, 'client-pairing.json');
        const document = handoffDocument(file);
        check(`shell pairing handoff: ${scenario.name}`,
          result.code === 0
            && (scenario.expect === undefined || result.stdout.includes(scenario.expect))
            && (scenario.forbidPublic ?? []).every((phrase) => !result.stdout.includes(phrase))
            && (scenario.paired !== true
              ? !existsSync(file) && result.stdout.includes(scenario.unverifiedOffer
                ? 'Pairing handoff: unverified' : 'Pairing handoff: skipped')
              : document?.brokerUrl === LISTENER_URL && document?.qr === OFFER_QR
                && (statSync(file).mode & 0o777) === 0o600)
            && (scenario.offers === undefined || result.offers === scenario.offers)
            // The same sentence, and the same refusal to guess at the repair, on the POSIX side.
            && (scenario.skipPhrase === undefined
              || (result.stdout.includes(scenario.skipPhrase)
                && !result.stdout.toLowerCase().includes('setup')))
            // Never ask the broker to wait, and never report an unasked-for offer: both would mint or
            // burn a one-use pairing that this run has no answer for.
            && !result.calls.some((line) => line.includes('--wait'))
            // Confirmation is asked of the broker only about an offer a client could actually have read.
            // Asking anyway is the difference between "not paired yet" and a message about an offer that
            // was never published, and it is how a skipped handoff gets reported as a waiting one.
            && (existsSync(file) || !result.calls.some((line) => line.startsWith('pair --status')))
            // One outcome per step. A step that logs twice has answered for itself somewhere.
            && result.log.split('\n').filter((line) => line.includes('step=offer')).length <= 1
            && (scenario.log ?? []).every((entry) => result.log.includes(entry))
            // The readiness detail word is the one field both installers write and both branches can
            // compare against the same document, so it is checked here as well as in the log lines above.
            && result.log.includes(`detail=${readinessDetail(scenario.fixture.readiness)}`)
            // The QR is a one-use credential and the pairing id names a live offer. Neither belongs in a
            // log the operator leaves behind, and neither may be echoed as a status line.
            && !result.log.includes(OFFER_QR) && !result.log.includes(PAIRING_ID)
            && !result.stdout.includes(OFFER_QR),
        `exit=${result.code} stdout=${result.stdout} log=${result.log} calls=${result.calls.join(' | ')}`);
        rmSync(runRoot, { recursive: true, force: true });
      }
    }
    // Windows runs the shipped Windows PowerShell. Anywhere else the branch runs only if pwsh is on the
    // path, which is what makes a Linux or CI box able to answer "did the two installers agree" without a
    // Windows host -- and both halves of this file run deliberately the same cases for that reason.
    const executable = powerShell
      ?? (process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : Bun.which('pwsh') ?? undefined);
    if (executable) {
      const source = readFileSync(join(import.meta.dir, '../../release/bootstrap-template.ps1'), 'utf8')
        .replaceAll('\r\n', '\n');
      powerShellChecks(check, source, executable, join(root, 'powershell'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  let failures = 0;
  installerPairingRegressions((name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures += 1;
  }, process.argv[2]);
  if (failures) process.exit(1);
}
