/**
 * Adversarial no-model tests for the R2 export redactor (GPT-Pro §3 threat table: "secrets echoed into
 * transcript" + "OpenCode --sanitize misses local path data"). Pure fixtures — NO model calls, NO paid
 * credentials (every "secret" below is a well-known public documentation example / obviously fake).
 *
 *   bun run scripts/broker/tests/security-r2/test-r2-redactor.ts
 */
export {};
import { redactTranscript } from '../../../../packages/typescript/broker/src/r2-redactor.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ── Corpus: every high-confidence class must be redacted, with counts, and ok:true ──
const corpus = [
  'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'aws_access_key_id=AKIAIOSFODNN7EXAMPLE',
  'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'auth=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'DATABASE_URL=postgres://dbuser:s3cr3tpass@db.example.com:5432/app',
  'Authorization: Bearer abc123def456ghi789jkl012mno345',
  'clone url https://alice:hunter2@github.com/acme/repo.git',
  'fetch https://api.example.com/data?token=SUPERSECRETVALUE123&x=1',
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA0000000000000000000000000000000000000000',
  '-----END RSA PRIVATE KEY-----',
  'workspace at /home/tester/project-a/src/secret.ts',
].join('\n');

const r = redactTranscript(corpus, { homeDirs: ['/home/tester'], projectRoots: ['/home/tester/project-a'] });
check('corpus redaction returns ok', r.ok, r.reason || '');
check('no raw OpenAI key remains', !/\bsk-proj-[A-Za-z0-9]{20,}/.test(r.text), r.text);
check('no raw Anthropic key remains', !/\bsk-ant-/.test(r.text), r.text);
check('no raw GitHub PAT remains', !/\bghp_[A-Za-z0-9]{30,}/.test(r.text), r.text);
check('no raw AWS access key id remains', !/\bAKIA[0-9A-Z]{16}\b/.test(r.text), r.text);
check('no raw AWS secret remains', !/wJalrXUtnFEMI/.test(r.text), r.text);
check('no raw JWT remains', !/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./.test(r.text), r.text);
check('no raw DATABASE_URL creds remain', !/dbuser:s3cr3tpass/.test(r.text), r.text);
check('no raw URL credentials remain', !/alice:hunter2@/.test(r.text), r.text);
check('no raw bearer header value remains', !/Bearer abc123def456/.test(r.text), r.text);
check('no raw secret query param remains', !/SUPERSECRETVALUE123/.test(r.text), r.text);
check('no PEM private key block remains', !/BEGIN RSA PRIVATE KEY[\s\S]*END RSA PRIVATE KEY/.test(r.text), r.text);
check('home path prefix redacted (the --sanitize leak)', !r.text.includes('/home/tester'), r.text);
check('project root redacted', r.text.includes('[REDACTED_PROJECT]'), r.text);
check('redaction counts populated', Object.values(r.counts).reduce((a, b) => a + b, 0) >= 8, JSON.stringify(r.counts));
check('no residual high-confidence secrets', r.residual.length === 0, JSON.stringify(r.residual));

// ── Fail-closed: a malformed PEM the forward pass cannot cleanly excise must refuse (residual) ──
const malformed = redactTranscript('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E-truncated-no-end-marker');
check('malformed/unclosed private key refuses (fail-closed)', !malformed.ok, malformed.reason || 'expected refusal');
check('malformed private key reports residual marker', malformed.residual.includes('PRIVATE_KEY_MARKER'), JSON.stringify(malformed.residual));

// ── Fail-closed: undecodable/binary input refuses (rule 13) ──
const binary = redactTranscript('safe text then a NUL: ' + String.fromCharCode(0) + ' binary tail');
check('binary/undecodable input refuses (fail-closed)', !binary.ok, binary.reason || 'expected refusal');

// ── Clean input is passed through unchanged and ok ──
const clean = redactTranscript('just a normal conversation about sorting algorithms.');
check('clean transcript is not refused', clean.ok, clean.reason || '');
check('clean transcript text preserved', clean.text.includes('sorting algorithms'), clean.text);

const failed = results.filter((x) => !x.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} redactor check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} R2 redactor checks`);
