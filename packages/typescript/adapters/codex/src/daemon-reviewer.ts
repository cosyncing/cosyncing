import { join, resolve } from 'node:path';
import type { SetupCheck, SetupDiagnosisContext } from '@cosyncing/adapter-api';

/** The reviewer uses the process startup ModelManager, not a thread's catalog override. */
export function codexDaemonReviewerCheck(context: SetupDiagnosisContext, home: string): SetupCheck {
  const readConfig = (file: string): Record<string, unknown> => {
    const read = context.readText(join(home, file), 4 * 1024 * 1024);
    if (!read.ok) return {};
    try { return Bun.TOML.parse(read.text) as Record<string, unknown>; } catch { return {}; }
  };
  const base = readConfig('config.toml');
  let models: any[] = [];
  if (typeof base.model_catalog_json === 'string') {
    const read = context.readText(resolve(home, base.model_catalog_json), 32 * 1024 * 1024);
    if (read.ok) {
      try {
        const catalog = JSON.parse(read.text);
        models = Array.isArray(catalog.models) ? catalog.models : [];
      } catch { /* an unreadable catalog cannot prove reviewer support */ }
    }
  }
  let profiles: string[] = [];
  try {
    const directory = context.listDirectory(home, 256);
    if (directory.ok) profiles = directory.names.filter((name) => name.endsWith('.config.toml')).sort().slice(0, 128);
  } catch { /* a missing or unreadable home cannot enumerate profiles */ }
  const affected: string[] = [];
  const configurations = [
    { label: 'config.toml', effective: base },
    ...profiles.map((file) => ({
      label: file.slice(0, -'.config.toml'.length),
      effective: { ...base, ...readConfig(file) },
    })),
  ];
  for (const { label, effective } of configurations) {
    if ((effective.model_provider ?? 'openai') === 'openai' || effective.approvals_reviewer !== 'auto_review') continue;
    const model = typeof effective.model === 'string' ? effective.model : '(default model)';
    const hasReviewer = models.some((entry) =>
      (entry?.slug ?? entry?.id ?? entry?.model) === model
      && typeof entry?.auto_review_model_override === 'string'
      && entry.auto_review_model_override.trim());
    if (hasReviewer) continue;
    affected.push(`${label} (${model})`);
  }
  return affected.length ? {
    id: 'codex.daemon-reviewer', status: 'warn', detailCode: 'daemon-reviewer-catalog-missing',
    summary: `Codex auto-review cannot use these non-OpenAI models from the daemon startup catalog: ${affected.join(', ')}.`,
    remediation: { kind: 'manual', message: 'Add each model with auto_review_model_override to the merged catalog selected by model_catalog_json in base config.toml, then restart Codex while idle. Or set approvals_reviewer = "user" in config.toml or the profile, or select Ask permission in the app. See the Codex profile guide; regenerate the catalog after Codex updates.' },
  } : {
    id: 'codex.daemon-reviewer', status: 'pass', detailCode: 'daemon-reviewer-catalog-ready',
    summary: 'Non-OpenAI auto-review configurations have a reviewer override in the daemon startup catalog, or no such configuration requires one.',
  };
}
