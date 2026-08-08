import { createHash } from 'node:crypto';
import type { CapabilitySourceLock } from './types.ts';

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sourceIds(lock: CapabilitySourceLock): Set<string> {
  return new Set(lock.sources.map((s) => s.id));
}
