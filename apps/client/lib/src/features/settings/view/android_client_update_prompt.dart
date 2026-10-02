import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update_prompt_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Versions this process has already offered, whether or not the dialog is
/// still open. Scoped to the container so each test starts clean.
final androidUpdateOfferedVersionsProvider = Provider<Set<String>>(
  (ref) => <String>{},
);

/// Offers a newly found Android update once, as a dialog the user can close.
///
/// It replaces a banner that pinned itself over every screen and could not be
/// dismissed. The dialog appears once per release version. Closing it by any
/// route records that version, so a later launch does not ask again. The offer
/// itself stays in Settings → General, whose entry carries the update dot, so
/// closing the dialog never loses the update.
///
/// Must sit below a [Navigator]: the dialog is a real route, so Android's back
/// gesture and the barrier close it like any other dialog.
class AndroidClientUpdatePrompt extends ConsumerStatefulWidget {
  /// Creates the prompt host around [child].
  const AndroidClientUpdatePrompt({required this.child, super.key});

  /// The app content the prompt is shown over.
  final Widget child;

  @override
  ConsumerState<AndroidClientUpdatePrompt> createState() =>
      _AndroidClientUpdatePromptState();
}

class _AndroidClientUpdatePromptState
    extends ConsumerState<AndroidClientUpdatePrompt> {
  @override
  void initState() {
    super.initState();
    ref.listenManual(
      androidClientUpdateControllerProvider,
      (_, next) => unawaited(_offer(next.valueOrNull)),
      fireImmediately: true,
    );
  }

  Future<void> _offer(AndroidClientUpdateState? update) async {
    final candidate = update?.candidate;
    if (update?.status != AndroidClientUpdateStatus.available ||
        candidate == null) {
      return;
    }
    final version = candidate.version;
    // Claimed before the read, so the periodic re-check cannot open a second
    // dialog for the same version while the first read is still pending.
    if (!ref.read(androidUpdateOfferedVersionsProvider).add(version)) return;
    final store = ref.read(androidUpdatePromptStoreProvider);
    String? dismissed;
    try {
      dismissed = await store.dismissedVersion();
    } on Object {
      // An unreadable record must not hide an update; offering it once more
      // is the recoverable mistake.
      dismissed = null;
    }
    if (!mounted || dismissed == version) return;
    await showDialog<void>(
      context: context,
      builder: (_) => const AndroidClientUpdateDialog(),
    );
    try {
      await store.setDismissedVersion(version);
    } on Object {
      // Best effort: the worst case is the same offer on the next launch.
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// The update offer, following the download through to Android's installer.
///
/// Every state keeps a way out. Closing mid-download, or leaving the app,
/// leaves the download running under its own notification, and Settings →
/// General shows its progress.
class AndroidClientUpdateDialog extends ConsumerStatefulWidget {
  /// Creates the dialog.
  const AndroidClientUpdateDialog({super.key});

  @override
  ConsumerState<AndroidClientUpdateDialog> createState() =>
      _AndroidClientUpdateDialogState();
}

class _AndroidClientUpdateDialogState
    extends ConsumerState<AndroidClientUpdateDialog> {
  /// The last settled state. A re-check passes through a loading state with
  /// no value, and the dialog must not blank out while it does.
  AndroidClientUpdateState? _last;
  bool _closed = false;

  void _close() {
    if (_closed || !mounted) return;
    _closed = true;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(androidClientUpdateControllerProvider, (_, next) {
      final value = next.valueOrNull;
      if (value == null) return;
      // Android's installer has taken over, or nothing is left to install.
      final done = switch (value.status) {
        AndroidClientUpdateStatus.installerLaunched ||
        AndroidClientUpdateStatus.current ||
        AndroidClientUpdateStatus.unsupported => true,
        AndroidClientUpdateStatus.failed => value.candidate == null,
        _ => false,
      };
      if (done) _close();
    });
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final update =
        ref.watch(androidClientUpdateControllerProvider).valueOrNull ?? _last;
    _last = update;
    final candidate = update?.candidate;
    final status = update?.status;
    final downloading = status == AndroidClientUpdateStatus.downloading;
    // Downloaded while the app was out of sight: the installer opens as soon
    // as it is back in front, so there is nothing left to press.
    final ready = status == AndroidClientUpdateStatus.readyToInstall;
    final opening = status == AndroidClientUpdateStatus.openingInstaller;
    final permission = status == AndroidClientUpdateStatus.permissionRequired;
    final failed = status == AndroidClientUpdateStatus.failed;
    final busy = downloading || ready || opening;

    final message = candidate == null
        ? ''
        : permission
        ? l10n.androidUpdatePermissionBody
        : downloading
        ? l10n.androidUpdateDownloadingBody(candidate.version)
        : ready
        ? l10n.androidUpdateReadyBody(candidate.version)
        : opening
        ? l10n.androidUpdateOpeningBody
        : failed
        ? l10n.settingsAndroidAppUpdateInstallFailed
        : l10n.androidUpdateAvailableBody(candidate.version);

    return AlertDialog(
      key: const Key('android-client-update-dialog'),
      icon: Icon(Icons.system_update_alt, color: tokens.accent),
      title: Text(l10n.androidUpdateAvailableTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(message, style: theme.textTheme.bodyMedium),
          if (busy) ...[
            const SizedBox(height: 12),
            LinearProgressIndicator(
              key: const Key('android-client-update-progress'),
              value: downloading
                  ? update?.progress
                  : ready
                  ? 1
                  : null,
            ),
          ],
          const SizedBox(height: 12),
          Text(
            l10n.androidUpdateSettingsHint,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          key: const Key('android-client-update-later'),
          onPressed: _close,
          child: Text(busy ? l10n.close : l10n.androidUpdateLater),
        ),
        if (!busy && candidate != null)
          FilledButton(
            key: const Key('android-client-update-action'),
            onPressed: () => unawaited(
              ref
                  .read(androidClientUpdateControllerProvider.notifier)
                  .downloadAndInstall(),
            ),
            child: Text(
              permission
                  ? l10n.androidUpdatePermissionAction
                  : l10n.androidUpdateAction,
            ),
          ),
      ],
    );
  }
}
