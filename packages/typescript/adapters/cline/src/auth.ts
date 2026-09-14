import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { PromptInput } from '@cosyncing/adapter-api';

const MAX_PROVIDER_FILE_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 4_096;
const MEASURED_ACP_PROVIDER = 'openai-compatible';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function field(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

async function explicitAuthFile(path: string): Promise<Record<string, unknown> | undefined> {
  if (!isAbsolute(path)) return undefined;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROVIDER_FILE_BYTES) return undefined;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined;
    if ((stat.mode & 0o077) !== 0) return undefined;
    const bytes = Buffer.alloc(MAX_PROVIDER_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead <= 0 || bytesRead > MAX_PROVIDER_FILE_BYTES) return undefined;
    const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown;
    return record(parsed);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface ClineAcpEnvironment {
  env: NodeJS.ProcessEnv;
  provider: string;
  model: string;
  source: 'environment' | 'auth-file';
}

/**
 * Resolve the physically measured Cline 3.0.60 ACP API-key gate. The secret is
 * placed only in the official child environment; callers must never log `env`.
 */
export async function resolveClineAcpEnvironment(options: {
  env: NodeJS.ProcessEnv;
  model?: PromptInput['model'];
}): Promise<ClineAcpEnvironment | undefined> {
  const configuredProvider = field(options.env.CLINE_PROVIDER, 256);
  const configuredKey = field(options.env.CLINE_API_KEY);
  const configuredModel = field(options.env.CLINE_MODEL, 512);
  const hasExplicitEnvironment = Object.hasOwn(options.env, 'CLINE_PROVIDER')
    || Object.hasOwn(options.env, 'CLINE_API_KEY')
    || Object.hasOwn(options.env, 'CLINE_MODEL');
  const requestedProvider = options.model?.providerID ?? configuredProvider
    ?? MEASURED_ACP_PROVIDER;
  if (requestedProvider !== MEASURED_ACP_PROVIDER) return undefined;

  const environmentModel = options.model?.modelID ?? configuredModel;
  if (hasExplicitEnvironment) {
    if (!configuredKey || !environmentModel) return undefined;
    return {
      env: {
        ...options.env,
        CLINE_PROVIDER: MEASURED_ACP_PROVIDER,
        CLINE_MODEL: environmentModel,
        CLINE_API_KEY: configuredKey,
      },
      provider: MEASURED_ACP_PROVIDER,
      model: environmentModel,
      source: 'environment',
    };
  }

  const authPath = field(options.env.COSYNCING_CLINE_AUTH_FILE, 32_768);
  if (!authPath) return undefined;
  const auth = await explicitAuthFile(authPath);
  const provider = field(auth?.provider, 256);
  const apiKey = field(auth?.apiKey);
  const model = options.model?.modelID ?? field(auth?.model, 512);
  if (provider !== MEASURED_ACP_PROVIDER || !apiKey || !model) return undefined;
  return {
    env: {
      ...options.env,
      CLINE_PROVIDER: provider,
      CLINE_MODEL: model,
      CLINE_API_KEY: apiKey,
    },
    provider,
    model,
    source: 'auth-file',
  };
}
