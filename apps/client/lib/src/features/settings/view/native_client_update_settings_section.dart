import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

Future<bool> _confirmAppDownload(
  BuildContext context, {
  required String installedVersion,
  required String targetVersion,
  required bool android,
}) async {
  final l = AppLocalizations.of(context);
  return await showModalBottomSheet<bool>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (context) => SafeArea(
          child: SingleChildScrollView(
            child: Padding(
              key: const Key('settings-native-client-update-confirmation'),
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    l.updatesUpdateApp,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 16),
                  Text(l.updatesVersionChange(installedVersion, targetVersion)),
                  const SizedBox(height: 8),
                  Text(
                    android
                        ? l.updatesAndroidInstallerNotice
                        : l.updatesDownloadNotice,
                  ),
                  const SizedBox(height: 24),
                  Wrap(
                    alignment: WrapAlignment.end,
                    spacing: 8,
                    children: [
                      TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: Text(l.cancel),
                      ),
                      FilledButton(
                        key: const Key('settings-native-client-update-confirm'),
                        onPressed: () => Navigator.pop(context, true),
                        child: Text(l.updatesDownload),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ) ??
      false;
}

/// Native client version and manual update controls.
class NativeClientUpdateSettingsSection extends ConsumerWidget {
  /// Creates the native client update settings section.
  const NativeClientUpdateSettingsSection({super.key});

  Future<void> _openDesktopDownload(
    BuildContext context,
    WidgetRef ref,
    Uri url,
  ) async {
    var launched = false;
    try {
      launched = await ref.read(desktopDownloadLauncherProvider)(url);
    } on Object {
      launched = false;
    }
    if (launched || !context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).settingsDesktopBuildUpdateLaunchFailed,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final platform = ref.watch(clientTargetPlatformProvider);
    if (platform == TargetPlatform.android) {
      return _AndroidUpdateRow(
        update: ref.watch(androidClientUpdateControllerProvider),
        installedVersion: ref.watch(androidClientVersionProvider),
      );
    }
    return _DesktopUpdateRow(
      update: ref.watch(desktopClientUpdateControllerProvider),
      installedVersion: ref.watch(desktopClientVersionProvider),
      onOpen: (url) => _openDesktopDownload(context, ref, url),
    );
  }
}

class _DesktopUpdateRow extends ConsumerWidget {
  const _DesktopUpdateRow({
    required this.update,
    required this.installedVersion,
    required this.onOpen,
  });

  final AsyncValue<DesktopClientUpdateState> update;
  final String installedVersion;
  final Future<void> Function(Uri url) onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final state = update.valueOrNull;
    if (state?.status == DesktopClientUpdateStatus.unsupported) {
      return const SizedBox.shrink();
    }
    final checking = update.isLoading;
    final candidate = state?.candidate;
    final statusText = checking
        ? l10n.settingsAndroidAppUpdateChecking
        : switch (state?.status) {
            DesktopClientUpdateStatus.current =>
              l10n.settingsAndroidAppUpdateCurrent,
            DesktopClientUpdateStatus.available =>
              l10n.androidUpdateAvailableBody(candidate!.version),
            DesktopClientUpdateStatus.failed =>
              l10n.settingsAndroidAppUpdateCheckFailed,
            _ => l10n.settingsAndroidAppUpdateChecking,
          };
    return _UpdateSectionShell(
      installedVersion: installedVersion,
      statusText: statusText,
      checking: checking,
      trailing: candidate != null
          ? FilledButton.tonal(
              key: const Key('settings-native-client-update-download'),
              onPressed: () async {
                final accepted = await _confirmAppDownload(
                  context,
                  installedVersion: installedVersion,
                  targetVersion: candidate.version,
                  android: false,
                );
                if (accepted && context.mounted) await onOpen(candidate.url);
              },
              child: Text(l10n.updatesUpdateApp),
            )
          : TextButton(
              key: const Key('settings-native-client-update-check'),
              onPressed: () => unawaited(
                ref
                    .read(desktopClientUpdateControllerProvider.notifier)
                    .check(),
              ),
              child: Text(
                state?.status == DesktopClientUpdateStatus.failed
                    ? l10n.retry
                    : l10n.updatesCheckAgain,
              ),
            ),
    );
  }
}

class _AndroidUpdateRow extends ConsumerWidget {
  const _AndroidUpdateRow({
    required this.update,
    required this.installedVersion,
  });

  final AsyncValue<AndroidClientUpdateState> update;
  final String installedVersion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final state = update.valueOrNull;
    if (state?.status == AndroidClientUpdateStatus.unsupported) {
      return const SizedBox.shrink();
    }
    final status = state?.status;
    final candidate = state?.candidate;
    final checking = update.isLoading;
    final downloading = status == AndroidClientUpdateStatus.downloading;
    final ready = status == AndroidClientUpdateStatus.readyToInstall;
    final opening = status == AndroidClientUpdateStatus.openingInstaller;
    final permission = status == AndroidClientUpdateStatus.permissionRequired;
    final retryInstall =
        status == AndroidClientUpdateStatus.failed && candidate != null;
    final statusText = checking
        ? l10n.settingsAndroidAppUpdateChecking
        : switch (status) {
            AndroidClientUpdateStatus.current =>
              l10n.settingsAndroidAppUpdateCurrent,
            AndroidClientUpdateStatus.available =>
              l10n.androidUpdateAvailableBody(candidate!.version),
            AndroidClientUpdateStatus.downloading =>
              l10n.androidUpdateDownloadingBody(candidate!.version),
            AndroidClientUpdateStatus.readyToInstall =>
              l10n.androidUpdateReadyBody(candidate!.version),
            AndroidClientUpdateStatus.openingInstaller =>
              l10n.androidUpdateOpeningBody,
            AndroidClientUpdateStatus.permissionRequired =>
              l10n.androidUpdatePermissionBody,
            AndroidClientUpdateStatus.installerLaunched =>
              l10n.settingsAndroidAppUpdateInstallerLaunched,
            AndroidClientUpdateStatus.failed when candidate != null =>
              l10n.settingsAndroidAppUpdateInstallFailed,
            AndroidClientUpdateStatus.failed =>
              l10n.settingsAndroidAppUpdateCheckFailed,
            _ => l10n.settingsAndroidAppUpdateChecking,
          };
    final busy = checking || downloading || ready || opening;
    final canInstall =
        !checking &&
        (status == AndroidClientUpdateStatus.available ||
            permission ||
            retryInstall);
    return _UpdateSectionShell(
      installedVersion: installedVersion,
      statusText: statusText,
      checking: busy,
      progress: downloading ? state?.progress : null,
      trailing: canInstall
          ? FilledButton.tonal(
              key: const Key('settings-native-client-update-install'),
              onPressed: () async {
                if (status == AndroidClientUpdateStatus.available) {
                  final accepted = await _confirmAppDownload(
                    context,
                    installedVersion: installedVersion,
                    targetVersion: candidate!.version,
                    android: true,
                  );
                  if (!accepted || !context.mounted) return;
                }
                await ref
                    .read(androidClientUpdateControllerProvider.notifier)
                    .downloadAndInstall();
              },
              child: Text(
                permission
                    ? l10n.androidUpdatePermissionAction
                    : retryInstall
                    ? l10n.retry
                    : l10n.updatesUpdateApp,
              ),
            )
          : TextButton(
              key: const Key('settings-native-client-update-check'),
              onPressed: () => unawaited(
                ref
                    .read(androidClientUpdateControllerProvider.notifier)
                    .check(),
              ),
              child: Text(
                status == AndroidClientUpdateStatus.failed
                    ? l10n.retry
                    : l10n.updatesCheckAgain,
              ),
            ),
    );
  }
}

class _UpdateSectionShell extends StatelessWidget {
  const _UpdateSectionShell({
    required this.installedVersion,
    required this.statusText,
    required this.checking,
    required this.trailing,
    this.progress,
  });

  final String installedVersion;
  final String statusText;
  final bool checking;
  final Widget trailing;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final action = checking ? const SizedBox.shrink() : trailing;
    final details = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(
          l10n.settingsAndroidAppUpdateTitle(installedVersion),
        ),
        SelectableText(statusText),
        if (progress != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: LinearProgressIndicator(value: progress),
          ),
      ],
    );
    return SettingsSection(
      key: const Key('settings-native-client-update-section'),
      title: l10n.settingsAndroidAppUpdatesSection,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact =
              constraints.maxWidth < 480 ||
              MediaQuery.textScalerOf(context).scale(1) > 1.3;
          if (!compact) {
            return ListTile(
              key: const Key('settings-native-client-update'),
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                Icons.system_update_alt,
                color: context.tokens.accent,
              ),
              title: details,
              trailing: action,
            );
          }
          return Column(
            key: const Key('settings-native-client-update'),
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.system_update_alt,
                    color: context.tokens.accent,
                  ),
                  const SizedBox(width: 16),
                  Expanded(child: details),
                ],
              ),
              const SizedBox(height: 12),
              Align(alignment: AlignmentDirectional.centerEnd, child: action),
            ],
          );
        },
      ),
    );
  }
}
