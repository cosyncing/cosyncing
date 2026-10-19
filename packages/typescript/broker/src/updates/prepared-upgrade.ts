/** Prepared bytes belong to a durable reviewed job, never to an HTTP-supplied
 * path. The existing installer still re-verifies every signature and artifact.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectInstallState } from '../installation/install-state.ts';
import { atomicWriteJsonOwnerOnly, atomicWriteOwnerOnly, ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { openUpdateGrantStore } from '../security/update-grants.ts';
import { BUN_RELEASE_DOWNLOAD_BASE } from '../runtime/application-identity.ts';
import { bunRuntimeHost } from './bun-runtime-upgrade.ts';
import { UpdateOperationStore } from './update-operation-store.ts';
import { compareReleaseVersions } from './updater-metadata.ts';
import { releaseIdFromManifest, type UpgradeCandidate } from './release-upgrade.ts';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Artifact = { name: string; url: string; sha256: string; size: number };

export async function stageUpgradeArtifacts(options: {
  stagingRoot: string; jobId: string; candidate: UpgradeCandidate;
  download: (url: string, maximum: number) => Promise<Uint8Array>;
}): Promise<void> {
  if (!JOB_ID.test(options.jobId)) throw new Error('update-job-invalid');
  const { candidate } = options;
  const artifacts: Artifact[] = [{ name: candidate.name, url: candidate.url, sha256: candidate.sha256, size: candidate.size }];
  const web = candidate.manifest.webApp;
  if (candidate.expectedDistribution === 'bootstrap-js' && web) artifacts.push(web);
  const runtime = candidate.manifest.jsApp?.bunRuntime;
  if (runtime && candidate.minimumBunVersion && compareReleaseVersions(Bun.version, candidate.minimumBunVersion) < 0) {
    const host = bunRuntimeHost();
    const archives = host ? runtime.archives[host] : undefined;
    if (!archives?.length) throw new Error('release-runtime-host-unavailable');
    for (const archive of archives) artifacts.push({ name: archive.asset,
      url: `${BUN_RELEASE_DOWNLOAD_BASE}/bun-v${runtime.version}/${archive.asset}`,
      sha256: archive.sha256, size: archive.size });
  }
  const staging = join(options.stagingRoot, options.jobId);
  ensureOwnerOnlyDirectory(staging);
  for (const artifact of artifacts) {
    if (!FILE.test(artifact.name)) throw new Error('release-artifact-name-invalid');
    const bytes = await options.download(artifact.url, 256 * 1024 * 1024);
    if (bytes.byteLength !== artifact.size || digest(bytes) !== artifact.sha256) throw new Error('release-artifact-digest-mismatch');
    atomicWriteOwnerOnly(join(staging, artifact.name), bytes);
  }
  atomicWriteJsonOwnerOnly(join(staging, 'manifest.json'), candidate.manifest);
  atomicWriteJsonOwnerOnly(join(staging, 'prepared.json'), {
    schemaVersion: 1, releaseId: releaseIdFromManifest(candidate.manifest), component: 'broker',
    name: candidate.name, digest: candidate.sha256, bytes: candidate.size,
    stagedAt: new Date().toISOString(), artifacts,
  });
}

/** This reader is used only by the trusted local CLI runner. It never resolves
 * latest, downloads a missing file, or honors a path from a remote request. */
export function preparedUpgradeInput(home: string, jobId: string): {
  fetch: typeof fetch; pinnedReleaseId: string; authorizeCommit: () => void;
} {
  if (!JOB_ID.test(jobId)) throw new Error('update-job-invalid');
  const store = new UpdateOperationStore(join(home, 'updates'));
  const read = store.readJob(jobId);
  if (!read.ok) throw new Error('update-job-unreadable');
  const job = read.value;
  const reviewed = store.readPlan(job.planId);
  if (!reviewed.ok) throw new Error('update-plan-unreadable');
  const plan = reviewed.value.plan;
  if (plan.releaseId !== job.releaseId || plan.installationId !== job.installationId
      || plan.installationGeneration !== job.installationGeneration
      || plan.components.length !== 1 || plan.components[0]?.component !== 'broker') {
    throw new Error('update-prepared-scope-mismatch');
  }
  const staging = join(home, 'updates', 'staging', jobId);
  const recordPath = join(staging, 'prepared.json');
  const manifestPath = join(staging, 'manifest.json');
  if (inspectOwnerOnlyFile(recordPath).status !== 'ok' || inspectOwnerOnlyFile(manifestPath).status !== 'ok') {
    throw new Error('update-preparation-unreadable');
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { schemaVersion: number; releaseId: string; artifacts: Artifact[] };
  if (record.schemaVersion !== 1 || record.releaseId !== job.releaseId || !Array.isArray(record.artifacts)) {
    throw new Error('update-preparation-unreadable');
  }
  const manifest = readFileSync(manifestPath);
  const authorizeCommit = () => {
    const install = inspectInstallState(home);
    const live = store.readJob(jobId);
    if (!install.committed || install.state.installationId !== job.installationId
        || Math.max(1, Math.floor(Date.parse(install.state.setup.committedAt) / 1000) || 1) !== job.installationGeneration
        || !live.ok || !['applying', 'verifying'].includes(live.value.phase) || !live.value.applyAcceptedAt
        || !Number.isFinite(Date.parse(reviewed.value.plan.expiresAt))
        || Date.parse(reviewed.value.plan.expiresAt) < Date.now()) throw new Error('update-plan-stale');
    const principal = reviewed.value.principal;
    if (principal.kind === 'peer' && !openUpdateGrantStore({ home, installationId: job.installationId }).mayUpdate(principal.id)) {
      throw new Error('update-grant-revoked');
    }
  };
  authorizeCommit();
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    // The installer is always given an immutable release URL. Its first
    // metadata read receives the same signed document preparation accepted.
    if (url.endsWith('/release-manifest.json') || url.endsWith('/manifest.json')) {
      return new Response(new Uint8Array(manifest), { headers: { 'content-type': 'application/json' } });
    }
    const artifact = record.artifacts.find((row) => row.url === url);
    if (!artifact || !FILE.test(artifact.name)) throw new Error('update-artifact-not-prepared');
    const path = join(staging, artifact.name);
    if (inspectOwnerOnlyFile(path).status !== 'ok') throw new Error('update-preparation-unreadable');
    const bytes = readFileSync(path);
    if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) throw new Error('update-preparation-changed');
    return new Response(new Uint8Array(bytes));
  };
  return { fetch: fetcher as typeof fetch, pinnedReleaseId: job.releaseId, authorizeCommit };
}
