import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error Bun's text loader embeds the Markdown source in source and packaged builds.
import agentSkillModule from '../skills/cosyncing.md' with { type: 'text' };
import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import { inspectOwnerOnlyFile } from './secure-files.ts';

export const AGENT_SKILL_SOURCE = agentSkillModule as unknown as string;
export const AGENT_SKILL_SHA256 = createHash('sha256')
  .update(AGENT_SKILL_SOURCE)
  .digest('hex');

export const AGENT_SKILL_RESOURCE_IDS = {
  claude: 'agent-skill-claude',
  agents: 'agent-skill-agents',
} as const;

export type AgentSkillTargetId = keyof typeof AGENT_SKILL_RESOURCE_IDS;

export interface AgentSkillTarget {
  id: AgentSkillTargetId;
  resourceId: (typeof AGENT_SKILL_RESOURCE_IDS)[AgentSkillTargetId];
  path: string;
}

export type AgentSkillInspection = AgentSkillTarget & {
  status: 'missing' | 'owned' | 'drifted' | 'unsafe' | 'unreadable';
  actualSha256?: string;
};

/** Resolve the two native discovery roots, with fixture-only overrides carried by the diagnosis context. */
export function agentSkillTargets(context: Pick<SetupDiagnosisContext, 'homeDir' | 'env'>): AgentSkillTarget[] {
  const claudeRoot = context.env.COSYNCING_CLAUDE_SKILLS_DIR?.trim()
    || join(context.homeDir, '.claude', 'skills');
  const agentsRoot = context.env.COSYNCING_AGENTS_SKILLS_DIR?.trim()
    || join(context.homeDir, '.agents', 'skills');
  return [
    {
      id: 'claude',
      resourceId: AGENT_SKILL_RESOURCE_IDS.claude,
      path: join(claudeRoot, 'cosyncing', 'SKILL.md'),
    },
    {
      id: 'agents',
      resourceId: AGENT_SKILL_RESOURCE_IDS.agents,
      path: join(agentsRoot, 'cosyncing', 'SKILL.md'),
    },
  ];
}

export function inspectAgentSkill(target: AgentSkillTarget): AgentSkillInspection {
  const file = inspectOwnerOnlyFile(target.path);
  if (file.status !== 'ok') return { ...target, status: file.status };
  try {
    const actualSha256 = createHash('sha256').update(readFileSync(target.path)).digest('hex');
    return {
      ...target,
      status: actualSha256 === AGENT_SKILL_SHA256 ? 'owned' : 'drifted',
      actualSha256,
    };
  } catch {
    return { ...target, status: 'unreadable' };
  }
}

export function inspectAgentSkills(
  context: Pick<SetupDiagnosisContext, 'homeDir' | 'env'>,
): AgentSkillInspection[] {
  return agentSkillTargets(context).map(inspectAgentSkill);
}
