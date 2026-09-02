#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assembleRelease, canonicalProductVersion } from './release-files.ts';

interface Args {
  artifacts: string;
  evidence: string;
  output: string;
  baseUrl: string;
  commit: string;
  publishedAt: string;
  keyId: string;
  privateKey: string;
  publicKey: string;
  p256PrivateKey: string;
  p256PublicKey: string;
}

function usage(): never {
  console.error(
    'Usage: bun run scripts/broker/release/assemble-release.ts ' +
    '--artifacts DIR --evidence DIR --output DIR --base-url HTTPS_URL --commit HEX ' +
    '--published-at ISO --key-id ID --private-key PATH --public-key PATH ' +
    '--p256-private-key PATH --p256-public-key PATH',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) usage();
    values.set(key, value);
  }
  const value = (key: string): string => values.get(key) ?? usage();
  return {
    artifacts: resolve(value('--artifacts')),
    evidence: resolve(value('--evidence')),
    output: resolve(value('--output')),
    baseUrl: value('--base-url'),
    commit: value('--commit'),
    publishedAt: value('--published-at'),
    keyId: value('--key-id'),
    privateKey: resolve(value('--private-key')),
    publicKey: resolve(value('--public-key')),
    p256PrivateKey: resolve(value('--p256-private-key')),
    p256PublicKey: resolve(value('--p256-public-key')),
  };
}

const args = parseArgs(process.argv.slice(2));
const result = assembleRelease({
  artifactDirectory: args.artifacts,
  evidenceDirectory: args.evidence,
  outputDirectory: args.output,
  baseUrl: args.baseUrl,
  version: canonicalProductVersion(),
  sourceCommit: args.commit,
  publishedAt: args.publishedAt,
  keyId: args.keyId,
  privateKeyPem: readFileSync(args.privateKey, 'utf8'),
  publicKeyPem: readFileSync(args.publicKey, 'utf8'),
  p256PrivateKeyPem: readFileSync(args.p256PrivateKey, 'utf8'),
  p256PublicKeyPem: readFileSync(args.p256PublicKey, 'utf8'),
});
console.log(JSON.stringify({
  version: result.manifest.version,
  sourceCommit: result.manifest.sourceCommit,
  output: result.outputDirectory,
  files: result.publishedFiles,
}));
