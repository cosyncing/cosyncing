import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  inspectOwnerOnlyFile,
  readOwnerOnlyText,
} from '../security/secure-files.ts';

interface BrokerInstanceFile {
  version: 1;
  instanceId: string;
}

const INSTANCE_FILE = 'broker-instance.json';
const INSTANCE_ID = /^broker_[A-Za-z0-9_-]{32,128}$/;

/** Durable installation identity, independent of URL, port, DNS, or proxy. */
export function loadOrCreateBrokerInstanceId(home = setupStateHome()): string {
  const path = join(home, INSTANCE_FILE);
  const inspected = inspectOwnerOnlyFile(path);
  if (inspected.status === 'ok') {
    let parsed: Partial<BrokerInstanceFile>;
    try {
      parsed = JSON.parse(readOwnerOnlyText(path)) as Partial<BrokerInstanceFile>;
    } catch {
      throw new Error('broker-instance-invalid');
    }
    if (parsed.version !== 1 || typeof parsed.instanceId !== 'string' || !INSTANCE_ID.test(parsed.instanceId)) {
      throw new Error('broker-instance-invalid');
    }
    return parsed.instanceId;
  }
  if (inspected.status !== 'missing') throw new Error('broker-instance-unsafe');
  const instanceId = `broker_${randomBytes(32).toString('base64url')}`;
  atomicWriteJsonOwnerOnly(path, { version: 1, instanceId } satisfies BrokerInstanceFile);
  return instanceId;
}
