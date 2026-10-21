import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/view/server_storage_review_page.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/storage/data/server_storage_session.dart';
import 'package:cosyncing_client/src/formatting/file_size.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Owner storage for one captured server; local actions remain independent.
class ServerStoragePanel extends ConsumerStatefulWidget {
  /// Pins the pane to this exact saved source.
  const ServerStoragePanel({required this.profile, super.key});

  /// Server named by every review and confirmation.
  final BrokerProfile profile;
  @override
  ConsumerState<ServerStoragePanel> createState() => _ServerStoragePanelState();
}

class _ServerStoragePanelState extends ConsumerState<ServerStoragePanel> {
  late final ServerStorageSession _session;
  late final BrokerAppLifecycleMonitor _lifecycle;
  StreamSubscription<BrokerAppLifecycleState>? _lifecycleSubscription;
  bool get _foreground =>
      _lifecycle.currentState == BrokerAppLifecycleState.resumed;
  bool _loading = false;
  bool _available = false;
  bool _watching = false;
  Object? _error;
  @override
  void initState() {
    super.initState();
    _lifecycle = ref.read(sessionNotificationLifecycleMonitorProvider);
    _lifecycleSubscription = _lifecycle.stateChanges.listen((state) {
      if (mounted && state == BrokerAppLifecycleState.resumed) {
        unawaited(_watch());
      }
    });
    _session = ServerStorageSession(
      profile: widget.profile,
      database: ref.read(appDatabaseProvider),
      clientFactory: ref.read(brokerClientFactoryProvider),
    );
    unawaited(_refresh(recover: true));
  }

  @override
  void dispose() {
    unawaited(_lifecycleSubscription?.cancel());
    _session.close();
    super.dispose();
  }

  Future<void> _refresh({bool recover = false}) async {
    if (_loading || !_foreground) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await _session.refresh();
      if (recover) await _session.recover();
      if (mounted) {
        setState(() => _available = true);
        unawaited(_watch());
      }
    } on Object catch (error) {
      if (mounted) {
        setState(() {
          _error = error;
          _available = false;
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _watch() async {
    if (_watching ||
        !_foreground ||
        _session.job == null ||
        _session.job!.finished) {
      return;
    }
    _watching = true;
    try {
      while (mounted && _foreground && !_session.job!.finished) {
        await _session.progress();
        if (mounted) setState(() {});
      }
      if (mounted && _session.job!.finished) await _refresh();
    } on Object catch (error) {
      if (mounted) {
        setState(() {
          _error = error;
          _available = false;
        });
      }
    } finally {
      _watching = false;
    }
  }

  Future<void> _review(
    String category, {
    String? failedJob,
  }) async {
    final inventory = _session.inventory;
    if (!_available || inventory == null) return;
    final result = await Navigator.of(context).push<StorageCleanupJob>(
      MaterialPageRoute(
        builder: (_) => ServerStorageReviewPage(
          service: _session,
          snapshot: inventory,
          category: category,
          failedJob: failedJob,
        ),
      ),
    );
    if (!mounted) return;
    if (result != null) {
      setState(() {});
      await _watch();
      await _refresh();
    }
  }

  Future<void> _cancel() async {
    try {
      await _session.cancel();
      if (mounted) setState(() {});
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Future<void> _retryFailed() async {
    final job = _session.job;
    if (job == null || !job.finished) return;
    try {
      await _review('stored-files', failedJob: job.jobId);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final inventory = _session.inventory;
    final job = _session.job;
    final busy = job != null && !job.finished;
    String bytes(int? value) =>
        value == null ? l10n.storageUnavailable : formatFileSize(l10n, value);
    final categories = inventory?.categories;
    final partial =
        inventory?.status == 'partial' ||
        (categories?.any(
              (category) =>
                  category.bytes == null ||
                  category.eligibleBytes == null ||
                  category.quality == 'partial',
            ) ??
            false);
    final managedBytes =
        categories == null ||
            categories.every((category) => category.bytes == null)
        ? null
        : categories.fold<int>(
            0,
            (total, category) => total + (category.bytes ?? 0),
          );
    final removableBytes = partial
        ? null
        : categories?.fold<int>(
            0,
            (total, category) => total + (category.eligibleBytes ?? 0),
          );
    final failure = _error;
    final message = failure is BrokerException && failure.statusCode == 403
        ? l10n.storageOwnerRequired
        : failure is BrokerException && failure.statusCode == 404
        ? l10n.storageUpdateServer
        : l10n.storageFailed;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SettingsRow(
          title: Text(widget.profile.displayName),
          subtitle: Text(l10n.storageServerScope(widget.profile.displayName)),
          trailing: TextButton(
            onPressed: _loading || (busy && failure == null)
                ? null
                : () => _refresh(recover: true),
            child: Text(l10n.refresh),
          ),
        ),
        if (_loading) Text(l10n.storageLoading),
        if (failure != null)
          ContextualDetails(
            label: message,
            detail: failureDetail(failure),
            child: Text(message),
          ),
        if (inventory != null) ...[
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
            l10n.storageMeasuredAt(
              [
                MaterialLocalizations.of(
                  context,
                ).formatShortDate(inventory.measuredAt),
                MaterialLocalizations.of(context).formatTimeOfDay(
                  TimeOfDay.fromDateTime(inventory.measuredAt),
                ),
              ].join(' '),
            ),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (!_available) Text(l10n.storageStale),
          if (inventory.status == 'partial') Text(l10n.storagePartial),
          const SizedBox(height: 16),
          for (final category in inventory.categories) ...[
            SettingsSection(
              title: category.id == 'stored-files'
                  ? l10n.storageFiles
                  : l10n.storageTemporary,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    l10n.storageUsage(
                      bytes(category.bytes),
                      category.itemCount,
                      bytes(category.eligibleBytes),
                    ),
                  ),
                  if (category.quality == 'partial') Text(l10n.storagePartial),
                  if (category.itemCount == 0) Text(l10n.storageEmpty),
                  TextButton(
                    onPressed: !_available || busy
                        ? null
                        : () => _review(category.id),
                    child: Text(
                      category.id == 'stored-files'
                          ? l10n.storageStoredFiles
                          : l10n.storageReview,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],
        ],
        if (job != null) ...[
          if (busy)
            Text(
              failure != null
                  ? l10n.storageCheckingResult
                  : l10n.storageRemoving,
            ),
          Text(
            l10n.storageResult(
              job.removed,
              job.missing,
              job.skipped,
              job.failed,
              bytes(job.reclaimedBytes),
            ),
          ),
          if (job.state == 'canceled') Text(l10n.canceled),
          if (busy)
            TextButton(
              onPressed: _cancel,
              child: Text(l10n.storageCancelRemaining),
            ),
          if (job.finished && job.failed > 0 && _available)
            TextButton(
              onPressed: _retryFailed,
              child: Text(l10n.storageRetryFailed),
            ),
        ],
      ],
    );
  }
}
