import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_cache.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-local storage controls; clearing cache preserves authored data.
class StorageSettingsPage extends ConsumerStatefulWidget {
  /// Creates the local storage page.
  const StorageSettingsPage({super.key});

  @override
  ConsumerState<StorageSettingsPage> createState() =>
      _StorageSettingsPageState();
}

class _StorageSettingsPageState extends ConsumerState<StorageSettingsPage> {
  bool _pending = false;

  Future<void> _clear() async {
    if (_pending) return;
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.sessionClearAllCacheConfirmTitle),
        content: Text(l10n.sessionClearAllCacheConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            key: const Key('storage-clear-cache-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.sessionClearAllCacheConfirm),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    setState(() => _pending = true);
    var success = false;
    try {
      await ref.read(sessionCacheManagementProvider).clearAll();
      success = true;
    } on Object {
      success = false;
    }
    if (!mounted) return;
    setState(() => _pending = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          success
              ? l10n.sessionAllCacheCleared
              : l10n.sessionAllCacheClearFailed,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.storageTitle)),
      body: SettingsPageBody(
        children: [
          SettingsSection(
            title: l10n.storageCacheTitle,
            child: ListTile(
              key: const Key('storage-clear-cache'),
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.delete_sweep_outlined),
              title: Text(l10n.sessionClearAllCache),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l10n.storageCacheScope),
                  Text(l10n.sessionClearAllCacheDescription),
                ],
              ),
              enabled: !_pending,
              onTap: _clear,
            ),
          ),
          const SizedBox(height: 16),
          SettingsSection(
            title: l10n.storageDataTitle,
            child: Text(l10n.storageDataDescription),
          ),
        ],
      ),
    );
  }
}
