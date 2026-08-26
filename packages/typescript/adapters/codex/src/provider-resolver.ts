/**
 * Codex model-provider resolution — the one fact that gates Drive parity for `codex -p <profile>`
 * sessions.
 *
 * A codex profile is an OVERLAY FILE, not a config section: `-p vllm-hpc` layers
 * `$CODEX_HOME/vllm-hpc.config.toml` on top of the base `$CODEX_HOME/config.toml`
 * (`codex --help`, 0.149.0). A `[model_providers.<name>]` table that lives only inside such an
 * overlay is invisible to a broker-spawned `codex app-server`, which loads the base config alone —
 * so `thread/resume` refuses the session with ``Model provider `vllm-hpc` not found`` and the row
 * can never be anything but Observe.
 *
 * `thread/start` and `thread/resume` both take a free-form per-thread `config` override, and a
 * `model_providers` table supplied there makes the provider resolvable (probed against 0.149.0).
 * This module answers where a provider is defined so the caller knows whether to inject:
 *
 *   - `base`    — the app-server already resolves it. NEVER inject: the override would be a no-op
 *                 that also puts a credential on a wire that does not need one.
 *   - `profile` — defined only in an overlay. Inject the definition at start/resume.
 *   - absent    — `undefined`. The caller leaves the session honestly Observe rather than resuming
 *                 it onto the process default provider, where the first turn would silently run
 *                 against the wrong endpoint.
 *
 * Parsing is `Bun.TOML.parse` (the broker already runs on Bun, so this adds no dependency). A
 * hand-rolled scanner would have to get inline tables, dotted keys and string escapes right for
 * fields like `http_headers` — real risk, no benefit.
 *
 * CREDENTIAL HYGIENE: a provider definition can carry a bearer token (`http_headers.Authorization`,
 * `env_key`). It rides only the local stdio/unix socket to a broker-spawned process; rollouts never
 * record it (verified on a probe rollout: provider name present, token absent). It must never reach
 * diagnostics or an attach error message — callers hand the resolved definition to the diagnostic
 * redactor, which collects every string leaf.
 */
import { homedir } from 'node:os';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** A `[model_providers.<name>]` table exactly as codex wrote it — passed through verbatim. */
export type CodexProviderDefinition = Record<string, unknown>;

export type CodexProviderSource = 'base' | 'profile';

export type CodexProviderResolution = {
  name: string;
  definition: CodexProviderDefinition;
  source: CodexProviderSource;
  /** Basename of the file the definition came from (`config.toml` / `<profile>.config.toml`). */
  file: string;
};

export type CodexProviderLookupOptions = {
  /** Defaults to `$CODEX_HOME` (or `~/.codex`), read per call so a fixture home is testable. */
  codexHome?: string;
};

/** Real profile overlays are a few KB. The cap keeps a stray large file from being read per attach. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_CATALOG_MODELS = 512;
/** Bound the overlay scan: a home with thousands of `.config.toml` files is a mistake, not a case. */
const MAX_PROFILE_FILES = 128;
const PROFILE_SUFFIX = '.config.toml';
const BASE_CONFIG = 'config.toml';
const MODEL_CACHE = 'models_cache.json';

export interface CodexModelCatalogSource {
  /** `undefined` is Codex's own OpenAI model cache or an unprofiled base catalog. */
  profile?: string;
  providerID: string;
  /** Product-facing provider/profile name. `providerID` remains the exact native wire value. */
  providerLabel?: string;
  models: unknown[];
}

export function codexHomeDir(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * Where is `name` defined? Base config wins over every overlay — that is codex's own layering, and
 * it is what makes "already resolvable, do not inject" decidable. Overlays are visited in sorted
 * order so two profiles defining the same provider resolve deterministically.
 */
export function resolveCodexModelProvider(
  name: string | undefined,
  options: CodexProviderLookupOptions = {},
): CodexProviderResolution | undefined {
  const provider = typeof name === 'string' ? name.trim() : '';
  if (!provider) return undefined;
  const home = options.codexHome?.trim() || codexHomeDir();

  const baseDefinition = providerTable(parseTomlFile(join(home, BASE_CONFIG)), provider);
  if (baseDefinition) return { name: provider, definition: baseDefinition, source: 'base', file: BASE_CONFIG };

  for (const file of profileFiles(home)) {
    const definition = providerTable(parseTomlFile(join(home, file)), provider);
    if (definition) return { name: provider, definition, source: 'profile', file };
  }
  return undefined;
}

/**
 * The `config` override to attach to `thread/start` / `thread/resume`, or `undefined` when nothing
 * should be sent — either the base config already resolves the provider, or nobody defines it.
 */
export function codexProviderConfigOverride(
  name: string | undefined,
  options: CodexProviderLookupOptions = {},
): { model_providers: Record<string, CodexProviderDefinition> } | undefined {
  const resolved = resolveCodexModelProvider(name, options);
  if (!resolved || resolved.source !== 'profile') return undefined;
  return { model_providers: { [resolved.name]: resolved.definition } };
}

/**
 * Profile/catalog/provider material needed by `thread/start` and `thread/resume`.
 *
 * The shared daemon loads only `config.toml`. A profile may supply both a provider and a model
 * catalog, and injecting only the former still lets Codex replace an unknown requested model with
 * the provider default. Keep the two parts together so the native model validation sees the same
 * profile the terminal did.
 */
export function codexThreadConfigOverride(
  providerID: string | undefined,
  modelID: string | undefined,
  profile: string | undefined,
  options: CodexProviderLookupOptions = {},
): Record<string, unknown> | undefined {
  const provider = providerID?.trim();
  const model = modelID?.trim();
  if (!provider) return undefined;
  const home = options.codexHome?.trim() || codexHomeDir();
  const selected = resolveCodexProfile(provider, model, profile, { codexHome: home });
  const baseDefinesProvider = !!providerTable(parseTomlFile(join(home, BASE_CONFIG)), provider);
  const selectedDefinition = selected
    ? providerTable(parseTomlFile(join(home, selected.file)), provider)
    : undefined;
  const providerOverride = !baseDefinesProvider && selectedDefinition
    ? { model_providers: { [provider]: selectedDefinition } }
    : codexProviderConfigOverride(provider, { codexHome: home });
  const result: Record<string, unknown> = { ...(providerOverride ?? {}) };
  if (selected?.catalogPath) result.model_catalog_json = selected.catalogPath;
  return Object.keys(result).length ? result : undefined;
}

export interface CodexProfileResolution {
  name: string;
  file: string;
  providerID: string;
  configuredModel?: string;
  catalogPath?: string;
}

/** Resolve the profile that owns an exact provider/model selection. */
export function resolveCodexProfile(
  providerID: string | undefined,
  modelID?: string,
  preferredProfile?: string,
  options: CodexProviderLookupOptions = {},
): CodexProfileResolution | undefined {
  const provider = providerID?.trim();
  if (!provider) return undefined;
  const home = options.codexHome?.trim() || codexHomeDir();
  const base = parseTomlFile(join(home, BASE_CONFIG)) ?? {};
  const preferred = preferredProfile?.trim();
  const candidates: Array<
    CodexProfileResolution & { exactDefault: boolean; catalogMatch: boolean }
  > = [];
  for (const file of profileFiles(home)) {
    const overlay = parseTomlFile(join(home, file));
    if (!overlay) continue;
    const name = file.slice(0, -PROFILE_SUFFIX.length);
    const effectiveProvider = stringField(overlay.model_provider) ?? stringField(base.model_provider) ?? 'openai';
    if (effectiveProvider !== provider) continue;
    const configuredModel = stringField(overlay.model) ?? stringField(base.model);
    const catalogPath = profileCatalogPathFrom(home, name, overlay, base).path;
    const exactDefault = !!modelID && configuredModel === modelID;
    const catalogMatch = !!modelID && !!catalogPath && catalogHasModel(catalogPath, modelID);
    if (preferred && name !== preferred) continue;
    if (!modelID || exactDefault || catalogMatch) {
      candidates.push({
        name,
        file,
        providerID: provider,
        configuredModel,
        catalogPath,
        exactDefault,
        catalogMatch,
      });
    }
  }
  const selected = candidates.sort(
    (a, b) =>
      Number(b.exactDefault) - Number(a.exactDefault) ||
      Number(b.catalogMatch) - Number(a.catalogMatch) ||
      a.name.localeCompare(b.name),
  )[0];
  if (!selected) return undefined;
  const { exactDefault: _exactDefault, catalogMatch: _catalogMatch, ...resolution } = selected;
  return resolution;
}

/** Whether the unprofiled app-server is replacing Codex's built-in picker catalog. */
export function codexBaseHasCustomModelCatalog(options: CodexProviderLookupOptions = {}): boolean {
  const home = options.codexHome?.trim() || codexHomeDir();
  return !!stringField(parseTomlFile(join(home, BASE_CONFIG))?.model_catalog_json);
}

/**
 * Exact model sources configured on this Codex home.
 *
 * `models_cache.json` is Codex's own authenticated OpenAI catalog and remains available even when
 * `model_catalog_json` replaces the app-server's picker. Profile catalogs are attributed to their
 * effective provider. When several profiles inherit one merged base catalog, only each profile's
 * configured default is attributable; stamping every entry with every provider recreates the
 * cross-profile mixing this function exists to prevent.
 */
export function codexModelCatalogSources(
  options: CodexProviderLookupOptions = {},
): CodexModelCatalogSource[] {
  const home = options.codexHome?.trim() || codexHomeDir();
  const base = parseTomlFile(join(home, BASE_CONFIG)) ?? {};
  const out: CodexModelCatalogSource[] = [];
  const cached = readJsonModels(join(home, MODEL_CACHE));
  if (cached.length) out.push({ providerID: 'openai', providerLabel: 'Default', models: cached });

  const baseCatalog = catalogPathFrom(home, base);
  const profiles: Array<CodexProfileResolution & { profileSpecificCatalog: boolean }> = [];
  for (const file of profileFiles(home)) {
    const overlay = parseTomlFile(join(home, file));
    if (!overlay) continue;
    const name = file.slice(0, -PROFILE_SUFFIX.length);
    const providerID = stringField(overlay.model_provider) ?? stringField(base.model_provider) ?? 'openai';
    const configuredModel = stringField(overlay.model) ?? stringField(base.model);
    const catalog = profileCatalogPathFrom(home, name, overlay, base);
    profiles.push({
      name,
      file,
      providerID,
      configuredModel,
      catalogPath: catalog.path,
      profileSpecificCatalog: catalog.profileSpecific,
    });
  }

  const baseProvider = stringField(base.model_provider);
  // A custom base catalog is commonly a provider-agnostic merged catalog used to make several
  // profile models visible to Codex. With profiles present and no explicit base provider, stamping
  // every merged entry as OpenAI recreates the exact cross-provider mislabelling this resolver avoids.
  if (baseCatalog && (baseProvider || profiles.length === 0)) {
    const models = readJsonModels(baseCatalog);
    if (models.length) {
      const providerID = baseProvider ?? 'openai';
      out.push({
        providerID,
        providerLabel: providerID === 'openai' ? 'Default' : providerID,
        models,
      });
    }
  }

  for (const profile of profiles) {
    let models = profile.catalogPath ? readJsonModels(profile.catalogPath) : [];
    if (!profile.profileSpecificCatalog && profile.catalogPath === baseCatalog) {
      models = profile.configuredModel
        ? models.filter((entry) => catalogModelID(entry) === profile.configuredModel)
        : [];
    }
    if (!models.length && profile.configuredModel) {
      models = [{ id: profile.configuredModel, model: profile.configuredModel, displayName: profile.configuredModel }];
    }
    if (models.length) {
      out.push({
        profile: profile.name,
        providerID: profile.providerID,
        providerLabel: profile.name,
        models,
      });
    }
  }
  return out;
}

/** Overlay files only: `config.toml` is 11 chars and cannot end with the 12-char profile suffix. */
function profileFiles(home: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(home, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(PROFILE_SUFFIX))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort().slice(0, MAX_PROFILE_FILES);
}

/**
 * A malformed or oversized file yields `undefined`, never a partial table: half a provider
 * definition on the wire is worse than an honest Observe row.
 */
function parseTomlFile(path: string): Record<string, unknown> | undefined {
  const toml = (globalThis as { Bun?: { TOML?: { parse(text: string): unknown } } }).Bun?.TOML;
  if (!toml) return undefined; // non-Bun runtime: degrade to "provider not resolvable"
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return undefined;
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = toml.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function catalogPathFrom(
  home: string,
  primary: Record<string, unknown>,
  fallback?: Record<string, unknown>,
): string | undefined {
  const raw = stringField(primary.model_catalog_json) ?? stringField(fallback?.model_catalog_json);
  if (!raw) return undefined;
  return isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
}

/**
 * A profile's own catalog wins over the merged base catalog. Codex users commonly keep conventional
 * `$CODEX_HOME/model-catalogs/<profile>.json` files even when an overlay omits the pointer (for
 * example after promoting a merged catalog into base config). Recognizing that exact filename is
 * deterministic and restores the full profile roster without guessing ownership inside the merge.
 */
function profileCatalogPathFrom(
  home: string,
  profile: string,
  overlay: Record<string, unknown>,
  base: Record<string, unknown>,
): { path?: string; profileSpecific: boolean } {
  const explicit = catalogPathFrom(home, overlay);
  if (explicit) return { path: explicit, profileSpecific: true };
  const conventional = resolve(home, 'model-catalogs', `${profile}.json`);
  if (readJsonModels(conventional).length) {
    return { path: conventional, profileSpecific: true };
  }
  return { path: catalogPathFrom(home, base), profileSpecific: false };
}

function readJsonModels(path: string): unknown[] {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const models = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    return models.slice(0, MAX_CATALOG_MODELS);
  } catch {
    return [];
  }
}

function catalogModelID(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return stringField(row.model) ?? stringField(row.id) ?? stringField(row.slug);
}

function catalogHasModel(path: string, modelID: string): boolean {
  return readJsonModels(path).some((entry) => catalogModelID(entry) === modelID);
}

function providerTable(config: Record<string, unknown> | undefined, name: string): CodexProviderDefinition | undefined {
  const providers = config?.model_providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
  const definition = (providers as Record<string, unknown>)[name];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return undefined;
  return definition as CodexProviderDefinition;
}
