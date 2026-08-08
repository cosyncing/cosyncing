import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityKeyPair, X25519KeyPair } from './index.ts';

export interface LocalKeyStore {
  version: 1;
  owner: string;
  identity: IdentityKeyPair;
  exchange: X25519KeyPair;
  createdAt: string;
}

export function loadOrCreateLocalKeyStore(dir: string, owner: string): LocalKeyStore {
  if (!owner.trim()) throw new Error('key store owner is required');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cosyncing-keys.json');
  if (existsSync(path)) return validateLocalKeyStore(JSON.parse(readFileSync(path, 'utf8')));
  const store: LocalKeyStore = {
    version: 1,
    owner,
    identity: generateLocalIdentityKeyPair(),
    exchange: generateLocalX25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  return store;
}

function validateLocalKeyStore(value: LocalKeyStore): LocalKeyStore {
  if (value.version !== 1) throw new Error('unsupported key store version');
  if (!value.owner) throw new Error('key store owner is required');
  if (value.identity?.algorithm !== 'Ed25519' || !value.identity.publicKey || !value.identity.privateKey) {
    throw new Error('invalid identity key');
  }
  if (!value.exchange?.publicKey || !value.exchange.privateKey) throw new Error('invalid exchange key');
  return value;
}

function generateLocalIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    algorithm: 'Ed25519',
    publicKey: exportPublic(publicKey),
    privateKey: exportPrivate(privateKey),
  };
}

function generateLocalX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: exportPublic(publicKey),
    privateKey: exportPrivate(privateKey),
  };
}

function exportPublic(key: KeyObject): string {
  return b64(key.export({ format: 'der', type: 'spki' }) as Buffer);
}

function exportPrivate(key: KeyObject): string {
  return b64(key.export({ format: 'der', type: 'pkcs8' }) as Buffer);
}

function b64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}
