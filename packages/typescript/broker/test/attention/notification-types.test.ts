/**
 * The notification type and collapse slot the broker serves with each attention event, checked
 * against the case file the client's own test reads (`contracts/fixtures/attention-notification-types.json`),
 * so broker and client cannot disagree about which alert replaces which.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttentionEvent } from '@cosyncing/protocol';
import {
  attentionNotificationCollapseKey,
  attentionNotificationType,
} from '../../src/attention/attention-notification-type.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../../../../contracts/fixtures/attention-notification-types.json'), 'utf8')) as {
  cases: Array<{ name: string; event: AttentionEvent; notificationType: string | null; collapseKey: string | null }>;
};

test('the shared case file is loaded', () => {
  expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
});

test.each(fixture.cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
  const type = attentionNotificationType(item.event);
  const served: string | null = type ?? null;
  expect(served).toBe(item.notificationType);
  expect(type === undefined ? null : attentionNotificationCollapseKey(item.event, type)).toBe(item.collapseKey);
});
