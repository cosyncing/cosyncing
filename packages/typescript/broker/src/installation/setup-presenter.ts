import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
} from '@clack/prompts';
import {
  SETUP_PROMPT_CANCELLED,
  tokdashProvisionCapability,
  type SetupAccessReport,
  type SetupAgentSummary,
  type SetupCommandResult,
  type SetupInspection,
  type SetupPlan,
  type SetupPresenter,
  type SetupPromptResult,
  type SetupServiceChoice,
} from './setup.ts';
import { brokerTokenPath } from '../security/credentials.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import {
  DEFAULT_SETUP_LANGUAGE,
  normalizeSetupLanguage,
  setupLanguageFromEnv,
  setupMessages,
  SETUP_LANGUAGE_OPTIONS,
  type SetupLanguage,
  type SetupMessages,
} from './setup-i18n.ts';
import { resolveTokdashEndpoint, tokdashRejectionReason } from './tokdash-quota.ts';
import { APP_PATH, browserClientUrl } from '../transport/http-contracts.ts';

export interface SetupOutputWriter {
  write(text: string): void;
}

/**
 * The outro: where this install lives, what the operator can open right now, and where the shared token is.
 *
 * Every line is derived from {@link SetupAccessReport}, which the applied plan produced — setup never prints
 * a URL it did not just make true. Three rules the physical audit forced:
 *   - No LAN address. The broker binds `config.broker.host`, which setup only writes as 127.0.0.1, so an
 *     auto-detected 192.168.x.x URL would name an endpoint nothing listens on.
 *   - The `/cosy` URL is printed even when the build ships no Flutter bundle (R16). R10 withheld it because
 *     it answered "not built"; that page now names the product and gives the pairing command, so the URL is
 *     a true onward step rather than a dead end. Only the wording differs between the two builds.
 *   - The token appears as a path and a read command, never as a value, so this output stays safe to paste
 *     into a bug report or a screen share.
 */
/** Tag, not prefix-matching: the `--yes` path labels each line from this, so translated copy cannot break
 *  the machine-readable shape that consumers of that output already parse. */
type OutroEntry = { tag: 'access' | 'credential'; text: string };

function outroEntries(access: Readonly<SetupAccessReport>, text: SetupMessages): OutroEntry[] {
  const tokenPath = brokerTokenPath(access.stateHome);
  const entries: OutroEntry[] = [{ tag: 'access', text: text.outroStateDirectory(access.stateHome) }];
  const push = (tag: OutroEntry['tag'], value: string): void => { entries.push({ tag, text: value }); };
  // A URL nothing answers on is worse than no URL: it reads as a broken install rather than an unstarted
  // one. Only the durable-service path ends with a health-verified listener, so a foreground install is told
  // to start the broker first, and every "open" line below becomes a "then open" line.
  if (!access.brokerListening) push('access', text.outroStartBroker(PRODUCT_IDENTITY.primaryBinary));
  // One URL either way. What it opens differs — the app, or the page that explains pairing — so the
  // wording does too, but a build with no Flutter bundle no longer withholds the address of the thing the
  // operator just installed.
  if (!access.webApp) push('access', text.outroPairInstead(PRODUCT_IDENTITY.primaryBinary));
  const here = browserClientUrl(access.loopbackUrl);
  push('access', access.webApp
    ? (access.brokerListening ? text.outroOpenHere(here) : text.outroOpenHereAfterStart(here))
    : (access.brokerListening ? text.outroPairPageHere(here) : text.outroPairPageHereAfterStart(here)));
  push('access', text.outroLocalServerAddress(access.loopbackUrl));
  if (access.tailscaleUrl) {
    const tailnet = browserClientUrl(access.tailscaleUrl);
    push('access', access.webApp
      ? (access.brokerListening ? text.outroOpenTailnet(tailnet) : text.outroOpenTailnetAfterStart(tailnet))
      : (access.brokerListening ? text.outroPairPageTailnet(tailnet) : text.outroPairPageTailnetAfterStart(tailnet)));
    push('access', text.outroTailnetServerAddress(access.tailscaleUrl));
  }
  if (!access.tailscaleUrl) push('access', text.outroLoopbackOnly);
  push('access', text.outroShortCommand(PRODUCT_IDENTITY.aliasBinary, [
    `${PRODUCT_IDENTITY.aliasBinary} status`,
    `${PRODUCT_IDENTITY.aliasBinary} doctor`,
    `${PRODUCT_IDENTITY.aliasBinary} update`,
  ]));
  push('credential', text.outroTokenRead(tokenPath));
  if (access.webApp) push('credential', text.outroTokenSignIn(APP_PATH));
  push('credential', text.outroPreferPairing(PRODUCT_IDENTITY.primaryBinary));
  return entries;
}

/**
 * What the Tokdash step did, or nothing at all when consent was off.
 *
 * The URL comes off the outcome, not from re-reading the environment: it names the endpoint that was
 * actually probed and provisioned, so the report cannot describe a different one than the run used.
 */
function quotaNotice(result: Readonly<SetupCommandResult>, text: SetupMessages): string | undefined {
  const outcome = result.tokdash;
  switch (outcome?.status) {
    case 'reused': return text.quotaReused(outcome.baseUrl);
    // The ownership record is what says whether a package was installed, so the report agrees with the
    // prompt case that applied rather than restating the most common one.
    case 'provisioned': return text.quotaProvisioned(outcome.baseUrl, outcome.ownership.installedByBroker);
    case 'unavailable': return outcome.reason === 'endpoint-unsupported'
      ? text.quotaEndpointUnsupported(outcome.baseUrl)
      : text.quotaProvisionFailed(outcome.detail);
    default: return undefined;
  }
}

/**
 * The footer sentence in the wizard's language. `result.summary` carries the English rendering of the same
 * code and stays on the result, because that is what `--yes` prints and what a bug report quotes.
 * `cancelled` never reaches here — the cancel path has its own copy, with the stage interpolated.
 */
function resultSummary(result: Readonly<SetupCommandResult>, text: SetupMessages): string {
  return text.resultSummary(result.summaryCode, { binary: PRODUCT_IDENTITY.primaryBinary, stage: '' });
}

/**
 * "unsupported" on its own is not a finding, it is a riddle — a physical audit asked what it meant. The line
 * that reports it must carry the detected version, the floor it missed, and the command that clears it.
 */
function unsupportedReason(agent: Readonly<SetupAgentSummary>, text: SetupMessages): string {
  return text.unsupportedReason({
    detected: agent.installedVersion
      ? text.unsupportedDetected(agent.installedVersion)
      : text.unsupportedVersionUnreadable,
    displayName: agent.displayName,
    minimumVersion: agent.minimumVersion,
    upgrade: agent.upgradeCommand ? text.unsupportedUpgrade(agent.upgradeCommand) : '',
  });
}

export function agentPreflightLines(
  agents: readonly SetupAgentSummary[],
  language: SetupLanguage = DEFAULT_SETUP_LANGUAGE,
): string {
  const text = setupMessages(language);
  return agents.map((agent) => {
    const version = agent.installedVersion ? ` ${agent.installedVersion}` : '';
    const reason = agent.state === 'unsupported' ? unsupportedReason(agent, text) : '';
    const runtimeReason = agent.runtimeUnavailable
      ? text.runtimeUnavailableReason(agent.runtimeUnavailable)
      : '';
    // The state word and the managed-behavior sentence are copy, not identifiers. `agent.managedBehavior`
    // stays on the summary as the English record every machine-readable surface carries; the panel renders
    // the catalog's, or a Chinese wizard printed "○ Codex: missing / Managed shared app-server; …".
    const marker = agent.state === 'supported' ? '✓' : agent.state === 'missing' ? '○' : '!';
    const warning = agent.managedRuntimeWarning
      ? `\n  ${text.codexStandaloneWarning(agent.managedRuntimeWarning.command)}`
      : '';
    return `${marker} ${agent.displayName}${version}: ${text.agentState(agent.state)}${reason}${runtimeReason}`
      + `\n  ${text.agentBehavior(agent.id)}${warning}`;
  }).join('\n');
}

function cancelled<T>(value: T | symbol): SetupPromptResult<T> {
  return isCancel(value) ? SETUP_PROMPT_CANCELLED : value as T;
}

export function createClackSetupPresenter(): SetupPresenter {
  // Set by the first prompt and read by every surface after it. Until the operator answers, the wizard has
  // nothing on screen to translate, which is why language selection has to come before the intro panels.
  let language: SetupLanguage = DEFAULT_SETUP_LANGUAGE;
  const text = (): SetupMessages => setupMessages(language);
  return {
    async chooseLanguage(inspection): Promise<SetupPromptResult<SetupLanguage>> {
      const stored = normalizeSetupLanguage(inspection.setupState.language) ?? DEFAULT_SETUP_LANGUAGE;
      const value = await select<SetupLanguage>({
        // Bilingual on purpose: this one prompt is read by someone who has not chosen a language yet.
        message: setupMessages('zh-Hans').languagePrompt,
        options: [...SETUP_LANGUAGE_OPTIONS],
        initialValue: stored,
      });
      if (!isCancel(value)) language = value;
      return cancelled(value);
    },
    intro(inspection): void {
      intro(text().introTitle(PRODUCT_IDENTITY.productName));
      note(
        text().installationBody({
          version: inspection.version,
          install: inspection.installLocation,
          state: inspection.stateHome,
          broker: inspection.targetConfig.broker.internalUrl,
        }),
        text().installationTitle,
      );
      note(agentPreflightLines(inspection.agents, language), text().agentPreflightTitle);
      const external = inspection.targetConfig.broker.advertisedUrl
        ? text().networkAuthenticated(inspection.targetConfig.broker.advertisedUrl)
        : inspection.tailscale.advertisedUrl
          ? text().networkServeAvailable(inspection.tailscale.advertisedUrl)
          : text().networkLoopback(inspection.tailscale.summary);
      note(external, text().networkTitle);
    },
    showBlockers(issues): void {
      for (const issue of issues) {
        const rendered = issue.localized?.[language] ?? issue;
        log.error(text().blocker({ summary: rendered.summary, remediation: rendered.remediation }));
      }
    },
    async confirmManagedRuntime(): Promise<SetupPromptResult<boolean>> {
      note(text().managedRuntimeBody(PRODUCT_IDENTITY.productName), text().managedRuntimeTitle);
      return cancelled(await confirm({
        message: text().managedRuntimeConfirm(PRODUCT_IDENTITY.productName),
        initialValue: true,
      }));
    },
    async confirmLegacyPiBridge(inspection): Promise<SetupPromptResult<boolean>> {
      return cancelled(await confirm({
        message: text().legacyPiBridgeConfirm(inspection.piBridge.path),
        initialValue: false,
      }));
    },
    async confirmAgentSkill(inspection): Promise<SetupPromptResult<boolean>> {
      return cancelled(await confirm({
        message: text().agentSkillConfirm,
        initialValue: inspection.setupState.agentSkillRequested !== false,
      }));
    },
    async confirmLegacyAgentSkill(inspection): Promise<SetupPromptResult<boolean>> {
      return cancelled(await confirm({
        message: text().legacyAgentSkillConfirm(
          inspection.agentSkills
            .filter((target) => target.status === 'known-legacy')
            .map((target) => target.path)
            .join(', '),
        ),
        // Defaults Yes because this prompt only ever describes skills whose bytes match a published
        // predecessor EXACTLY — declining leaves a stale skill behind and ends setup, which is the wrong
        // default for the one case with nothing to lose. Drifted, unknown, and unreadable skills never
        // reach this question: they are blocking issues that fail closed and are never overwritten.
        initialValue: true,
      }));
    },
    async confirmOpencodeShim(inspection): Promise<SetupPromptResult<boolean>> {
      return cancelled(await confirm({
        message: text().opencodeShimConfirm,
        initialValue: inspection.setupState.opencodeShimRequested !== false,
      }));
    },
    async chooseService(inspection): Promise<SetupPromptResult<SetupServiceChoice>> {
      const provider = inspection.durableServiceProvider;
      const value = await select<SetupServiceChoice>({
        message: text().serviceQuestion,
        options: [
          {
            value: 'foreground',
            label: text().serviceForegroundLabel,
            hint: text().serviceForegroundHint(PRODUCT_IDENTITY.primaryBinary),
          },
          {
            value: provider,
            label: text().serviceDurableLabel(provider),
            hint: text().serviceDurableHint({ provider, available: inspection.systemdAvailable }),
            disabled: !inspection.systemdAvailable,
          },
        ],
        // The persistent service is the recommended shape; foreground stays one keystroke away.
        initialValue: inspection.systemdAvailable ? provider : 'foreground',
      });
      if (!isCancel(value) && value === 'launchd') log.info(text().launchdSessionNote);
      return cancelled(value);
    },
    async confirmTailscale(inspection): Promise<SetupPromptResult<boolean>> {
      if (!inspection.tailscaleAvailable) {
        log.info(text().tailscaleUnavailableNote);
        return false;
      }
      // The MagicDNS name is already on screen in the Network panel, so the prompt can name the URL this
      // route produces rather than the mechanism. `tailscaleAvailable` implies a resolved name; the fallback
      // is only so a hypothetical inspection without one cannot render `undefined/cosy`.
      return cancelled(await confirm({
        message: text().tailscaleConfirm(
          browserClientUrl(inspection.tailscale.advertisedUrl ?? inspection.tailscale.desiredTarget),
        ),
        initialValue: inspection.setupState.tailscaleServeRequested !== false,
      }));
    },
    async confirmQuotaWarnings(inspection): Promise<SetupPromptResult<boolean>> {
      // Same resolver, same variable, same process as the setup run this prompt belongs to, so the URL
      // consented to here is the one that gets provisioned and polled. A refused override says so first:
      // consenting to "quota from 55423" while having asked for another port is not informed consent.
      const endpoint = resolveTokdashEndpoint(process.env.COSYNCING_TOKDASH_URL);
      // The reason, never the refused value: an override can carry a credential, and this line is read on
      // screen and pasted into bug reports.
      if (endpoint.rejected) log.warn(text().quotaUrlRejected(endpoint.rejected, endpoint.baseUrl));
      log.info(text().quotaNote(endpoint.baseUrl, tokdashProvisionCapability(inspection)));
      return cancelled(await confirm({
        message: text().quotaConfirm,
        initialValue: inspection.setupState.quotaWarningsEnabled !== false,
      }));
    },
    showPlan(plan): void {
      // The plan is what the operator is being asked to consent to, so it is rendered in their language from
      // the structured steps. Paths, unit names, URLs, and commands inside each row are interpolated
      // verbatim — they are what gets typed and searched for. `plan.mutationSummary` keeps the English
      // rendering of the same steps for the receipts, the journal, and `--yes`.
      const rows = plan.mutationSteps.length
        ? plan.mutationSteps.map((step, index) => `${index + 1}. ${text().planStep(step)}`).join('\n')
        : text().planEmpty;
      note(rows, text().planTitle);
    },
    async confirmApply(): Promise<SetupPromptResult<boolean>> {
      return cancelled(await confirm({ message: text().applyConfirm, initialValue: true }));
    },
    recoveredInterruptedTransaction(persisted): void {
      // This is the one surface that runs before the language prompt, so it renders in the language the
      // previous run persisted — the run that wrote the journal being rolled back — and seeds the prompt
      // below with it rather than flashing an English warning at a Chinese operator.
      language = persisted;
      log.warn(text().recoveredNote);
    },
    complete(result): void {
      // Reported before the outro panel, and never as an error: a Tokdash that could not be set up leaves a
      // complete, working install, and saying so is the difference between a missing feature and a failure.
      const quota = quotaNotice(result, text());
      if (quota) {
        if (result.tokdash?.status === 'unavailable') log.warn(quota); else log.info(quota);
      }
      const body = outroEntries(result.access, text()).map((entry) => entry.text).join('\n');
      note(body, text().outroTitle(PRODUCT_IDENTITY.productName));
      outro(resultSummary(result, text()));
    },
    cancelled(stage): void {
      cancel(text().cancelledNote(stage));
    },
    failed(result): void {
      log.error(resultSummary(result, text()));
      // A failure the operator cannot act on is the failure they report back. Name the step, quote the real
      // underlying error, and point at the persisted record that outlives the rolled-back transaction. The
      // quoted detail and code stay verbatim — they are what a bug report has to carry.
      if (result.failure) {
        note(
          [
            text().failureStep(result.failure.step),
            text().failureReason(result.failure.detail),
            text().failureCode(result.failure.code),
            text().failureRollback(result.failure.rollback),
            text().failureDiagnostic(result.failure.diagnosticPath),
            text().failureAlsoInDoctor(PRODUCT_IDENTITY.primaryBinary),
          ].join('\n'),
          text().failureTitle,
        );
      }
    },
  };
}

/**
 * Tri-state consent for the opencode shim in the NON-interactive (`--yes`) path. 'on' (--install-opencode-shim)
 * and 'off' (--no-install-opencode-shim) are explicit; 'unset' (neither flag) never silently enables — it only
 * honors a prior stored opt-in. This is what stops `setup --yes` on a pre-shim install from installing it.
 */
export type OpencodeShimSignal = 'on' | 'off' | 'unset';

export interface NonInteractiveSetupOptions {
  acceptManagedRuntimeOwnership: boolean;
  /** Accepted for compatibility and now implied: choosing the systemd service enables lingering with it,
   *  so `--enable-systemd-lingering` no longer changes the outcome. Still separately receipted. */
  enableSystemdLingering: boolean;
  enableTailscaleServe: boolean;
  installAgentSkill: boolean;
  opencodeShim: OpencodeShimSignal;
  replaceLegacyPiBridge?: boolean;
  upgradeLegacyAgentSkill?: boolean;
  /** Caller-forced language. Unset means the persisted choice, then COSYNCING_SETUP_LANG, then English —
   *  `setup --yes` has no prompt to answer, so it never invents a language the operator did not declare. */
  language?: SetupLanguage;
}

export function createNonInteractiveSetupPresenter(
  writer: SetupOutputWriter,
  options: NonInteractiveSetupOptions = {
    acceptManagedRuntimeOwnership: true,
    enableSystemdLingering: false,
    enableTailscaleServe: false,
    installAgentSkill: true,
    opencodeShim: 'unset',
    replaceLegacyPiBridge: false,
    upgradeLegacyAgentSkill: false,
  },
): SetupPresenter {
  const line = (value: string): void => writer.write(`${value}\n`);
  // Never default-true in the non-interactive path. 'unset' honors only a prior stored opt-in, so a
  // `setup --yes` upgrade of a pre-shim install does NOT silently enable the shim.
  const resolveOpencodeShim = (inspection: Readonly<SetupInspection>): boolean => {
    if (options.opencodeShim === 'off') return false;
    if (options.opencodeShim === 'on') return true;
    return inspection.setupState.opencodeShimRequested === true;
  };
  // There is no --no-enable-tailscale-serve flag. Omission therefore preserves an existing opt-in while a
  // fresh install stays local-only; the positive flag can enable Serve on either a fresh or committed setup.
  const resolveTailscaleServe = (inspection: Readonly<SetupInspection>): boolean =>
    options.enableTailscaleServe || inspection.setupState.tailscaleServeRequested === true;
  // There is no prompt here, so language comes from what the operator already declared: an explicit flag,
  // then the choice a previous interactive run persisted, then the env override, then English.
  const resolveLanguage = (inspection: Readonly<SetupInspection>): SetupLanguage =>
    options.language
      ?? normalizeSetupLanguage(inspection.setupState.language)
      ?? setupLanguageFromEnv(process.env)
      ?? DEFAULT_SETUP_LANGUAGE;
  let language: SetupLanguage = options.language ?? setupLanguageFromEnv(process.env) ?? DEFAULT_SETUP_LANGUAGE;
  return {
    async chooseLanguage(inspection): Promise<SetupLanguage> {
      language = resolveLanguage(inspection);
      return language;
    },
    intro(inspection): void {
      line(`${PRODUCT_IDENTITY.productName} setup ${inspection.version}`);
      line(`install=${inspection.installLocation}`);
      line(`state=${inspection.stateHome}`);
      for (const agent of inspection.agents) {
        line(`agent.${agent.id}=${agent.state}${agent.installedVersion ? `:${agent.installedVersion}` : ''}`);
        // Same answer the interactive preflight gives, in the machine-readable shape this path uses.
        if (agent.state === 'unsupported') {
          line(`agent.${agent.id}.unsupported=detected:${agent.installedVersion ?? 'unknown'} `
            + `minimum:${agent.minimumVersion}${agent.upgradeCommand ? ` fix:${agent.upgradeCommand}` : ''}`);
        }
        if (agent.runtimeUnavailable) {
          line(`agent.${agent.id}.runtime-unavailable=${agent.runtimeUnavailable.detailCode} `
            + `installed-node:${agent.runtimeUnavailable.installedVersion ?? 'unknown'} `
            + `minimum-node:${agent.runtimeUnavailable.minimumVersion ?? 'unknown'} `
            + `fix:${agent.runtimeUnavailable.remediation}`);
        }
        if (agent.managedRuntimeWarning) {
          line(`agent.${agent.id}.warning=${agent.managedRuntimeWarning.detailCode} `
            + `fix:${agent.managedRuntimeWarning.command} then:${PRODUCT_IDENTITY.aliasBinary} setup`);
        }
      }
    },
    showBlockers(issues): void {
      for (const issue of issues) line(`[error] ${issue.code}: ${issue.summary} Fix: ${issue.remediation}`);
    },
    async confirmManagedRuntime(): Promise<boolean> { return options.acceptManagedRuntimeOwnership; },
    async confirmLegacyPiBridge(): Promise<boolean> { return options.replaceLegacyPiBridge === true; },
    async confirmAgentSkill(): Promise<boolean> { return options.installAgentSkill; },
    async confirmLegacyAgentSkill(): Promise<boolean> { return options.upgradeLegacyAgentSkill === true; },
    async confirmOpencodeShim(inspection): Promise<boolean> {
      return resolveOpencodeShim(inspection);
    },
    intendedChoices(inspection): {
      installAgentSkill: boolean;
      installOpencodeShim: boolean;
      tailscaleServe: boolean;
    } {
      // Same resolution the confirm* calls use, but non-prompting, so the committed-setup no-op short-circuit
      // sees the flag-resolved intent. Tailscale has only a positive flag, so omission preserves a stored
      // opt-in rather than silently disabling an existing route during a non-interactive package update.
      return {
        installAgentSkill: options.installAgentSkill,
        installOpencodeShim: resolveOpencodeShim(inspection),
        tailscaleServe: resolveTailscaleServe(inspection),
      };
    },
    async chooseService(inspection): Promise<SetupServiceChoice> {
      return inspection.systemdAvailable ? inspection.durableServiceProvider : 'foreground';
    },
    async confirmTailscale(inspection): Promise<boolean> { return resolveTailscaleServe(inspection); },
    async confirmQuotaWarnings(inspection): Promise<boolean> {
      // Reported here too, at the same point the wizard reports it, so a scripted install is not the one
      // path where a refused override is silent. Tagged and English like every machine-readable line, and
      // carrying the reason only — the value can be a credential and this output lands in CI logs.
      const endpoint = resolveTokdashEndpoint(process.env.COSYNCING_TOKDASH_URL);
      if (endpoint.rejected) {
        line(`[tokdash] url-rejected reason=${endpoint.rejected} `
          + `detail=${tokdashRejectionReason(endpoint.rejected)} url=${endpoint.baseUrl}`);
      }
      return inspection.setupState.quotaWarningsEnabled === true;
    },
    showPlan(plan): void {
      for (const action of plan.mutationSummary) line(`[plan] ${action}`);
    },
    async confirmApply(): Promise<boolean> { return true; },
    // Machine-readable and therefore English regardless of language, like every other tagged line here.
    recoveredInterruptedTransaction(): void { line('[recovered] interrupted setup rolled back'); },
    complete(result: Readonly<SetupCommandResult>): void {
      // `[credential]` stays the tag on the token block so machine consumers of the `--yes` output keep
      // parsing it; the endpoint facts are new and get their own tag rather than overloading that one.
      for (const entry of outroEntries(result.access, setupMessages(language))) {
        line(`[${entry.tag}] ${entry.text}`);
      }
      // Tagged and English, like every other machine-readable line here: the status word is what a script
      // branches on, and the detail is what a bug report quotes.
      if (result.tokdash && result.tokdash.status !== 'skipped') {
        // The URL is on the line because a script reading this must be able to tell which endpoint the
        // status is about, and an override moves it.
        line(`[tokdash] ${result.tokdash.status} url=${result.tokdash.baseUrl}${result.tokdash.status === 'unavailable' ? ` reason=${result.tokdash.reason} detail=${result.tokdash.detail}` : ''}`);
      }
      line(`[${result.status}] ${result.summary}`);
    },
    cancelled(stage): void { line(`[cancelled] ${stage}`); },
    failed(result: Readonly<SetupCommandResult>): void {
      line(`[${result.status}] ${result.summary}`);
      if (!result.failure) return;
      line(`[failure] step=${result.failure.step} code=${result.failure.code} rollback=${result.failure.rollback}`);
      line(`[failure] reason=${result.failure.detail}`);
      line(`[failure] diagnostic=${result.failure.diagnosticPath}`);
    },
  };
}
