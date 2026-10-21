import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/broker_profiles/view/add_server_sheet.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_cache.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/view/device_storage_review_page.dart';
import 'package:cosyncing_client/src/features/settings/view/server_storage_panel.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/storage/data/device_storage_providers.dart';
import 'package:cosyncing_client/src/features/storage/data/device_storage_service.dart';
import 'package:cosyncing_client/src/formatting/file_size.dart';
import 'package:flutter/foundation.dart';
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
  bool _serverScope = false;
  BrokerProfile? _selectedServer;
  bool _loading = false;
  DeviceStorageSnapshot? _snapshot;
  DeviceStorageResult? _result;
  Future<DeviceStorageResult>? _observedJob;
  String? _error;

  @override
  void initState() {
    super.initState();
    _selectedServer = ref.read(activeBrokerProfileProvider);
    final service = ref.read(deviceStorageServiceProvider);
    _snapshot = service.latest;
    _result = service.result;
    _loading = true;
    // Let the first frame return to the platform before admitting database
    // and file work. Post-frame callbacks still run inside frame dispatch;
    // a queued event lets the browser/native view present the cached content.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(
        Future<void>(() async {
          if (mounted) await _refresh();
        }),
      );
    });
    _observePending();
  }

  void _observePending() {
    final service = ref.read(deviceStorageServiceProvider);
    if (service.pending case final pending? when pending != _observedJob) {
      _observedJob = pending;
      _pending = true;
      unawaited(
        pending.then(
          (result) {
            if (mounted) {
              setState(() {
                _pending = false;
                _result = result;
              });
              unawaited(_refresh());
            }
          },
          onError: (Object error, StackTrace stack) {
            if (mounted) {
              setState(() {
                _pending = false;
                _error = error.toString();
              });
            }
          },
        ),
      );
    }
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    if (ref.read(sessionNotificationLifecycleMonitorProvider).currentState !=
        BrokerAppLifecycleState.resumed) {
      // Accepted cleanup may finish in the background. Keep its result and
      // the last measurement without starting another inventory scan.
      if (_loading) setState(() => _loading = false);
      return;
    }
    if (!_loading || _error != null) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final snapshot = await ref.read(deviceStorageServiceProvider).scan();
      if (mounted) {
        setState(() {
          _snapshot = snapshot;
          _result = ref.read(deviceStorageServiceProvider).result ?? _result;
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _review(
    String category, {
    String? failedPlan,
  }) async {
    final snapshot = _snapshot;
    if (snapshot == null || _pending) return;
    final result = await Navigator.of(context).push<DeviceStorageResult>(
      MaterialPageRoute(
        builder: (_) => DeviceStorageReviewPage(
          service: ref.read(deviceStorageServiceProvider),
          snapshot: snapshot,
          category: category,
          failedPlan: failedPlan,
        ),
      ),
    );
    if (!mounted) return;
    _observePending();
    if (result != null) setState(() => _result = result);
    await _refresh();
  }

  Future<void> _clear() async {
    if (_pending) return;
    setState(() => _pending = true);
    final l10n = AppLocalizations.of(context);
    final service = ref.read(deviceStorageServiceProvider);
    var success = false;
    var accepted = false;
    try {
      final snapshot = _snapshot ?? await service.scan();
      final temporary = await service.plan(snapshot.id, category: 'temporary');
      final cache = ref.read(sessionCacheManagementProvider);
      final cachePlan = await cache.previewClear();
      if (!mounted) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l10n.sessionClearAllCacheConfirmTitle),
          content: Text(
            l10n.storageCacheConfirm(
              cachePlan.snapshots,
              formatFileSize(l10n, cachePlan.logicalBytes),
              temporary.count,
              formatFileSize(l10n, temporary.bytes),
            ),
          ),
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
      accepted = true;
      await cache.clearReviewed(cachePlan);
      final removed = await service.execute(temporary);
      if (mounted) setState(() => _result = removed);
      success = removed.failed == 0;
    } on Object catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _pending = false);
    }
    if (!mounted || !accepted) return;
    unawaited(_refresh());
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
    final snapshot = _snapshot;
    final servers = _serverScope
        ? ref.watch(brokerProfileListProvider).valueOrNull ??
              const <BrokerProfile>[]
        : const <BrokerProfile>[];
    String bytes(int? count) =>
        count == null ? l10n.storageUnavailable : formatFileSize(l10n, count);
    final managed = snapshot?.categories.where(
      (category) =>
          category.id != 'unmanaged' &&
          (!kIsWeb || (category.id != 'files' && category.id != 'temporary')),
    );
    final partial =
        managed?.any(
          (category) => category.partial || category.bytes == null,
        ) ??
        false;
    final measured = managed?.where((category) => category.bytes != null);
    final managedBytes = measured == null || measured.isEmpty
        ? null
        : measured.fold<int>(0, (total, category) => total + category.bytes!);
    final removableBytes = partial
        ? null
        : managed?.fold<int>(
            0,
            (total, category) => total + category.eligibleBytes,
          );
    return Scaffold(
      appBar: AppBar(title: Text(l10n.storageTitle)),
      body: SettingsPageBody(
        children: [
          SegmentedButton<bool>(
            expandedInsets: EdgeInsets.zero,
            segments: [
              ButtonSegment(value: false, label: Text(l10n.storageDevice)),
              ButtonSegment(value: true, label: Text(l10n.storageServer)),
            ],
            selected: {_serverScope},
            onSelectionChanged: (selected) =>
                setState(() => _serverScope = selected.single),
          ),
          const SizedBox(height: 16),
          if (_serverScope) ...[
            if (servers.isNotEmpty)
              DropdownButton<String>(
                key: const Key('storage-server-picker'),
                isExpanded: true,
                value:
                    servers.any((profile) => profile.id == _selectedServer?.id)
                    ? _selectedServer?.id
                    : null,
                hint: Text(l10n.storageServer),
                items: [
                  for (final profile in servers)
                    DropdownMenuItem(
                      value: profile.id,
                      child: Text(profile.displayName),
                    ),
                ],
                onChanged: (id) => setState(
                  () => _selectedServer = servers.firstWhere(
                    (profile) => profile.id == id,
                  ),
                ),
              ),
            if (_selectedServer case final selected?
                when servers.any(
                  (profile) =>
                      profile.id == selected.id &&
                      profile.incarnationId == selected.incarnationId,
                ))
              ServerStoragePanel(
                key: ValueKey(
                  '${selected.id}:${selected.incarnationId}:'
                  '${selected.baseUri}',
                ),
                profile: selected,
              )
            else
              TextButton(
                onPressed: () => showAddServerChoices(context),
                child: Text(l10n.serversAddTitle),
              ),
          ] else ...[
            SettingsRow(
              title: Text(l10n.storageDevice),
              subtitle: Text(l10n.storageDeviceScope),
              trailing: TextButton(
                onPressed: _loading || _pending ? null : _refresh,
                child: Text(l10n.refresh),
              ),
            ),
            if (_loading) Text(l10n.storageLoading),
            if (snapshot != null) ...[
              Text(
                partial
                    ? l10n.storagePartialSummary(
                        bytes(managedBytes),
                        bytes(removableBytes),
                      )
                    : l10n.storageSummary(
                        bytes(managedBytes),
                        bytes(removableBytes),
                      ),
              ),
              Text(
                l10n.storageDeviceSummaryHelp,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            if (snapshot != null)
              Text(
                l10n.storageMeasuredAt(
                  [
                    MaterialLocalizations.of(
                      context,
                    ).formatShortDate(snapshot.measuredAt),
                    MaterialLocalizations.of(context).formatTimeOfDay(
                      TimeOfDay.fromDateTime(snapshot.measuredAt),
                    ),
                  ].join(' '),
                ),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            if (_error != null)
              ContextualDetails(
                label: l10n.storageFailed,
                detail: _error,
                child: Text(l10n.storageFailed),
              ),
            const SizedBox(height: 16),
            SettingsSection(
              title: l10n.storageCacheTitle,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (snapshot != null)
                    for (final category in snapshot.categories.where(
                      (c) => c.id == 'cache',
                    ))
                      Text(
                        l10n.storageSnapshotUsage(
                          bytes(category.bytes),
                          category.count,
                          bytes(
                            category.partial ? null : category.eligibleBytes,
                          ),
                        ),
                      ),
                  SettingsRow(
                    key: const Key('storage-clear-cache'),
                    title: Text(l10n.sessionClearAllCache),
                    subtitle: Text(l10n.sessionClearAllCacheDescription),
                    onTap: _pending ? null : _clear,
                  ),
                  Text(
                    l10n.storageDatabaseEstimate,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            for (final id in ['files', 'temporary']) ...[
              SettingsSection(
                title: id == 'files'
                    ? l10n.storageFiles
                    : l10n.storageTemporary,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (snapshot != null)
                      for (final category in snapshot.categories.where(
                        (c) => c.id == id,
                      )) ...[
                        Text(
                          l10n.storageUsage(
                            bytes(category.bytes),
                            category.count,
                            bytes(
                              category.partial ? null : category.eligibleBytes,
                            ),
                          ),
                        ),
                        if (category.partial) Text(l10n.storagePartial),
                        if (category.count == 0) Text(l10n.storageEmpty),
                      ],
                    Text(
                      id == 'files'
                          ? l10n.storageFilesHelp
                          : l10n.storageTemporaryHelp,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    if (kIsWeb && id == 'files')
                      Text(
                        l10n.storageMemory,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    TextButton(
                      key: Key('storage-review-$id'),
                      onPressed: snapshot == null || _pending
                          ? null
                          : () => _review(id),
                      child: Text(l10n.storageReview),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],
            if (snapshot != null)
              for (final category in snapshot.categories.where(
                (category) => category.id == 'unmanaged',
              ))
                SettingsRow(
                  title: Text(l10n.storageUnmanaged),
                  subtitle: Text(
                    [
                      bytes(category.bytes),
                      l10n.storageUnmanagedHelp,
                      if (category.partial) l10n.storagePartial,
                    ].join(' · '),
                  ),
                ),
            SettingsSection(
              title: l10n.storageDataTitle,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (snapshot != null)
                    for (final category in snapshot.categories.where(
                      (c) => c.id == 'app-data',
                    ))
                      Text(bytes(category.bytes)),
                  Text(l10n.storageDataDescription),
                  SettingsRow(
                    title: Text(l10n.storagePhysicalDatabase),
                    subtitle: Text(l10n.storagePhysicalDatabaseHelp),
                    trailing: Text(bytes(snapshot?.physicalDatabaseBytes)),
                  ),
                ],
              ),
            ),
            if (_result case final result?) ...[
              const SizedBox(height: 16),
              Text(
                l10n.storageResult(
                  result.removed,
                  result.missing,
                  result.skipped,
                  result.failed,
                  bytes(result.bytes),
                ),
              ),
              if (result.canceled) Text(l10n.canceled),
              if (result.failed > 0)
                TextButton(
                  onPressed: () => _review('files', failedPlan: result.planId),
                  child: Text(l10n.storageRetryFailed),
                ),
            ],
            if (_pending &&
                ref.read(deviceStorageServiceProvider).pending != null)
              TextButton(
                onPressed: ref
                    .read(deviceStorageServiceProvider)
                    .cancelRemaining,
                child: Text(l10n.storageCancelRemaining),
              ),
          ],
        ],
      ),
    );
  }
}
