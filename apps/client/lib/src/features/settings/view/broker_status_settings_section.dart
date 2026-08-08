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
    final status = health?.status ?? l10n.sessionTurnStatusUnknown;
    final healthy = health?.status == 'healthy';
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        healthy ? Icons.monitor_heart_outlined : Icons.warning_amber_rounded,
        color: healthy
            ? context.tokens.statusWorking
            : context.tokens.statusError,
      ),
      title: Text(l10n.settingsBrokerHealthTitle),
      subtitle: SelectableText(
        healthy
            ? l10n.settingsBrokerHealthHealthy
            : l10n.settingsBrokerHealthUnhealthy(status),
      ),
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
    final available = update?.updateAvailable ?? false;
    final l10n = AppLocalizations.of(context);
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
          trailing: available
              ? FilledButton.tonal(
                  key: const Key('settings-update-broker'),
                  onPressed: () => unawaited(onUpdate(update!)),
                  child: Text(
                    l10n.settingsUpdateToVersion(
                      update!.latestVersion ??
                          l10n.settingsUpdateBrokerLatestFallback,
                    ),
                  ),
                )
              : StatusPill(
                  label: l10n.settingsBrokerStatusCurrent,
                  color: context.tokens.statusWorking,
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
