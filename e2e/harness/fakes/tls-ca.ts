/**
 * A throwaway certificate authority and a `127.0.0.1` server certificate, made at test time.
 *
 * A fake HTTPS endpoint (a Web Push service) serves the leaf; the broker under test trusts the CA
 * through `NODE_EXTRA_CA_CERTS`, so its real TLS client verifies the connection as it would a push
 * service's. Nothing is committed: the keys exist only for the run. The DER is written by hand
 * (ECDSA P-256, SHA-256) because neither Bun nor Node can issue a certificate.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export interface TestCertificates {
  /** PEM of the CA to trust. */
  caPem: string;
  /** PEM of the server certificate for `127.0.0.1`, issued by the CA. */
  certPem: string;
  /** PKCS#8 PEM of the server key. */
  keyPem: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const integer = (bytes: Buffer) => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const bitString = (bytes: Buffer) => tlv(0x03, Buffer.from([0]), bytes);
const octetString = (bytes: Buffer) => tlv(0x04, bytes);
const boolean = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const explicit = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts);

function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out = [first! * 40 + second!];
  for (const value of rest) {
    const groups = [value & 0x7f];
    for (let high = value >> 7; high > 0; high >>= 7) groups.unshift((high & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date: Date): Buffer {
  const text = `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(text.slice(2))) : tlv(0x18, Buffer.from(text));
}

const ECDSA_WITH_SHA256 = sequence(objectId('1.2.840.10045.4.3.2'));
const commonName = (cn: string) => sequence(set(sequence(objectId('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const extension = (id: string, critical: boolean, value: Buffer) =>
  sequence(objectId(id), ...(critical ? [boolean(true)] : []), octetString(value));

function certificate(input: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signer: KeyObject;
  authority: boolean;
}): string {
  const now = Date.now();
  const extensions = [
    // basicConstraints, keyUsage (keyCertSign + cRLSign for the CA, digitalSignature for the leaf).
    extension('2.5.29.19', true, sequence(...(input.authority ? [boolean(true)] : []))),
    extension('2.5.29.15', true, bitString(Buffer.from([input.authority ? 0x06 : 0x80]))),
    // subjectAltName IP:127.0.0.1 on the leaf.
    ...(input.authority ? [] : [extension('2.5.29.17', false, sequence(tlv(0x87, Buffer.from([127, 0, 0, 1]))))]),
  ];
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(8)),
    ECDSA_WITH_SHA256,
    commonName(input.issuer),
    sequence(time(new Date(now - 3_600_000)), time(new Date(now + 7 * 24 * 3_600_000))),
    commonName(input.subject),
    input.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(...extensions)),
  );
  const der = sequence(tbs, ECDSA_WITH_SHA256, bitString(sign('sha256', tbs, input.signer)));
  const lines = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

export function testCertificates(): TestCertificates {
  const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issuer = 'cosyncing e2e test authority';
  return {
    caPem: certificate({
      subject: issuer, issuer, publicKey: authority.publicKey, signer: authority.privateKey, authority: true,
    }),
    certPem: certificate({
      subject: '127.0.0.1', issuer, publicKey: server.publicKey, signer: authority.privateKey, authority: false,
    }),
    keyPem: server.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}
