#!/usr/bin/env bun
import assert from 'node:assert/strict';
import type { AgentMessage, AgentMessageHandler, SessionConnection } from '../../../adapter-api/src/index.ts';
import { ManagedConn } from '../../src/sessions/hub.ts';
import {
  ClientMessagePolicyError,
  validatePlanActionRequest,
} from '../../src/sessions/client-message-policy.ts';

let emit: AgentMessageHandler = () => undefined;
const conn: SessionConnection = {
  info: {
    id: 'plan-session',
    tool: 'fake',
    title: 'Fake plan session',
    status: 'idle',
    attachMode: 'live',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  },
  async getHistory() { return []; },
  subscribe(handler) { emit = handler; return () => undefined; },
  async sendPrompt() {},
  async respondPermission() {},
  async close() {},
};

const managed = new ManagedConn(conn);
try {
  managed.observeHistory([{
    type: 'task-list-state',
    key: 'generic',
    title: 'Plan-looking display string',
    sourceTool: 'plan_writer',
    status: 'running',
    items: [{ title: 'Not a semantic plan', status: 'open' }],
  }]);
  assert.equal(managed.currentPlan('generic'), undefined, 'display strings and source names must not create a current plan');

  const proposed: AgentMessage = {
    type: 'task-list-state',
    key: 'panel-key',
    title: 'Native proposal',
    status: 'running',
    semantic: {
      kind: 'plan',
      planKey: 'native-plan-1',
      revision: 'revision-1',
      state: 'proposed',
      actions: { approve: true, edit: true, exit: false },
    },
    items: [{ id: '1', title: 'Inspect', status: 'open' }],
  };
  emit(proposed);
  const current = managed.currentPlan('native-plan-1');
  assert.equal(current, proposed, 'live typed plan evidence should become the current plan');
  assert.equal(validatePlanActionRequest({
    action: 'approve', planKey: 'native-plan-1', planRevision: 'revision-1',
  }, current).action, 'approve');

  const rejects = (
    request: Record<string, unknown>,
    code: ClientMessagePolicyError['code'],
    state = current,
  ) => assert.throws(
    () => validatePlanActionRequest(request, state),
    (error: unknown) => error instanceof ClientMessagePolicyError && error.code === code,
  );
  rejects({ action: 'approve', planKey: 'native-plan-1', planRevision: 'old' }, 'PLAN_ACTION_STALE');
  rejects({ action: 'exit', planKey: 'native-plan-1', planRevision: 'revision-1' }, 'PLAN_ACTION_UNSUPPORTED');
  rejects({ action: 'approve', planKey: 'missing', planRevision: 'revision-1' }, 'PLAN_NOT_FOUND', undefined);
  rejects({ action: 'forged', planKey: 'native-plan-1', planRevision: 'revision-1' }, 'PLAN_ACTION_INVALID');
  rejects({ action: 'edit', planKey: 'native-plan-1', planRevision: 'revision-1', text: '' }, 'PLAN_ACTION_INVALID');
  rejects({
    action: 'approve', planKey: 'native-plan-1', planRevision: 'revision-1', text: 'smuggled prompt',
  }, 'PLAN_ACTION_INVALID');

  emit({
    ...proposed,
    semantic: { ...proposed.semantic!, revision: 'revision-2', state: 'active' },
  });
  rejects({ action: 'approve', planKey: 'native-plan-1', planRevision: 'revision-1' }, 'PLAN_ACTION_STALE', managed.currentPlan('native-plan-1'));
  managed.observeHistory([proposed]);
  assert.equal(managed.currentPlan('native-plan-1')?.semantic?.revision, 'revision-2',
    'an older attach snapshot must not overwrite newer live plan evidence');
} finally {
  await managed.dispose();
}

console.log('PASS typed plan classification, current-state tracking, stale checks, and action availability');
