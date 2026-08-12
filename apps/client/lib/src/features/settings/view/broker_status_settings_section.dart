import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Broker health, build compatibility, and signed-update controls.
class BrokerStatusSettingsSection extends ConsumerWidget {
  /// Creates the broker status section.
  const BrokerStatusSettingsSection({super.key});

  Future<void> _confirmUpdate(
    BuildContext context,
    WidgetRef ref,
    BrokerUpdateSnapshot update,
  ) async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.settingsUpdateBrokerConfirmTitle),
        content: SelectionArea(
          child: Text(
            l10n.settingsUpdateBrokerConfirmBody(
              update.latestVersion ?? l10n.settingsUpdateBrokerReleaseFallback,
            ),
          ),
        ),
        actions: [
          const SettingsDialogCancelButton(),
          SettingsDialogConfirmButton(label: l10n.settingsUpdateBrokerAction),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    await ref.read(managedRuntimeControllerProvider.notifier).updateBroker();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(managedRuntimeControllerProvider);
    return SettingsSection(
      title: l10n.settingsBrokerAndUpdateSection,
      child: state.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(l10n.settingsBrokerStatusUnavailable),
            TextButton(
              onPressed: () => unawaited(
                ref
                    .read(managedRuntimeControllerProvider.notifier)
                    .refresh(freshRuntimeProbe: true),
              ),
              child: Text(l10n.retry),
            ),
          ],
        ),
        data: (data) {
          if (!data.connected) {
            return SelectableText(l10n.settingsConnectToInspectBroker);
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _BrokerHealthRow(health: data.health),
              _BrokerVersionRow(
                health: data.productHealth,
                update: data.brokerUpdate,
                onUpdate: (update) => _confirmUpdate(context, ref, update),
              ),
              _DesktopBuildUpdateRow(
                brokerVersion: data.productHealth?.version,
              ),
            ],
          );
        },
      ),
    );
  }
}

class _BrokerHealthRow extends StatelessWidget {
  const _BrokerHealthRow({required this.health});

  final BrokerHealthResponse? health;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final status = health?.status;
    final healthy = status == 'healthy';
    final statusText = switch (status) {
      'healthy' => l10n.settingsBrokerHealthHealthy,
      'degraded' => l10n.settingsBrokerHealthDegraded,
      'critical' => l10n.settingsBrokerHealthCritical,
      _ => l10n.settingsBrokerHealthUnknown,
    };
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        healthy ? Icons.monitor_heart_outlined : Icons.warning_amber_rounded,
        color: healthy
            ? context.tokens.statusWorking
            : context.tokens.statusError,
      ),
      title: Text(l10n.settingsBrokerHealthTitle),
      subtitle: SelectableText(statusText),
    );
  }
}

/// Points a native desktop build at its download page.
///
/// Renders nothing on the web and on mobile, and nothing while either version
/// is unreadable — see [desktopClientUpdateAvailable].
class _DesktopBuildUpdateRow extends ConsumerWidget {
  const _DesktopBuildUpdateRow({required this.brokerVersion});

  final String? brokerVersion;

  Future<void> _openDownload(BuildContext context, WidgetRef ref) async {
    var launched = false;
    try {
      launched = await ref.read(desktopDownloadLauncherProvider)(
        Uri.parse(desktopClientDownloadUrl),
      );
    } on Object {
      launched = false;
    }
    if (launched || !context.mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).settingsDesktopBuildUpdateLaunchFailed,
          key: const Key('settings-desktop-build-download-failure'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final available = desktopClientUpdateAvailable(
      platform: Theme.of(context).platform,
      isWeb: kIsWeb,
      brokerVersion: brokerVersion,
      clientVersion: ref.watch(desktopClientVersionProvider),
    );
    if (!available) return const SizedBox.shrink();
    final l10n = AppLocalizations.of(context);
    return ListTile(
      key: const Key('settings-desktop-build-update'),
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        Icons.download_for_offline_outlined,
        color: context.tokens.accent,
      ),
      title: SelectableText(l10n.settingsDesktopBuildUpdateTitle),
      subtitle: SelectableText(
        l10n.settingsDesktopBuildUpdateBody(brokerVersion!),
      ),
      trailing: FilledButton.tonal(
        key: const Key('settings-desktop-build-download'),
        onPressed: () => unawaited(_openDownload(context, ref)),
        child: Text(l10n.settingsDesktopBuildUpdateAction),
      ),
    );
  }
}

/// Reported when the broker is an npm package rather than a self-replacing
/// native build.
///
/// It arrives as a `status: unknown` snapshot because no release check ran at
/// all: the signed manifest describes compiled artifacts this build must never
/// install, so the broker declines to probe it.
const String _packageManagerOwnedDetail = 'upgrade-package-manager-owned';

/// Update commands, worded as the broker's own guidance words them.
const String _packageManagerUpdateCommand = 'npm update --global cosyncing';
const String _packageManagerSetupCommand = 'cosyncing setup';

class _BrokerVersionRow extends StatelessWidget {
  const _BrokerVersionRow({
    required this.health,
    required this.update,
    required this.onUpdate,
  });

  final HealthResponse? health;
  final BrokerUpdateSnapshot? update;
  final Future<void> Function(BrokerUpdateSnapshot update) onUpdate;

  @override
  Widget build(BuildContext context) {
    final contract = health?.contract;
    final snapshot = update;
    // `Current` claims a check ran and found nothing newer. Only the broker's
    // own `current` status supports that claim: an npm install never checks at
    // all, and an unreachable or unconfigured channel reports `unknown`.
    // Calling either one "Current" tells the operator they are up to date on
    // the strength of no evidence whatsoever.
    final packageManaged = snapshot?.detailCode == _packageManagerOwnedDetail;
    final checked = snapshot?.status == 'current';
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);

    Widget trailing() {
      if (snapshot != null && snapshot.updateAvailable) {
        return FilledButton.tonal(
          key: const Key('settings-update-broker'),
          onPressed: () => unawaited(onUpdate(snapshot)),
          child: Text(
            l10n.settingsUpdateToVersion(
              snapshot.latestVersion ?? l10n.settingsUpdateBrokerLatestFallback,
            ),
          ),
        );
      }
      if (packageManaged) {
        return StatusPill(
          key: const Key('settings-broker-status-package-managed'),
          label: l10n.settingsBrokerStatusPackageManaged,
          color: tokens.statusIdle,
          icon: Icons.inventory_2_outlined,
        );
      }
      if (checked) {
        return StatusPill(
          key: const Key('settings-broker-status-current'),
          label: l10n.settingsBrokerStatusCurrent,
          color: tokens.statusWorking,
        );
      }
      return StatusPill(
        key: const Key('settings-broker-status-unchecked'),
        label: l10n.settingsBrokerStatusNotChecked,
        color: tokens.statusIdle,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListTile(
          key: const Key('settings-broker-version'),
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.system_update_alt),
          title: SelectableText(
            l10n.settingsBrokerVersionTitle(
              health?.version ?? l10n.settingsBrokerVersionUnknown,
            ),
          ),
          subtitle: SelectableText(
            contract == null
                ? l10n.settingsBrokerContractLegacy
                : l10n.settingsBrokerContractCompatible,
          ),
          trailing: trailing(),
        ),
        // The pill says the broker will not update itself; this says what does.
        // Without it, the honest state is just a dead end.
        if (packageManaged)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: SelectableText(
              key: const Key('settings-broker-package-managed-body'),
              l10n.settingsBrokerPackageManagedBody(
                _packageManagerUpdateCommand,
                _packageManagerSetupCommand,
              ),
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: tokens.textSecondary),
            ),
          ),
        if (contract != null)
          ExpansionTile(
            key: const Key('settings-broker-contract-details'),
            tilePadding: EdgeInsets.zero,
            title: Text(l10n.settingsBrokerTechnicalDetails),
            children: [
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: SelectableText(
                  l10n.settingsBrokerContractDetails(
                    contract.revision,
                    contract.surfaceHash,
                  ),
                ),
              ),
            ],
          ),
      ],
    );
  }
}
