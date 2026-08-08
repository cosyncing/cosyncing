#!/usr/bin/env bun
/** Deterministic real-host evidence schema and fail-closed semantics. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_REQUIREMENTS,
  CLIENT_REQUIREMENTS,
  HOST_REQUIREMENTS,
  validateRealHostEvidence,
  type RealHostEvidence,
  type EvidenceClaim,
  type EvidenceStatus,
} from '../../acceptance/real-host-evidence.ts';
import {
  EXPECTED_CANDIDATE_ASSETS,
  EXPECTED_PROMOTION_ASSETS,
  candidateAssetBlockers,
  promotionAssetBlockers,
} from '../../release/verify-promotion-assets.ts';
import {
  EXPECTED_STAGING_ASSETS,
  stagingAssetBlockers,
} from '../../release/verify-staging-assets.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

function claim(scope: string, id: string, status: EvidenceStatus): EvidenceClaim {
  return { status, evidenceId: `${scope}-${id}`.replaceAll('.', '-'), note: `${status} fixture evidence` };
}

function completeEvidence(): RealHostEvidence {
  const hosts: RealHostEvidence['hosts'] = {};
  for (const [lane, requirements] of Object.entries(HOST_REQUIREMENTS)) {
    hosts[lane] = {
      auditId: `${lane}-audit`,
      claims: Object.fromEntries(requirements.map((id) => [id, claim(lane, id, 'pass')])),
    };
  }
  const agents: RealHostEvidence['agents'] = {};
  for (const [agent, requirements] of Object.entries(AGENT_REQUIREMENTS)) {
    const claims: Record<string, EvidenceClaim> = {};
    const byStatus = requirements as {
      pass?: readonly string[];
      limitation?: readonly string[];
      excluded?: readonly string[];
    };
    for (const status of ['pass', 'limitation', 'excluded'] as const) {
      for (const id of byStatus[status] ?? []) {
        claims[id] = claim(agent, id, status);
      }
    }
    agents[agent] = { auditId: `${agent}-audit`, claims };
  }
  return {
    schemaVersion: 1,
    release: {
      version: '1.2.3',
      sourceCommit: '1'.repeat(40),
      manifestSha256: '2'.repeat(64),
      publishedArtifact: true,
    },
    hosts,
    agents,
    client: {
      auditId: 'client-audit',
      claims: Object.fromEntries(CLIENT_REQUIREMENTS.map((id) => [id, claim('client', id, 'pass')])),
    },
    packagedClaudeHooksSurfaceAbsent: true,
    generatedAt: '2026-07-17T00:00:00.000Z',
  };
}

const complete = completeEvidence();
check('a complete four-host/four-agent/real-client record passes', validateRealHostEvidence(complete).ok);

const missingArm = structuredClone(complete);
delete missingArm.hosts['linux-arm64'];
const missingArmResult = validateRealHostEvidence(missingArm);
check('a missing Linux architecture is a blocker, never an implicit skip',
  !missingArmResult.ok && missingArmResult.blockers.some((item) => item.startsWith('hosts.linux-arm64')));

const skippedAgent = structuredClone(complete);
skippedAgent.agents.codex!.claims.approval = claim('codex', 'approval', 'skip');
const skippedAgentResult = validateRealHostEvidence(skippedAgent);
check('a skipped real-agent branch cannot count as pass',
  !skippedAgentResult.ok && skippedAgentResult.blockers.includes('agents.codex.approval: expected pass, got skip'));

const falseClaudeClaim = structuredClone(complete);
falseClaudeClaim.agents.claude!.claims['hooks.answer-only'] = claim('claude', 'hooks.answer-only', 'pass');
const falseClaudeResult = validateRealHostEvidence(falseClaudeClaim);
check('Claude hooks must remain explicitly excluded from packaged v1',
  !falseClaudeResult.ok && falseClaudeResult.blockers.includes('agents.claude.hooks.answer-only: expected excluded, got pass'));

const secret = structuredClone(complete);
secret.client.claims['encrypted-control']!.note = 'peerToken=abcdefghijk';
check('credential-shaped evidence is rejected',
  validateRealHostEvidence(secret).blockers.includes('record: credential-shaped value detected'));

const wrongCandidate = validateRealHostEvidence(complete, {
  version: '1.2.4',
  sourceCommit: '3'.repeat(40),
  manifestSha256: '4'.repeat(64),
});
check('evidence for a different candidate cannot promote this release',
  !wrongCandidate.ok
    && wrongCandidate.blockers.includes('release.version: does not match candidate')
    && wrongCandidate.blockers.includes('release.sourceCommit: does not match candidate')
    && wrongCandidate.blockers.includes('release.manifestSha256: does not match candidate'));

const unsafeReference = structuredClone(complete);
unsafeReference.hosts['linux-x64']!.claims['artifact.install']!.evidenceId = '../private/transcript';
check('evidence references are opaque identifiers rather than paths',
  validateRealHostEvidence(unsafeReference).blockers.some((item) => item.includes('safe opaque reference')));

const multilineNote = structuredClone(complete);
multilineNote.agents.pi!.claims.approval!.note = 'first line\nraw terminal output';
check('human notes stay bounded single-line summaries',
  validateRealHostEvidence(multilineNote).blockers.some((item) => item.includes('bounded single line')));

const unexpectedEvidence = structuredClone(complete) as RealHostEvidence & { rawTranscript?: string };
unexpectedEvidence.rawTranscript = 'unreviewed content';
check('unknown evidence fields cannot bypass the closed schema',
  validateRealHostEvidence(unexpectedEvidence).blockers.includes('record.rawTranscript: unexpected field'));

const unexpectedClaim = structuredClone(complete);
unexpectedClaim.agents.codex!.claims['unreviewed.branch'] = claim('codex', 'unreviewed.branch', 'pass');
check('extra unreviewed claims cannot ride through a passing record',
  validateRealHostEvidence(unexpectedClaim).blockers.includes('agents.codex.claims.unreviewed.branch: unexpected field'));

const gateWorkflow = readFileSync(resolve(import.meta.dir, '../../../../.github/workflows/broker-release-gate.yml'), 'utf8');
const releaseWorkflow = readFileSync(resolve(import.meta.dir, '../../../../.github/workflows/broker-release.yml'), 'utf8');
const promotionWorkflow = readFileSync(resolve(import.meta.dir, '../../../../.github/workflows/broker-release-promote.yml'), 'utf8');
check('merge and tag workflows do not consume Actions artifact storage',
  !gateWorkflow.includes('actions/upload-artifact')
    && !gateWorkflow.includes('actions/download-artifact')
    && !releaseWorkflow.includes('actions/upload-artifact')
    && !releaseWorkflow.includes('actions/download-artifact'));
const remoteCandidateVerification = releaseWorkflow.indexOf('verify-promotion-assets.ts --candidate');
const prereleasePublication = releaseWorkflow.indexOf('gh release edit');
check('a release tag uses a draft for staging and publishes only after remote verification',
  releaseWorkflow.includes('gh release create')
    && releaseWorkflow.includes('--draft')
    && releaseWorkflow.includes('gh release upload')
    && releaseWorkflow.includes('gh release download')
    && releaseWorkflow.includes('gh release delete-asset')
    && remoteCandidateVerification >= 0
    && prereleasePublication > remoteCandidateVerification
    && releaseWorkflow.includes('--draft=false')
    && releaseWorkflow.includes('--prerelease=true'));
check('stable promotion binds tag, signature, checksums, and exact assets before changing channel',
  promotionWorkflow.includes('git rev-parse "$TAG^{commit}"')
    && promotionWorkflow.includes('COSYNCING_RELEASE_PUBLIC_KEY_PEM_B64')
    && promotionWorkflow.includes('cmp "$RUNNER_TEMP/cosyncing-release.pub.pem" output/promotion/release-key.pem')
    && promotionWorkflow.includes('openssl pkeyutl -verify')
    && promotionWorkflow.includes('sha256sum --check SHA256SUMS')
    && promotionWorkflow.includes('verify-promotion-assets.ts output/promotion')
    && promotionWorkflow.includes('--prerelease=false'));

const stagingDirectory = mkdtempSync(join(tmpdir(), 'cosyncing-real-evidence-staging-'));
try {
  for (const file of EXPECTED_STAGING_ASSETS) writeFileSync(join(stagingDirectory, file), 'fixture\n');
  check('candidate assembly accepts only native plus web artifacts and evidence',
    stagingAssetBlockers(stagingDirectory).length === 0);
  writeFileSync(join(stagingDirectory, 'unreviewed-extra.txt'), 'unexpected\n');
  check('an extra draft asset blocks candidate assembly',
    stagingAssetBlockers(stagingDirectory).some((item) => item.includes('staging asset set mismatch')));
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

const candidateDirectory = mkdtempSync(join(tmpdir(), 'cosyncing-real-evidence-candidate-'));
try {
  for (const file of EXPECTED_CANDIDATE_ASSETS) writeFileSync(join(candidateDirectory, file), 'fixture\n');
  check('an exact but unsigned fixture still fails the signed pairing gate',
    candidateAssetBlockers(candidateDirectory).some((item) =>
      item.includes('signed broker/web pairing is invalid')));
  writeFileSync(join(candidateDirectory, 'stale-native.evidence.json'), 'unexpected\n');
  check('a stale staging asset blocks prerelease publication',
    candidateAssetBlockers(candidateDirectory).some((item) => item.includes('candidate asset set mismatch')));
} finally {
  rmSync(candidateDirectory, { recursive: true, force: true });
}

const promotionDirectory = mkdtempSync(join(tmpdir(), 'cosyncing-real-evidence-promotion-'));
try {
  for (const file of EXPECTED_PROMOTION_ASSETS) writeFileSync(join(promotionDirectory, file), 'fixture\n');
  check('an exact promotion fixture still requires a valid signed pairing',
    promotionAssetBlockers(promotionDirectory).some((item) =>
      item.includes('signed broker/web pairing is invalid')));
  writeFileSync(join(promotionDirectory, 'unreviewed-extra.txt'), 'unexpected\n');
  check('an extra prerelease asset blocks stable promotion',
    promotionAssetBlockers(promotionDirectory).some((item) => item.includes('asset set mismatch')));
} finally {
  rmSync(promotionDirectory, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} real-host evidence checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} real-host evidence checks`);
