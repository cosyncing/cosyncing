import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_status_panel.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Settings → Agents & usage: the broker-managed agent runtimes, the broker
/// build they run against, and the usage warnings derived from them.
/// Governed by `docs/architecture/client-ui.md`.
class AgentsSettingsPage extends ConsumerWidget {
  /// Creates the agents and usage settings category page.
  const AgentsSettingsPage({super.key});

  Future<void> _changeRuntimePolicy(
    BuildContext context,
    WidgetRef ref,
    String value,
  ) async {
    if (value == 'when-idle') {
      final l10n = AppLocalizations.of(context);
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l10n.settingsIdleTerminalsDisconnectTitle),
          content: Text(l10n.settingsIdleTerminalsDisconnectBody),
          actions: [
            const SettingsDialogCancelButton(),
            SettingsDialogConfirmButton(label: l10n.settingsUseIdlePolicy),
          ],
        ),
      );
      if (confirmed != true || !context.mounted) return;
    }
    await ref
        .read(managedRuntimeControllerProvider.notifier)
        .setCodexUpdatePolicy(value);
  }

  Future<void> _restartRuntime(
    BuildContext context,
    WidgetRef ref,
    AgentRuntimeUpdateStatus update,
  ) async {
    final l10n = AppLocalizations.of(context);
    // A runtime with nothing pending is restarted only to recover it, so the
    // dialog states that no update is being applied and that work is lost.
    final forced = !_runtimeRestartIsPending(update);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          forced
              ? l10n.settingsForceRestartRuntimeConfirmTitle(update.displayName)
              : l10n.settingsRestartRuntimeConfirmTitle(update.displayName),
        ),
        content: Text(
          forced
              ? l10n.settingsForceRestartRuntimeConfirmBody
              : l10n.settingsRestartRuntimeConfirmBody,
        ),
        actions: [
          const SettingsDialogCancelButton(),
          SettingsDialogConfirmButton(
            label: forced
                ? l10n.settingsForceRestartRuntimeAction
                : l10n.settingsRestartNow,
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    await ref
        .read(managedRuntimeControllerProvider.notifier)
        .restartRuntime(update.agent);
  }

  Future<void> _restartEverything(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.settingsRestartEverythingConfirmTitle),
        content: Text(l10n.settingsRestartEverythingConfirmBody),
        actions: [
          const SettingsDialogCancelButton(),
          SettingsDialogConfirmButton(
            label: l10n.settingsRestartEverythingAction,
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    await ref
        .read(managedRuntimeControllerProvider.notifier)
        .restartEverything();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final managedRuntimeState = ref.watch(managedRuntimeControllerProvider);
    // Quota resolves independently of the core snapshot so a slow local read
    // never holds the whole section in its loading state.
    final quotaState = ref.watch(managedRuntimeQuotaProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsEnhancementAgentsQuota)),
      body: SettingsPageBody(
        children: [
          _ManagedRuntimeSection(
            state: managedRuntimeState,
            quota: quotaState.valueOrNull,
            quotaLoading: quotaState.isLoading,
            onRefresh: () => ref
                .read(managedRuntimeControllerProvider.notifier)
                .refresh(freshRuntimeProbe: true),
            onPolicyChanged: (value) =>
                _changeRuntimePolicy(context, ref, value),
            onRestartRuntime: (update) => _restartRuntime(context, ref, update),
            onRestartEverything: () => _restartEverything(context, ref),
            onQuotaChanged: ({required enabled}) => ref
                .read(managedRuntimeControllerProvider.notifier)
                .setQuotaWarningsEnabled(enabled: enabled),
          ),
          const SizedBox(height: 16),
          SettingsRow(
            key: const Key('settings-agents-usage-report'),
            leading: Icon(
              Icons.query_stats_outlined,
              size: 18,
              color: context.tokens.textSecondary,
            ),
            title: Text(l10n.usageHubTileTitle),
            subtitle: Text(l10n.usageHubTileSubtitle),
            trailing: Icon(
              Icons.chevron_right,
              size: 16,
              color: context.tokens.textTertiary,
            ),
            onTap: () => context.push(usageReportRoute),
          ),
        ],
      ),
    );
  }
}

/// Broker-managed runtime status and recovery controls.
class _ManagedRuntimeSection extends StatelessWidget {
  const _ManagedRuntimeSection({
    required this.state,
    required this.quota,
    required this.quotaLoading,
    required this.onRefresh,
    required this.onPolicyChanged,
    required this.onRestartRuntime,
    required this.onRestartEverything,
    required this.onQuotaChanged,
  });

  final AsyncValue<ManagedRuntimeSettingsState> state;
  final TokdashQuotaResponse? quota;
  final bool quotaLoading;
  final Future<void> Function() onRefresh;
  final Future<void> Function(String value) onPolicyChanged;
  final Future<void> Function(AgentRuntimeUpdateStatus update) onRestartRuntime;
  final Future<void> Function() onRestartEverything;
  final Future<void> Function({required bool enabled}) onQuotaChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    Widget runtimes({required Widget child, String? description}) =>
        SettingsSection(
          key: const Key('settings-managed-runtimes'),
          title: l10n.settingsManagedAgentRuntimesTitle,
          description: description,
          child: child,
        );
    return state.when(
      loading: () => runtimes(
        child: const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Center(child: CircularProgressIndicator()),
        ),
      ),
      error: (error, _) => runtimes(
        child: _RuntimeError(error: error, onRetry: onRefresh),
      ),
      data: (data) {
        if (!data.connected) {
          return runtimes(child: Text(l10n.settingsConnectToInspectRuntimes));
        }
        final owner = data.ownerOperationsAvailable;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            runtimes(
              // Ownership explains the policy and restart controls, so it is
              // said only where those controls are shown.
              description: owner ? l10n.settingsRuntimeOwnershipNotice : null,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (owner)
                    _RuntimePolicyControl(
                      value: data.codexUpdatePolicy,
                      onChanged: onPolicyChanged,
                    ),
                  for (final update in data.updates)
                    _RuntimeStatusRow(
                      update: update,
                      onRestart: owner ? () => onRestartRuntime(update) : null,
                    ),
                  if (owner)
                    SettingsRow(
                      key: const Key('settings-restart-everything'),
                      leading: Icon(
                        Icons.restart_alt,
                        size: 18,
                        color: tokens.statusError,
                      ),
                      title: Text(
                        l10n.settingsRestartEverythingAction,
                        style: TextStyle(color: tokens.statusError),
                      ),
                      onTap: () => unawaited(onRestartEverything()),
                    ),
                  if (data.actionMessage != null)
                    SelectableText(
                      data.actionMessage!,
                      key: const Key('settings-runtime-action-message'),
                      style: theme.textTheme.bodySmall,
                    ),
                  if (data.actionError != null)
                    SelectableText(
                      l10n.settingsRuntimeActionFailed(data.actionError!),
                      key: const Key('settings-runtime-action-error'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: tokens.statusError,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            // Only what remains in each quota window. What was used lives in
            // the usage report, linked below.
            QuotaStatusPanel(quota: quota, loading: quotaLoading),
            if (owner)
              SettingsSwitchRow(
                tileKey: const Key('settings-quota-warnings'),
                title: l10n.settingsQuotaWarningsTitle,
                subtitle: l10n.settingsQuotaWarningsSubtitle,
                value: data.quotaWarningsEnabled,
                onChanged: (value) => unawaited(onQuotaChanged(enabled: value)),
              ),
          ],
        );
      },
    );
  }
}

class _RuntimePolicyControl extends StatelessWidget {
  const _RuntimePolicyControl({required this.value, required this.onChanged});

  final String? value;
  final Future<void> Function(String value) onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final selected = knownCodexUpdatePolicies.contains(value)
        ? value
        : 'when-detached';
    return SettingsRow(
      stackTrailing: true,
      title: Text(l10n.settingsAutomaticUpdatePolicyLabel),
      subtitle: Text(l10n.settingsAutomaticUpdatePolicyHint),
      trailing: SettingsSelect<String>(
        key: const Key('settings-runtime-policy'),
        value: selected!,
        options: [
          SettingsSelectOption(
            value: 'when-detached',
            label: l10n.settingsPolicyWhenDetached,
          ),
          SettingsSelectOption(
            value: 'when-idle',
            label: l10n.settingsPolicyWhenIdle,
          ),
        ],
        onChanged: (next) => unawaited(onChanged(next)),
      ),
    );
  }
}

class _RuntimeStatusRow extends StatelessWidget {
  const _RuntimeStatusRow({required this.update, required this.onRestart});

  final AgentRuntimeUpdateStatus update;
  final Future<void> Function()? onRestart;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final pending = _runtimeRestartIsPending(update);
    final detail = theme.textTheme.bodySmall?.copyWith(
      color: tokens.textTertiary,
    );
    final restart = onRestart;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: UsageAgentLogo(
              tool: switch (update.agent) {
                'pi' => 'pi_agent',
                _ => update.agent,
              },
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        update.displayName,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: tokens.textPrimary,
                        ),
                      ),
                      if (pending)
                        StatusPill(
                          label: l10n.settingsUpdateReady,
                          color: tokens.statusNeedsInput,
                          dense: true,
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(_runtimePendingChangeCopy(update, l10n), style: detail),
                  Text(_runtimeBlockerCopy(update, l10n), style: detail),
                ],
              ),
            ),
          ),
          // The recovery control stays reachable with nothing pending: a
          // wedged daemon reports no pending change, and gating the button on
          // one left the only escape hatch behind a failure it cannot see.
          // `managed` still gates it, because that is the broker's own claim
          // to this runtime's lifecycle. Without it the restart route can
          // only refuse, and that refusal caches an error state onto every
          // connected client.
          if (restart != null && update.managed) ...[
            const SizedBox(width: 8),
            TextButton(
              key: Key('settings-restart-runtime-${update.agent}'),
              onPressed: () => unawaited(restart()),
              style: TextButton.styleFrom(
                foregroundColor: pending
                    ? tokens.textPrimary
                    : tokens.statusError,
              ),
              child: Text(
                pending
                    ? l10n.settingsRestartNow
                    : l10n.settingsForceRestartRuntimeAction,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// Config-only status wording follows
// docs/architecture/client-ui.md: do not present
// equal binary versions as an upgrade when configuration caused the restart.
String _runtimePendingChangeCopy(
  AgentRuntimeUpdateStatus update,
  AppLocalizations l10n,
) {
  final config = update.pendingChanges.contains('configuration');
  final unknown = l10n.settingsRuntimeVersionUnknown;
  final versions = l10n.settingsRuntimeVersionsRow(
    update.runningVersion ?? unknown,
    update.installedVersion ?? unknown,
  );
  return config
      ? l10n.settingsRuntimeVersionsRowConfigChanged(versions)
      : versions;
}

String _runtimeBlockerCopy(
  AgentRuntimeUpdateStatus update,
  AppLocalizations l10n,
) {
  final blockers = update.blockerComposition;
  if (blockers != null) {
    return l10n.settingsRuntimeBlockersComposition(
      '${blockers.working}',
      '${blockers.needsInput}',
      '${blockers.idle}',
      '${blockers.unknown}',
    );
  }
  if (update.blockers == null) {
    // The broker probes loaded-thread activity only to decide whether a pending
    // change may be applied, so a current runtime carries no blocker count.
    // Reading that absence as a failed probe reported a fault on a healthy row.
    // Keyed on the reported state rather than on the missing pending change: an
    // errored or unavailable runtime has none either and is not up to date.
    if (update.state == 'current') return l10n.settingsRuntimeNoRestartNeeded;
    // A provider that cleared its own safety gate proved there is no blocker,
    // whether or not it reports counts: OpenCode gates on session activity and
    // never sends any. Calling that a blocked restart contradicted the same
    // row's "Update ready" pill.
    if (update.autoRestartReady) return l10n.settingsRuntimeNoBlockingSessions;
    // Deliberately the same line whether or not `update.detail` exists:
    // appending a raw diagnostic told the user nothing they could act on.
    return l10n.settingsRuntimeActivityUnavailable;
  }
  return l10n.settingsRuntimeBlockersCount('${update.blockers}');
}

// Whether this runtime carries a change a restart would apply. The row's pill
// and button label and the confirm dialog all key off it: without a pending
// change a restart applies nothing and only recovers a stuck runtime.
bool _runtimeRestartIsPending(AgentRuntimeUpdateStatus update) =>
    update.updateAvailable || update.state == 'pending';

class _RuntimeError extends StatelessWidget {
  const _RuntimeError({required this.error, required this.onRetry});

  final Object error;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l10n.settingsRuntimeStatusUnavailable),
        const SizedBox(height: 4),
        SelectableText(
          l10n.settingsRuntimeLoadFailedDetail(failureDetail(error)),
          key: const Key('settings-runtime-load-error'),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        TextButton(
          onPressed: () => unawaited(onRetry()),
          child: Text(l10n.retry),
        ),
      ],
    );
  }
}
