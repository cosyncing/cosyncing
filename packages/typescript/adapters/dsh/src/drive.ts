/**
 * Every write this package performs.
 *
 * All of them live here rather than beside the read paths so the mutating
 * surface is one file long and can be read in a sitting: prompt, cancel,
 * create, rename, model selection, command execution, and the answer route that
 * settles a question or an approval. Three reads keep them company — the two
 * model catalogs (session-scoped and host-wide) and the command roster — only
 * because a catalog and the call that acts on it are unreadable apart.
 *
 * Two properties matter more than the code:
 *
 *  - THE HOST IS THE SINGLE OWNER. dsh is server-first: the one `dsh web`
 *    process owns the append-only log, and every client — including its own
 *    browser UI — writes by RPC into it. So there is no ownership arbitration to
 *    perform here and no fork-on-write hazard; a write either lands in the one
 *    log or fails with a typed code.
 *  - ANSWERS ARE CORRELATED BY rpcId. A question or approval arrives as a
 *    server-request on the mux stream; the answer is a client-response echoing
 *    that exact rpcId. The payload carries the resource ids the host needs, but
 *    the ROUTING is the rpcId, and the host replays pending frames with the same
 *    rpcId on every reconnect.
 */
import { dirname, resolve } from 'node:path';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { PRODUCT_IDENTITY, type ModelOption, type PromptInput } from '@cosyncing/adapter-api';
import {
  describeDshFailure,
  type DshFailure,
  type DshPromptMode,
  type DshReceipt,
  type DshRpcClient,
} from './server.ts';
import type { DshPendingApproval, DshPendingQuestion } from './mapping.ts';

/** A write the host refused, carrying the native code so callers can branch. */
export class DshDriveError extends Error {
  constructor(action: string, readonly failure: DshFailure) {
    super(`dsh ${action} failed — ${describeDshFailure(failure)}`);
    this.name = 'DshDriveError';
  }

  /** The host's own typed error code, when the failure was a business error. */
  get code(): string | undefined {
    return this.failure.kind === 'rpc' ? this.failure.code : undefined;
  }

  /** A transport fault the caller may sensibly re-issue after a re-baseline. */
  get retryable(): boolean {
    return this.failure.kind === 'transport' && this.failure.retryable;
  }
}

/**
 * Non-image files are refused rather than silently dropped.
 *
 * This is a host limit, not a deferral. `session.prompt` accepts exactly two
 * content parts — text and image — and nothing in the API takes a general file:
 * `session.attachment` READS one durable image back after proving the session
 * log references it. Sending the text alone would deliver a prompt referring to
 * a file the agent never received, which reads to the user as the agent
 * ignoring them.
 *
 * A PATH is not an option either, the way it is for Claude: dsh may run on
 * another machine, so a broker-local path names nothing the host can open.
 */
export const DSH_FILE_UNSUPPORTED =
  'The DeepSeek Harness host accepts images but not other file attachments; paste the file’s contents as text instead.';

/** Refused before anything is read: an attachment that arrived without staging. */
export const DSH_FILE_UNSTAGED = 'a DeepSeek Harness attachment arrived without a staged broker path';

/** Refused before anything is read: a path outside the session's staging inbox. */
export const DSH_FILE_UNTRUSTED = 'the DeepSeek Harness adapter rejected an untrusted broker attachment path';

/**
 * The host's own image-intake policy, published as the `imageLimits` session
 * projection and constant for a host boot.
 *
 * Enforced HERE, before the upload, because the alternative is spending a
 * multi-megabyte POST to be told no. The generic `PROMPT_ATTACHMENT_LIMITS` is
 * deliberately not used: it is the broker's transport bound, while these are
 * this deployment's own numbers, and quoting the host's limit back to the user
 * is the only version of the message that tells them what to change.
 *
 * Key absence means no attachment service is composed. The host documents that
 * case as "skip the pre-check and let the host answer", so an absent policy
 * admits the prompt rather than inventing a bound.
 */
export interface DshImageLimits {
  maxImageBytes?: number;
  maxImagesPerMessage?: number;
  maxMessageImageBytes?: number;
  mediaTypes?: readonly string[];
}

/** One selectable model route, in the host's own vocabulary. */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One model inside its provider group, with the efforts that model route offers. */
export interface DshModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  };
}

/** One provider and the models it advertised successfully. */
export interface DshModelProviderGroup {
  id: string;
  name: string;
  models: DshModelCatalogModel[];
}

/** The session's model directory: what it runs now, whether it can run, what it could run. */
export interface DshSessionModels {
  /** Absent when the host reported no usable current selection. */
  current?: DshModelSelection;
  /** Whether an adapter currently serves the current route — the turn-start gate. */
  routable: boolean;
  groups: DshModelProviderGroup[];
}

/** One command the host's registry advertises for a session. */
export interface DshCommandDescriptor {
  name: string;
  description: string;
  input?: { hint: string };
}

/**
 * Parse the provider-group list that `session.models` and `llm.models` share —
 * the two catalogs differ only in their per-session slots (`current`,
 * `routable`), so both read their `groups` through this one decoder.
 *
 * Malformed rows are skipped, not fatal: a single bad provider entry must not
 * cost the user every other model on the host.
 */
function parseModelGroups(raw: unknown): DshModelProviderGroup[] {
  const groups: DshModelProviderGroup[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const group = entry as { id?: unknown; name?: unknown; models?: unknown };
    if (typeof group.id !== 'string' || group.id.length === 0) continue;
    const models: DshModelCatalogModel[] = [];
    for (const candidate of Array.isArray(group.models) ? group.models : []) {
      if (!candidate || typeof candidate !== 'object') continue;
      const model = candidate as { id?: unknown; name?: unknown; description?: unknown; reasoning?: unknown };
      if (typeof model.id !== 'string' || model.id.length === 0) continue;
      const reasoning = model.reasoning as { efforts?: unknown; defaultEffort?: unknown } | undefined;
      const efforts: { id: string; name: string; description?: string }[] = [];
      for (const effort of Array.isArray(reasoning?.efforts) ? reasoning.efforts : []) {
        if (!effort || typeof effort !== 'object') continue;
        const row = effort as { id?: unknown; name?: unknown; description?: unknown };
        if (typeof row.id !== 'string' || row.id.length === 0) continue;
        efforts.push({
          id: row.id,
          name: typeof row.name === 'string' && row.name ? row.name : row.id,
          ...(typeof row.description === 'string' ? { description: row.description } : {}),
        });
      }
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name ? model.name : model.id,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(efforts.length > 0
          ? {
              reasoning: {
                efforts,
                ...(typeof reasoning?.defaultEffort === 'string'
                  ? { defaultEffort: reasoning.defaultEffort }
                  : {}),
              },
            }
          : {}),
      });
    }
    groups.push({
      id: group.id,
      name: typeof group.name === 'string' && group.name ? group.name : group.id,
      models,
    });
  }
  return groups;
}

/**
 * The host's DISPLAY NAME for one model in a catalog answer, when it published
 * one distinct from the id.
 *
 * Seeds `SessionInfo.currentModel.label`, which the roster and composer read
 * verbatim — the client authors no model names of its own. Two deliberate
 * differences from {@link dshModelOptions}'s picker label:
 *
 *  - NOT provider-qualified. `currentModel` already carries `providerID`, and
 *    the client strips the model id out of the label before showing it, so a
 *    `"Name (Provider)"` label would render as the leftover `"(Provider)"`.
 *  - Absent when the name EQUALS the id. `parseModelGroups` defaults a missing
 *    `name` to the id, and forwarding that would publish a raw id as if it were
 *    an authored name. No name is reported as no name.
 */
export function dshModelDisplayName(
  groups: readonly DshModelProviderGroup[],
  providerId: string,
  modelId: string,
): string | undefined {
  const model = groups.find((group) => group.id === providerId)?.models.find((entry) => entry.id === modelId);
  return model && model.name !== model.id ? model.name : undefined;
}

/**
 * Flatten provider groups into picker options.
 *
 * Shared by the session-scoped catalog (`DshSessionConnection.listModels`) and
 * the pre-session one (`DshAdapter.listModels`), so the create dialog and the
 * attached picker show the SAME rows for the same host. Group order is the
 * host's advertised order — picker order. The provider qualifies each label
 * because two providers can serve the same model id, and a picker showing it
 * twice is unreadable.
 */
export function dshModelOptions(groups: readonly DshModelProviderGroup[]): ModelOption[] {
  const options: ModelOption[] = [];
  for (const group of groups) {
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts ?? [];
      options.push({
        providerID: group.id,
        modelID: model.id,
        label: `${model.name} (${group.name})`,
        ...(model.description ? { description: model.description } : {}),
        ...(efforts.length > 0
          ? {
              reasoningEfforts: efforts.map((effort) => ({
                effort: effort.id,
                label: effort.name,
                ...(effort.description ? { description: effort.description } : {}),
              })),
            }
          : {}),
        ...(model.reasoning?.defaultEffort
          ? { defaultReasoningEffort: model.reasoning.defaultEffort }
          : {}),
      });
    }
  }
  return options;
}

/** A settled command execution, paired with its lifecycle events by `commandId`. */
export interface DshCommandExecution {
  commandId: string;
  result: { kind: 'success' | 'error'; text?: string; sourceEventSeq?: number };
}

/** Decoded byte length of a base64 payload, without allocating the bytes. */
function base64Bytes(data: string): number {
  const clean = data.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

export interface DshPromptOptions {
  /** `queue` hands the message to the next turn claim; `steer` injects into the running one. */
  mode?: DshPromptMode;
  /** IANA zone the host stamps onto the request context. */
  clientTimeZone?: string;
  /** Called with the rpcId dsh will stamp on the resulting `user/message`. */
  onRpcId?: (rpcId: string) => void;
  /** The host's published intake policy; absent means no pre-check. */
  imageLimits?: DshImageLimits;
  /** The session workspace, which anchors the staging inbox a staged file must sit in. */
  sessionCwd?: string;
}

export class DshDriver {
  constructor(private readonly rpc: DshRpcClient) {}

  /**
   * Send one prompt.
   *
   * `mode` is the host's own queue discipline, not a cosyncing invention: an
   * idle session claims a queued message immediately, and a running one holds it
   * until the turn boundary — which is exactly the queued-then-delivered
   * lifecycle the canonical `user-message.queued` flag describes.
   */
  async prompt(sessionId: string, input: PromptInput, options: DshPromptOptions = {}): Promise<void> {
    const text = input.text ?? '';
    // Staged files are folded into the image list first, so both intake routes
    // (a client that sends `images` directly, and the first-party client, which
    // stages everything as `files`) meet the same policy check exactly once.
    const images = [
      ...(input.images ?? []),
      ...this.stagedImages(input.files ?? [], options.imageLimits, options.sessionCwd),
    ];
    // Text FIRST, then images. The host preserves part order into the model
    // turn, and a prompt whose text trails its attachments reads as a caption.
    const content: unknown[] = [
      { type: 'text', text },
      ...this.imageParts(images, options.imageLimits),
    ];
    const outcome = await this.rpc.call<{ accepted: true }>(
      'session.prompt',
      {
        sessionId,
        mode: options.mode ?? 'queue',
        content,
        ...(options.clientTimeZone ? { clientTimeZone: options.clientTimeZone } : {}),
      },
      options.onRpcId ? { onRpcId: options.onRpcId } : undefined,
    );
    if (!outcome.ok) throw new DshDriveError('prompt', outcome.failure);
  }

  /**
   * Read broker-staged attachments into inline image bytes.
   *
   * The app has one attachment affordance and it stages everything as a FILE,
   * so without this the host's image intake would be unreachable from the
   * product — the only client that could use it would be one that sends
   * `images` directly, which the first-party client never does.
   *
   * THE TRUST BOUNDARY. The broker is the only writer of `brokerPath`, and the
   * protocol forbids a client from supplying one (`upload-staging.ts` rejects
   * `path`/`brokerPath` on the wire outright). This function nonetheless
   * re-establishes the boundary itself rather than inheriting it, because it is
   * the last code that turns a path into bytes.
   *
   * The boundary is ONE directory: `<session cwd>/<repo dir>/inbox`. Both
   * intake routes land there — an inline attachment is written into it, and a
   * chunked upload is MOVED into it by `complete()`, which rewrites the
   * record's `dataPath` and is the only thing that can mark a staged reference
   * `ready`. So a prompt-time staged path is an inbox path regardless of size,
   * and the size at which the client switches from inline to staged is not a
   * boundary this code has to know about.
   *
   * Two checks, and it is worth being exact about what each one buys, because
   * an earlier version of this comment claimed more than the code delivered:
   *
   *  - The PARENT is compared on real paths (`realpathSync` on the directory,
   *    never on the file — resolving the leaf is itself a follow and would
   *    report the target's location instead of the link's).
   *  - The LEAF is refused by the kernel, not by us: `O_NOFOLLOW` fails the
   *    open with ELOOP if the final component is a symlink AT THE MOMENT IT IS
   *    OPENED. That is what makes it a real defence rather than a check with a
   *    gap after it — resolve-then-open is two resolutions, and a link swapped
   *    into the gap would be followed silently, with `fstat` reporting the
   *    attacker's target as an ordinary regular file.
   *
   * What is NOT closed: the parent directory itself could be replaced between
   * resolving it and the open. Node exposes no `openat`, so closing that would
   * need a directory handle this code cannot hold, and winning it requires
   * write access to the session's own `<repo dir>` — the same access that would
   * let an attacker simply place a file in the inbox and skip the race.
   * `O_NOFOLLOW` is available on every platform the broker ships for (linux and
   * darwin; see `supported-hosts.ts`).
   *
   * The file is then opened once and every subsequent decision is made from the
   * FILE DESCRIPTOR — it must be a regular file (a fifo would block the broker;
   * a device is not an attachment), and its size is checked against the host's
   * own per-image bound BEFORE a byte is read, so an oversized file costs a
   * stat rather than a read into memory.
   *
   * NOT enforced here: `maxImagePixels`. Cosyncing never decodes the image, so
   * it has no honest pixel count to check, and guessing one from a header it
   * does not otherwise parse would reject valid images on malformed metadata.
   * The host enforces it authoritatively at admission.
   */
  private stagedImages(
    files: NonNullable<PromptInput['files']>,
    limits: DshImageLimits | undefined,
    sessionCwd: string | undefined,
  ): { data: string; mimeType: string; name?: string }[] {
    if (files.length === 0) return [];
    const refuse = (message: string): never => {
      throw new DshDriveError('prompt', { kind: 'rpc', code: 'attachment-unsupported', message });
    };
    const allowed = limits?.mediaTypes;
    const isImage = (mimeType: string): boolean =>
      allowed && allowed.length > 0
        ? allowed.includes(mimeType)
        : mimeType.startsWith('image/');
    for (const file of files) {
      if (!isImage(file.mimeType.trim().toLowerCase())) refuse(DSH_FILE_UNSUPPORTED);
    }
    if (!sessionCwd) refuse('this DeepSeek Harness session has no workspace to stage an attachment in');
    let inbox: string;
    try {
      inbox = realpathSync(resolve(sessionCwd!, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox'));
    } catch {
      return refuse(DSH_FILE_UNTRUSTED);
    }
    const maxBytes = limits?.maxImageBytes;
    return files.map((file) => {
      if (!file.brokerPath) refuse(DSH_FILE_UNSTAGED);
      const staged = resolve(file.brokerPath!);
      // Resolve the PARENT, never the leaf. Calling `realpathSync` on the file
      // itself is already a follow — it would report the target's location and
      // hide exactly the substitution being defended against.
      let parent: string;
      try {
        parent = realpathSync(dirname(staged));
      } catch {
        return refuse(DSH_FILE_UNTRUSTED);
      }
      if (parent !== inbox) refuse(DSH_FILE_UNTRUSTED);
      // O_NOFOLLOW makes the leaf decision ATOMIC WITH THE OPEN: the kernel
      // fails with ELOOP if the final component is a symlink at the instant it
      // is opened, so there is no window in which a checked path can be swapped
      // for a link. Checking first and opening second cannot achieve this — the
      // fd would then be the attacker's target and `fstat` would call it a
      // perfectly ordinary regular file. Every staged file the broker writes is
      // a real file, so refusing links outright costs nothing.
      let fd: number;
      try {
        fd = openSync(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        return refuse(DSH_FILE_UNTRUSTED);
      }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) refuse(DSH_FILE_UNTRUSTED);
        if (typeof maxBytes === 'number' && stat.size > maxBytes) {
          refuse(`"${file.name ?? 'image'}" is larger than the ${maxBytes} bytes this DeepSeek Harness host accepts for one image.`);
        }
        // The broker recorded the size it staged. Bytes that disagree with the
        // record are not the attachment the user picked.
        if (typeof file.size === 'number' && file.size !== stat.size) refuse(DSH_FILE_UNTRUSTED);
        const bytes = Buffer.alloc(stat.size);
        let read = 0;
        while (read < stat.size) {
          const chunk = readSync(fd, bytes, read, stat.size - read, read);
          if (chunk <= 0) break;
          read += chunk;
        }
        if (read !== stat.size) refuse(DSH_FILE_UNTRUSTED);
        return {
          data: bytes.toString('base64'),
          mimeType: file.mimeType.trim().toLowerCase(),
          ...(file.name ? { name: file.name } : {}),
        };
      } finally {
        closeSync(fd);
      }
    });
  }

  /**
   * Convert prompt images to host content parts, refusing what this host says
   * it will not take.
   *
   * Every refusal quotes the host's OWN number, because the user's next action
   * depends on which bound they hit: a smaller image, fewer images, or a
   * different format are three different remedies. A refusal also fails the
   * whole prompt rather than dropping one image — a silently shortened prompt
   * is the failure mode this guard exists to prevent.
   */
  private imageParts(
    images: readonly { data: string; mimeType: string; name?: string }[],
    limits?: DshImageLimits,
  ): unknown[] {
    if (images.length === 0) return [];
    const refuse = (message: string): never => {
      throw new DshDriveError('prompt', { kind: 'rpc', code: 'attachment-rejected', message });
    };
    const maxCount = limits?.maxImagesPerMessage;
    if (typeof maxCount === 'number' && images.length > maxCount) {
      refuse(`The DeepSeek Harness host accepts at most ${maxCount} images per message; this prompt has ${images.length}.`);
    }
    const allowed = limits?.mediaTypes;
    let total = 0;
    const parts = images.map((image) => {
      const mediaType = image.mimeType.trim().toLowerCase();
      if (allowed && allowed.length > 0 && !allowed.includes(mediaType)) {
        refuse(`The DeepSeek Harness host does not accept ${mediaType || 'that image type'}; it accepts ${allowed.join(', ')}.`);
      }
      const bytes = base64Bytes(image.data);
      total += bytes;
      const maxBytes = limits?.maxImageBytes;
      if (typeof maxBytes === 'number' && bytes > maxBytes) {
        refuse(`"${image.name ?? 'image'}" is larger than the ${maxBytes} bytes this DeepSeek Harness host accepts for one image.`);
      }
      return {
        type: 'image',
        mediaType,
        data: image.data,
        ...(image.name ? { name: image.name } : {}),
      };
    });
    const maxTotal = limits?.maxMessageImageBytes;
    if (typeof maxTotal === 'number' && total > maxTotal) {
      refuse(`These images total more than the ${maxTotal} bytes this DeepSeek Harness host accepts in one message.`);
    }
    return parts;
  }

  /**
   * The session's model catalog.
   *
   * A READ, and a fresh one per call — the host recomputes provider lookups,
   * so a provider that was down at attach can appear later without a reattach.
   *
   * `groups` is ADVISORY and `routable` is not derived from it: the host
   * documents a route that serves a model it stopped advertising (usable, yet
   * absent from the groups) and a route whose adapter is gone (advertised
   * nowhere and able to serve nothing). A surface that gates input must read
   * `routable`; a picker reads the groups. `failures` is per-provider, so the
   * groups that did load stay usable beside it.
   */
  async models(sessionId: string): Promise<DshSessionModels> {
    const outcome = await this.rpc.call<unknown>('session.models', { sessionId });
    if (!outcome.ok) throw new DshDriveError('model catalog', outcome.failure);
    const value = outcome.value;
    if (!value || typeof value !== 'object') {
      throw new DshDriveError('model catalog', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session.models did not return an object',
      });
    }
    const row = value as { current?: unknown; routable?: unknown; groups?: unknown };
    const current = row.current as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined;
    return {
      // A non-boolean `routable` fails CLOSED. It gates whether a turn can start
      // at all, and guessing `true` would offer a composer the host will refuse.
      routable: row.routable === true,
      groups: parseModelGroups(row.groups),
      ...(current && typeof current.provider === 'string' && typeof current.model === 'string'
        ? {
            current: {
              provider: current.provider,
              model: current.model,
              ...(typeof current.reasoningEffort === 'string'
                ? { reasoningEffort: current.reasoningEffort }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * The HOST-WIDE model catalog: the same provider groups `session.models`
   * serves one session, with no per-session selection or routability. It exists
   * for surfaces that pick a model BEFORE a session exists — the create dialog —
   * so there is deliberately no `current`/`routable` to read here, and a new
   * session is not gated on a route check made for a different one.
   *
   * Host-scoped like the workspace registry: the provider topology outlives a
   * downlink epoch, and a generation rotation does not make the answer wrong.
   */
  async catalog(): Promise<DshModelProviderGroup[]> {
    const outcome = await this.rpc.call<unknown>('llm.models', {}, { generationLoss: 'host-scoped' });
    if (!outcome.ok) throw new DshDriveError('model catalog', outcome.failure);
    const value = outcome.value;
    if (!value || typeof value !== 'object') {
      throw new DshDriveError('model catalog', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'llm.models did not return an object',
      });
    }
    return parseModelGroups((value as { groups?: unknown }).groups);
  }

  /**
   * Select this session's model route.
   *
   * dsh has no per-prompt model field, so this is DURABLE session state: the
   * choice outlives the turn it was made for and is what the host's own browser
   * UI will show next. A caller mapping a per-prompt override onto it is
   * changing the session, and the ordering matters — select, then prompt.
   */
  async selectModel(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection> {
    const outcome = await this.rpc.call<{ selected?: unknown }>('session.selectModel', {
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    });
    if (!outcome.ok) throw new DshDriveError('model selection', outcome.failure);
    const selected = outcome.value?.selected;
    if (!selected || typeof selected !== 'object') {
      throw new DshDriveError('model selection', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session.selectModel returned no selection',
      });
    }
    const value = selected as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
    if (typeof value.provider !== 'string' || typeof value.model !== 'string') {
      throw new DshDriveError('model selection', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session.selectModel returned an unusable selection',
      });
    }
    return {
      provider: value.provider,
      model: value.model,
      ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
    };
  }

  /**
   * The session's command roster. A READ — it is here beside the executor so
   * the pair reads together, not because it mutates.
   */
  async listCommands(sessionId: string): Promise<DshCommandDescriptor[]> {
    const outcome = await this.rpc.callRemote<unknown>('commands/list', { agentId: sessionId });
    if (!outcome.ok) throw new DshDriveError('command list', outcome.failure);
    if (!Array.isArray(outcome.value)) {
      throw new DshDriveError('command list', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'commands/list did not return an array',
      });
    }
    // One malformed row does not blank the roster: the rest are still real
    // commands the user can run.
    const descriptors: DshCommandDescriptor[] = [];
    for (const entry of outcome.value) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { name?: unknown; description?: unknown; input?: unknown };
      if (typeof row.name !== 'string' || row.name.length === 0) continue;
      const hint =
        row.input && typeof row.input === 'object' && typeof (row.input as { hint?: unknown }).hint === 'string'
          ? (row.input as { hint: string }).hint
          : undefined;
      descriptors.push({
        name: row.name,
        description: typeof row.description === 'string' ? row.description : '',
        ...(hint ? { input: { hint } } : {}),
      });
    }
    return descriptors;
  }

  /**
   * Run one command line.
   *
   * `line` is the whole typed line INCLUDING the leading slash, which is what
   * the host's parser splits into name and verbatim raw input. The caller
   * composes it from an advertised name, never from user text.
   *
   * `undefined` is a legitimate value: a command whose effect is entirely a
   * state change streams back as ordinary session events and settles with no
   * result slot.
   */
  async executeCommand(sessionId: string, line: string): Promise<DshCommandExecution | undefined> {
    const outcome = await this.rpc.callRemote<unknown>('commands/execute', {
      agentId: sessionId,
      line,
    });
    if (!outcome.ok) throw new DshDriveError('command', outcome.failure);
    const value = outcome.value;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object') {
      throw new DshDriveError('command', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'commands/execute returned a non-object',
      });
    }
    const row = value as { commandId?: unknown; result?: unknown };
    const result = row.result as { kind?: unknown; text?: unknown; sourceEventSeq?: unknown } | undefined;
    if (!result || (result.kind !== 'success' && result.kind !== 'error')) {
      throw new DshDriveError('command', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'commands/execute returned no recognizable result',
      });
    }
    return {
      commandId: typeof row.commandId === 'string' ? row.commandId : '',
      result: {
        kind: result.kind,
        ...(typeof result.text === 'string' ? { text: result.text } : {}),
        ...(typeof result.sourceEventSeq === 'number' ? { sourceEventSeq: result.sourceEventSeq } : {}),
      },
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const outcome = await this.rpc.call<{ accepted: true }>('session.cancel', { sessionId });
    if (!outcome.ok) throw new DshDriveError('cancel', outcome.failure);
  }

  /** Create a session inside an existing workspace. Returns the host-issued id. */
  async create(workspaceId: string): Promise<{ sessionId: string; agentPreset?: string }> {
    // Aborting a create mid-flight does not un-create it upstream: the caller
    // would see a retryable failure for a session that exists and retry into a
    // duplicate. A generation rotation is not a reason to abandon a write whose
    // outcome is already decided on the host.
    //
    // This removes generation loss as an ARTIFICIAL cause of an unknown outcome.
    // It does not remove every one: the unary deadline still applies, so a host
    // that creates the session and answers after it leaves the same ambiguity by
    // a different route. Resolving that needs an outcome-unknown result the
    // caller can reconcile against session.list, not a longer timeout.
    const outcome = await this.rpc.call<{ sessionId?: unknown; agentPreset?: unknown }>(
      'session.create',
      { workspaceId },
      { generationLoss: 'non-idempotent-write' },
    );
    if (!outcome.ok) throw new DshDriveError('session create', outcome.failure);
    const sessionId = typeof outcome.value?.sessionId === 'string' ? outcome.value.sessionId : '';
    if (!sessionId) {
      throw new DshDriveError('session create', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session.create returned no sessionId',
      });
    }
    return {
      sessionId,
      ...(typeof outcome.value?.agentPreset === 'string' ? { agentPreset: outcome.value.agentPreset } : {}),
    };
  }

  /** Rename natively. The host normalizes the title and answers with what it accepted. */
  async rename(sessionId: string, title: string): Promise<string> {
    const outcome = await this.rpc.call<{ title?: unknown }>('session.rename', { sessionId, title });
    if (!outcome.ok) throw new DshDriveError('rename', outcome.failure);
    return typeof outcome.value?.title === 'string' ? outcome.value.title : title;
  }

  /**
   * Answer one question.
   *
   * `answers` arrives as one array of selections per question, in the order the
   * card presented them; the native ids captured at mapping time re-attach each
   * array to its question. The host validates STRICTLY — a label it never
   * offered is rejected as `bad-response` — so entries matching the question's
   * offered labels travel as `selected` and anything else travels as the wire's
   * `custom` free-text field (multiple free-text entries join as lines).
   *
   * For a single-select question the host also rejects `selected` and `custom`
   * TOGETHER, so at most one of the two survives: an explicit free-text entry
   * wins (it is the stronger signal of intent), otherwise the first offered
   * selection. For a multi-select question both may ride together,
   * deduplicated.
   */
  async answerQuestion(pending: DshPendingQuestion, answers: string[][]): Promise<DshReceipt> {
    const payload = {
      sessionId: pending.sessionId,
      answer: {
        answers: pending.ids.map((id, index) => {
          const given = [...new Set(answers[index] ?? [])];
          const labels = pending.optionLabels[index] ?? [];
          const selected = given.filter((entry) => labels.includes(entry));
          const custom = given.filter((entry) => !labels.includes(entry)).join('\n');
          if (pending.multiSelect[index] !== true) {
            return custom ? { id, selected: [], custom } : { id, selected: selected.slice(0, 1) };
          }
          return { id, selected, ...(custom ? { custom } : {}) };
        }),
      },
    };
    return this.settle('question answer', pending.rpcId, payload);
  }

  /**
   * Settle one approval. The wire has exactly two outcomes, so a session-wide
   * grant is mapped to a single allow rather than to a promise the host cannot
   * keep; the card advertises only the two real options.
   */
  async respondApproval(pending: DshPendingApproval, allow: boolean): Promise<DshReceipt> {
    return this.settle('approval', pending.rpcId, {
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      outcome: allow ? 'allowed-once' : 'rejected',
    });
  }

  /**
   * The one answer path. A `not-pending` receipt is returned, not thrown:
   * another client answering first is normal in a multi-client product, and
   * the caller settles the local card itself — the resolved frame cannot be
   * relied on, because a resolution that happened while this client was
   * disconnected is never replayed.
   */
  private async settle(action: string, rpcId: string, value: unknown): Promise<DshReceipt> {
    const outcome = await this.rpc.respond(rpcId, value);
    if (!outcome.ok) throw new DshDriveError(action, outcome.failure);
    return outcome.value;
  }
}
