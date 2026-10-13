# Codex

cosyncing requires Codex 0.144.5 or newer. For the managed app-server and
terminal sync, install Codex with OpenAI's official standalone installer.

On macOS or Linux:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

On Windows:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

The installer can detect an existing npm-managed Codex and offer to remove it.
Open a new terminal after installation so the standalone command is on `PATH`.

The npm package can provide a `codex` executable on any platform, but it does
not satisfy cosyncing's standalone-package check. Without the standalone
package, cosyncing can inspect supported local data but reports the
broker-managed daemon and terminal sync as unavailable. A deliberately
external app-server socket is the only supported exception.

Verify the installation and reconcile the broker service:

```bash
codex --version
cosyncing setup
cosy doctor
```

## Session control boundaries

Codex permits one active writer for a thread. Codex Desktop uses its own
private app-server connection rather than cosyncing's shared daemon. If
Desktop retains the active writer, **Take over** is refused and the session
stays read-only in cosyncing. Conversely, Desktop cannot drive the same thread
while cosyncing owns it. Use **Detach** or close the current writer before
transferring control.

This is not a blanket restriction on sessions created in Codex Desktop. An
idle Desktop session that no longer has an active writer can be resumed by
cosyncing. The native resume result, not the session title, origin, size, or
contents, decides whether control can transfer.

Multiple foreground cosyncing clients can join the same broker-owned Codex
Drive session. A later client reuses the broker's current session owner rather
than starting another native Resume, while each connection keeps its own
mutation authority. Background Observe connections remain read-only and do not
join or start model work.

Live two-way terminal sync is available for Codex CLI sessions joined to the
managed daemon with the **Sync with a terminal** command shown by cosyncing
(`codex resume --remote ...`). Codex Desktop and CLI sessions running their own
app-server do not share that synchronized owner. A plain `codex resume` can
auto-connect to a reachable default daemon when its launch settings allow
reuse; use the generated `--remote` command to select cosyncing's daemon
explicitly.

Sessions cosyncing drives run on the shared Codex daemon whenever it is
reachable. A terminal can join at any time with **Sync with a terminal**,
including while a turn is running, without interrupting that turn. The app and
terminal then prompt and stop the same session.

When the daemon cannot host a session, cosyncing drives it with a private
process and explains why terminal sync is unavailable. This includes a stopped
or unreachable daemon, disabled terminal sync, and a provider defined only in
a profile file.

Restarting the shared daemon interrupts unfinished app and terminal turns.
cosyncing marks an open turn interrupted, clears its terminal presence, and
reconnects to the replacement daemon when you next prompt it.

## Third-party models (Codex profiles)

Use a profile to select a third-party provider and model. This setup also
applies to Codex used without cosyncing. The steps below were checked with
Codex 0.162.1. cosyncing reads your Codex configuration and never edits it.
If you set `CODEX_HOME`, use that folder in place of `~/.codex` below.

### 1. Define the provider in the base configuration

Put the provider definition in `~/.codex/config.toml`. Use the environment
variable named by `env_key` to supply its API key:

```toml
# ~/.codex/config.toml
[model_providers.my-provider]
name = "My provider"
base_url = "https://llm.example.com/v1"
wire_api = "responses"
env_key = "MY_PROVIDER_API_KEY"
```

The provider must support the configured API.

Codex 0.162.1 loads `$CODEX_HOME/.env` when its runtime processes start,
including a daemon started without the provider key in its environment.
With the default Codex home, put the key in `~/.codex/.env`:

```dotenv
MY_PROVIDER_API_KEY=your-provider-key
```

Protect the file, using your configured Codex home if it differs:

```bash
chmod 600 "${CODEX_HOME:-$HOME/.codex}/.env"
```

Restart the affected Codex processes after changing the file. A variable
exported only in a terminal that connects to an already-running daemon does
not change that daemon's environment. cosyncing's service does not inherit
arbitrary variables exported in your shell; the file supplies the key when
cosyncing starts or restarts the daemon.

### 2. Select the provider, model and catalog in a profile

Create `~/.codex/my-profile.config.toml` and select it with
`codex -p my-profile`:

```toml
# ~/.codex/my-profile.config.toml
model_provider = "my-provider"
model = "my-model"
model_catalog_json = "/absolute/path/to/my-profile-models.json"
approvals_reviewer = "auto_review"
```

Replace the names and catalog path with your own. The catalog must contain
complete native model entries supported by your Codex version, including the
entry whose `slug` is `my-model`. Keep the other fields those entries require;
a model name alone is not a complete catalog.

A plain `codex -p my-profile` starts an embedded session on its own app-server
and cannot live-sync with cosyncing. Codex 0.162.1 shows this startup warning:
“Running without the shared background server: --profile requires embedded mode.”

To join an existing profile session from a terminal, use the app's **Sync
with a terminal** command. It includes the session's model, profile or provider.

### 3. Set the reviewer override in the profile catalog

On Codex 0.162.1, automatic permission review sends its request through the
session's provider. The default reviewer model is `codex-auto-review`; a
third-party provider that does not serve it declines the escalation.

In each third-party entry in the profile catalog, set
`auto_review_model_override` to that entry's own slug. For example, these
fields belong in an existing complete entry, rather than forming a complete
catalog:

```json
{"slug": "my-model", "auto_review_model_override": "my-model"}
```

An embedded `codex -p my-profile` session loads the profile's catalog at
startup. Its reviewer needs the override there even when cosyncing is not
used. An override selects a model; approval still depends on the reviewer's
decision.

### 4. Give the shared daemon a merged base catalog

The shared daemon and unprofiled app-server read the base configuration.
Passing a profile catalog with `thread/start` or `thread/resume` does not
change the reviewer catalog already loaded by that process.

Get the installed release's complete bundled catalog with
`codex debug models --bundled`. Build a merged catalog from those entries,
`~/.codex/models_cache.json` when available, and the profile catalogs you pass
as arguments. Keep one entry per slug, with cached OpenAI entries taking
precedence over bundled entries, and preserve their reviewer settings.
Use distinct third-party slugs so they do not replace native models.

For example, after setting the profile overrides in step 3:

```sh
codex_config_home="${CODEX_HOME:-$HOME/.codex}"
codex debug models --bundled > "$codex_config_home/bundled-models.json"
python3 - "$codex_config_home/bundled-models.json" "$codex_config_home/merged-models.json" \
  "$codex_config_home/my-profile-models.json" <<'PYTHON'
import json
import sys
from pathlib import Path

bundled, output, *profiles = map(Path, sys.argv[1:])
models = {}
for source in (bundled, bundled.parent / 'models_cache.json'):
    if source.exists():
        for entry in json.loads(source.read_text())['models']:
            models[entry['slug']] = entry
native_slugs = set(models)
for source in profiles:
    for entry in json.loads(source.read_text())['models']:
        slug = entry['slug']
        if slug in native_slugs:
            continue  # Keep the bundled/cached native entry and its reviewer settings.
        entry = dict(entry, auto_review_model_override=slug)
        if slug in models and models[slug] != entry:
            raise SystemExit(f'Conflicting profile entries for {slug}; use distinct slugs.')
        models[slug] = entry
output.write_text(json.dumps({'models': list(models.values())}, indent=2) + '\n')
print(f'Wrote {len(models)} models to {output}')
PYTHON
```

Add more profile catalog paths to the command when needed. The script writes
the merged catalog; it keeps native entries with bundled/cached slugs and adds
own-slug reviewer overrides to the other entries. Keep the overrides in each
profile catalog too, as in step 3.

Set the generated `merged-models.json` path at the top level of the base
configuration, **before any `[model_providers.…]` table**. Replace
`<Codex home>` below with the absolute Codex home used by the command above:

```toml
# Top-level settings in ~/.codex/config.toml
model_catalog_json = "<Codex home>/merged-models.json"

# The provider tables from step 1 follow these top-level settings.
```

Run `codex debug models`, without `-p`, to check the catalog the base
configuration loads.

Keep the profile-specific catalog setting from step 2. It supplies the
embedded profile session; the merged base catalog supplies the daemon.
The plain OpenAI `codex` picker also lists third-party models from the merged
catalog. Select those models through their provider profile.

With a provider defined only in a profile file, cosyncing can still drive
that session, but terminal sync is unavailable: the shared daemon cannot
resolve its provider. The app shows **Sync with your terminal (unavailable)**
and explains why.

### 5. Restart the daemon from home

While nothing is running, restart from your home folder so the daemon loads
the updated base configuration and catalog:

```bash
cd ~ && codex app-server daemon restart
```

A restarted daemon takes the folder the restart ran from. Restarting also
interrupts unfinished turns, so wait until they have finished. Restart an
embedded profile session separately to reload its profile catalog.

cosyncing also notices base configuration changes and can restart its managed
Codex runtime when its safety condition is met (by default, once no session is
attached).

### 6. Regenerate catalogs after updates

The merged catalog is a snapshot. Regenerate it after a Codex update or any
profile catalog edit, preserving the new native entries and the third-party
reviewer overrides. Then restart the affected processes as in step 5.

### 7. Check the cosyncing setup

If you use cosyncing, run:

```bash
cosy doctor
```

It warns when a non-OpenAI model selected in the base configuration or a
profile uses automatic review without its startup reviewer override.

### 8. Choose manual approval when preferred

Set `approvals_reviewer = "user"` in the base configuration or profile to
answer eligible permission escalations yourself. In cosyncing, selecting
**Ask permission** lets you answer its approval cards yourself.

For the configuration keys and profile-file locations, see the
[official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Questions from Codex

Codex can ask two kinds of questions, and cosyncing renders both as the same
question card used by every agent.

A blocking question (for example in Plan mode) pauses Codex until you answer;
the session shows **Needs input** and answering responds to Codex directly.

A non-blocking question (`request_user_input_async`, Codex 0.154 and newer)
does not pause Codex: the session follows its **Working** or **Idle** status,
and the card stays open alongside the running output. Answering sends your
reply as an ordinary follow-up message that Codex reads at its next input
boundary — during the current turn when one is running, or as a new turn when
the asking turn already finished. Dismissing the card only dismisses it in
cosyncing, matching the terminal's skip, which Codex does not record anywhere.

A terminal answer can resolve the app card while cosyncing is attached. Codex
sends these as quoted question titles followed by the answer, without a question
identifier. The app resolves a card only after answers for all its questions
arrive; repeated titles are ambiguous and leave the card open. Terminal skips
publish no event, so they cannot dismiss the app's card.

Reconnecting an app to the same running broker connection retains its pending
cards. If the broker's Codex connection closes or the thread is reopened, Codex
does not re-offer unanswered async questions. The history then shows read-only
cards.

## Recovering a stalled daemon

If terminal resumes report **This conversation is open in another app** and
the managed Codex runtime is unavailable, a daemon may still hold writer locks
after losing its control socket. The Agents and usage panel keeps independently
verified version information and offers **Restart** when that daemon's process
identity can be verified.

A confirmed restart first requests graceful shutdown. If it stalls, cosyncing
rechecks the old daemon's identity, terminates only that process, and verifies
its exit before starting a replacement. This can interrupt unfinished turns;
saved conversation history remains available. Resume your terminal explicitly
with **Sync with a terminal** after recovery. Do not delete writer-lock files.

Automatic runtime updates continue to wait for their configured safety gate
and never escalate a stalled shutdown to forced termination. An unreadable or
changed process identity also prevents forced recovery. Restart failures appear
in the runtime status and broker logs.

Direct agent-to-user file delivery is not currently available in Codex. The
installed skill leaves generated files in the workspace because Codex has no
safe exact-session delivery tool. Do not use a shared `.cosyncing/outbox`
directory.

See the [official Codex CLI documentation](https://developers.openai.com/codex/cli/).
