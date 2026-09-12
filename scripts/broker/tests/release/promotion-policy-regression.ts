import assert from 'node:assert/strict';
import { sign, verify } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, type ReleaseAssemblyOptions } from '../../release/release-files.ts';
import { releaseManifestSigningPayload, verifyReleaseManifest } from '../../../../packages/typescript/broker/src/updates/release-upgrade.ts';

/** Execute the promotion workflow's shell steps with two git revisions and a local-only gh fixture. */
export function promotionPolicyRegression(options: ReleaseAssemblyOptions, root: string): void {
  const repo = join(root, 'promotion-policy-repo');
  const bin = join(root, 'promotion-fixture-bin');
  const temporary = join(root, 'promotion-runner-temp');
  for (const path of [repo, bin, temporary]) mkdirSync(path, { recursive: true });
  const environment = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Release fixture', GIT_COMMITTER_NAME: 'Release fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temporary,
    COSYNCING_BINARY_RELEASE_LEGAL_APPROVED: '',
  };
  function run(argv: string[], env = environment): { code: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(argv, { cwd: repo, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
  function git(...args: string[]): string {
    const result = run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args]);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  }
  const policyRelative = 'scripts/broker/release/verify-promotion-assets.ts';
  const policyPath = join(repo, policyRelative);
  mkdirSync(join(repo, 'scripts/broker/release'), { recursive: true });
  git('init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: options.version }));
  // Models the old native selection and ignored extra identity arguments, using the real legacy verifier.
  writeFileSync(policyPath, `import { readFileSync, writeFileSync } from 'node:fs';
import { verifyReleaseManifest } from ${JSON.stringify(resolve('packages/typescript/broker/src/updates/release-upgrade.ts'))};
const directory = process.argv[2];
const manifest = JSON.parse(readFileSync(directory + '/release-manifest.json', 'utf8'));
verifyReleaseManifest({ value: manifest, target: 'linux-x64', trustedKeys: {
  [manifest.signature.keyId]: readFileSync(directory + '/release-key.pem', 'utf8'),
} });
writeFileSync('legacy-verifier-executed', 'yes');
`);
  git('add', '.'); git('commit', '-m', 'Legacy native candidate fixture');
  const candidateCommit = git('rev-parse', 'HEAD');
  const tag = `broker-v${options.version}`;
  git('tag', tag);

  // The trusted revision carries the actual current policy, including its imported dependencies.
  const bundle = run([process.execPath, 'build', resolve(policyRelative), '--target=bun', '--outfile', policyPath]);
  assert.equal(bundle.code, 0, bundle.stderr);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '99.0.0' }));
  git('add', '.'); git('commit', '-m', 'Trusted JavaScript publication policy fixture');
  const workflowCommit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', workflowCommit);

  function candidate(directory: string, native: boolean): void {
    cpSync(options.outputDirectory, directory, { recursive: true });
    const manifestPath = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.sourceCommit = candidateCommit;
    if (native) {
      manifest.artifacts = ['linux-x64', 'linux-arm64', 'darwin-arm64'].map((target) => {
        const name = `cosyncing-${target}`;
        const bytes = Buffer.from(target.startsWith('linux') ? '\x7fELF native fixture' : '\xcf\xfa\xed\xfe native fixture', 'binary');
        writeFileSync(join(directory, name), bytes);
        const statement = JSON.parse(readFileSync(join(directory, 'cosyncing-app.js.intoto.jsonl'), 'utf8'));
        statement.subject = [{ name, digest: { sha256: sha256(bytes) } }];
        statement.predicate.buildDefinition.buildType = 'https://cosyncing.dev/build/bun-compile/v1';
        writeFileSync(join(directory, `${name}.intoto.jsonl`), JSON.stringify(statement));
        return { name, target, platform: target.split('-')[0], arch: target.split('-')[1],
          size: bytes.length, sha256: sha256(bytes), url: `${options.baseUrl}/${name}`,
          provenanceUrl: `${options.baseUrl}/${name}.intoto.jsonl` };
      });
    }
    const { signature, ...unsigned } = manifest;
    manifest.signature = { ...signature, value: sign(null, releaseManifestSigningPayload(unsigned), options.privateKeyPem).toString('base64') };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.intoto.jsonl'))) {
      const statement = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = candidateCommit;
      writeFileSync(join(directory, name), JSON.stringify(statement));
      writeFileSync(join(directory, `${name}.sig`), sign(null, readFileSync(join(directory, name)), options.privateKeyPem));
    }
    function signPayload(name: string): void {
      const bytes = readFileSync(join(directory, name));
      writeFileSync(join(directory, `${name}.sig`), sign(null, bytes, options.privateKeyPem));
      for (const [suffix, dsaEncoding] of [['.p256.sig', 'ieee-p1363'], ['.p256.der.sig', 'der']] as const) {
        writeFileSync(join(directory, `${name}${suffix}`), sign('sha256', bytes, { key: options.p256PrivateKeyPem, dsaEncoding }));
      }
    }
    signPayload('release-manifest.json');
    const covered = readdirSync(directory).filter((name) => !name.startsWith('SHA256SUMS')).sort();
    writeFileSync(join(directory, 'SHA256SUMS'), covered.map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}\n`).join(''));
    signPayload('SHA256SUMS');
    assert.ok(verify(null, readFileSync(manifestPath), options.publicKeyPem, readFileSync(`${manifestPath}.sig`)));
    if (native) assert.equal(verifyReleaseManifest({ value: manifest, target: 'linux-x64',
      trustedKeys: { [options.keyId]: options.publicKeyPem } }).artifact.target, 'linux-x64');
  }
  const native = join(root, 'signed-legacy-native-candidate');
  const javascript = join(root, 'signed-javascript-candidate');
  candidate(native, true); candidate(javascript, false);
  assert.equal(readdirSync(native).length, 37);
  git('checkout', '--detach', candidateCommit);
  const oldPolicy = run([process.execPath, 'run', policyRelative, native, '--version', 'ignored', '--commit', 'ignored']);
  assert.equal(oldPolicy.code, 0, oldPolicy.stderr);
  rmSync(join(repo, 'legacy-verifier-executed'));

  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import { cpSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'release') process.exit(2);
if (args[1] === 'view') console.log(JSON.stringify({isDraft:false,isPrerelease:true,tagName:args[2]}));
else if (args[1] === 'download') cpSync(process.env.FIXTURE_ASSETS, args[args.indexOf('--dir')+1], {recursive:true});
else if (args[1] === 'edit') writeFileSync(process.env.FIXTURE_PROMOTED, args[2]);
else process.exit(2);
`, { mode: 0o755 });
  const workflow = Bun.YAML.parse(readFileSync(resolve('.github/workflows/broker-release-promote.yml'), 'utf8')) as any;
  const steps = workflow.jobs.promote.steps as any[];
  const checkout = steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkout.length, 1);
  assert.equal(checkout[0].with.ref, '${{ github.workflow_sha }}');

  function exercise(assets: string, workflowRef: string): { result: ReturnType<typeof run>; promoted: boolean } {
    git('checkout', '--detach', workflowCommit);
    rmSync(join(repo, 'output'), { recursive: true, force: true });
    const envFile = join(temporary, 'github-env');
    const promoted = join(temporary, 'promoted');
    writeFileSync(envFile, ''); rmSync(promoted, { force: true });
    const env = { ...environment, TAG: tag, GITHUB_REPOSITORY: 'cosyncing/cosyncing',
      WORKFLOW_REF: workflowRef, WORKFLOW_SHA: workflowCommit, GITHUB_ENV: envFile,
      RELEASE_PUBLIC_KEY_B64: Buffer.from(options.publicKeyPem).toString('base64'),
      RELEASE_P256_PUBLIC_KEY_B64: Buffer.from(options.p256PublicKeyPem).toString('base64'),
      FIXTURE_ASSETS: assets, FIXTURE_PROMOTED: promoted };
    let result = { code: 0, stdout: '', stderr: '' };
    for (const step of steps.filter((step) => step.run && step.name)) {
      result = run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], env);
      if (result.code !== 0) break;
      for (const line of readFileSync(envFile, 'utf8').trim().split('\n').filter(Boolean)) {
        const index = line.indexOf('=');
        Object.assign(env, { [line.slice(0, index)]: line.slice(index + 1) });
      }
    }
    assert.equal(git('rev-parse', 'HEAD'), workflowCommit, 'candidate must never replace the policy checkout');
    assert.equal(readdirSync(repo).includes('legacy-verifier-executed'), false);
    return { result, promoted: readdirSync(temporary).includes('promoted') };
  }
  const workflowRef = 'cosyncing/cosyncing/.github/workflows/broker-release-promote.yml@refs/heads/main';
  const refused = exercise(native, workflowRef);
  assert.notEqual(refused.result.code, 0);
  assert.match(refused.result.stderr, /asset set mismatch/);
  assert.equal(refused.promoted, false);
  const accepted = exercise(javascript, workflowRef);
  assert.equal(accepted.result.code, 0, accepted.result.stderr);
  assert.equal(accepted.promoted, true, 'mock promotion must accept a JS candidate older than the policy');
  const untrusted = exercise(javascript, workflowRef.replace('refs/heads/main', `refs/tags/${tag}`));
  assert.notEqual(untrusted.result.code, 0);
  assert.equal(untrusted.promoted, false);
  console.log('PASS  trusted workflow policy rejects a correctly signed legacy native candidate and accepts older JavaScript candidate identity');
}
