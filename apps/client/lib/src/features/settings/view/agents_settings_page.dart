import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_status_panel.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          l10n.settingsRestartRuntimeConfirmTitle(update.displayName),
        ),
        content: Text(l10n.settingsRestartRuntimeConfirmBody),
        actions: [
          const SettingsDialogCancelButton(),
          SettingsDialogConfirmButton(label: l10n.settingsRestartNow),
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
      appBar: AppBar(title: Text(l10n.settingsCategoryAgentsTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SettingsSection(
              title: l10n.settingsManagedAgentRuntimesTitle,
              child: _ManagedRuntimeSection(
                state: managedRuntimeState,
                quota: quotaState.valueOrNull,
                quotaLoading: quotaState.isLoading,
                onRefresh: () => ref
                    .read(managedRuntimeControllerProvider.notifier)
                    .refresh(freshRuntimeProbe: true),
                onPolicyChanged: (value) =>
                    _changeRuntimePolicy(context, ref, value),
                onRestartRuntime: (update) =>
                    _restartRuntime(context, ref, update),
                onRestartEverything: () => _restartEverything(context, ref),
                onQuotaChanged: ({required enabled}) => ref
                    .read(managedRuntimeControllerProvider.notifier)
                    .setQuotaWarningsEnabled(enabled: enabled),
              ),
            ),
          ],
        ),
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
    return Column(
      key: const Key('settings-managed-runtimes'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _RuntimeOwnershipStrip(),
        const SizedBox(height: 16),
        state.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => _RuntimeError(error: error, onRetry: onRefresh),
          data: (data) {
            if (!data.connected) {
              return Text(l10n.settingsConnectToInspectRuntimes);
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _RuntimePolicyControl(
                  value: data.codexUpdatePolicy,
                  onChanged: onPolicyChanged,
                ),
                const SizedBox(height: 12),
                for (final update in data.updates) ...[
                  _RuntimeStatusRow(
                    update: update,
                    onRestart: () => onRestartRuntime(update),
                  ),
                  const SizedBox(height: 12),
                ],
                QuotaStatusPanel(quota: quota, loading: quotaLoading),
                const SizedBox(height: 12),
                SwitchListTile(
                  key: const Key('settings-quota-warnings'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(l10n.settingsQuotaWarningsTitle),
                  subtitle: Text(l10n.settingsQuotaWarningsSubtitle),
                  value: data.quotaWarningsEnabled,
                  onChanged: (value) =>
                      unawaited(onQuotaChanged(enabled: value)),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  key: const Key('settings-restart-everything'),
                  onPressed: () => unawaited(onRestartEverything()),
                  icon: const Icon(Icons.restart_alt),
                  label: Text(l10n.settingsRestartEverythingAction),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Theme.of(context).colorScheme.error,
                  ),
                ),
                if (data.actionMessage != null) ...[
                  const SizedBox(height: 8),
                  SelectableText(
                    data.actionMessage!,
                    key: const Key('settings-runtime-action-message'),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            );
          },
        ),
      ],
    );
  }
}

class _RuntimeOwnershipStrip extends StatelessWidget {
  const _RuntimeOwnershipStrip();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.secondaryContainer.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.shield_outlined, color: colors.secondary),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                AppLocalizations.of(context).settingsRuntimeOwnershipNotice,
              ),
            ),
          ],
        ),
      ),
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
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(l10n.settingsAutomaticUpdatePolicyLabel),
              const SizedBox(height: 4),
              Text(
                l10n.settingsAutomaticUpdatePolicyHint,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        DropdownButton<String>(
          key: const Key('settings-runtime-policy'),
          value: selected,
          items: [
            DropdownMenuItem(
              value: 'when-detached',
              child: Text(l10n.settingsPolicyWhenDetached),
            ),
            DropdownMenuItem(
              value: 'when-idle',
              child: Text(l10n.settingsPolicyWhenIdle),
            ),
          ],
          onChanged: (next) {
            if (next != null && next != selected) unawaited(onChanged(next));
          },
        ),
      ],
    );
  }
}

class _RuntimeStatusRow extends StatelessWidget {
  const _RuntimeStatusRow({required this.update, required this.onRestart});

  final AgentRuntimeUpdateStatus update;
  final Future<void> Function() onRestart;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final colors = Theme.of(context).colorScheme;
    final pending = update.updateAvailable || update.state == 'pending';
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          update.displayName,
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                      ),
                      StatusPill(
                        label: pending
                            ? l10n.settingsUpdateReady
                            : update.state,
                        color: pending ? colors.tertiary : colors.primary,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(_runtimePendingChangeCopy(update, l10n)),
                  const SizedBox(height: 4),
                  Text(
                    _runtimeBlockerCopy(update, l10n),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            if (pending) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.tonalIcon(
                  key: Key('settings-restart-runtime-${update.agent}'),
                  onPressed: () => unawaited(onRestart()),
                  icon: const Icon(Icons.restart_alt, size: 18),
                  label: Text(l10n.settingsRestartNow),
                ),
              ),
            ],
          ],
        ),
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
    // Deliberately the same line whether or not `update.detail` exists:
    // appending a raw diagnostic told the user nothing they could act on.
    return l10n.settingsRuntimeActivityUnavailable;
  }
  return l10n.settingsRuntimeBlockersCount('${update.blockers}');
}

class _RuntimeError extends StatelessWidget {
  const _RuntimeError({required this.error, required this.onRetry});

  final Object error;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(AppLocalizations.of(context).settingsRuntimeStatusUnavailable),
        TextButton(
          onPressed: () => unawaited(onRetry()),
          child: Text(AppLocalizations.of(context).retry),
        ),
      ],
    );
  }
}
