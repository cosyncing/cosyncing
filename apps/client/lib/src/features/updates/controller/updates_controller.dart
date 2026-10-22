// The public state types form the Updates screen's view model.
// ignore_for_file: public_member_api_docs
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/clock/app_clock.dart';
import 'package:cosyncing_client/src/platform/desktop/desktop_keep_running.dart';
import 'package:cosyncing_client/src/platform/update/local_desktop_updater_contract.dart';
import 'package:cosyncing_client/src/platform/update/local_desktop_updater_provider.dart';
import 'package:cosyncing_client/src/platform/update/stable_release_manifest.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const _storageKey = 'updates.v1';
const _currentContract = ClientContractIdentity(
  revision: cosyncingClientContractRevision,
  minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
  surfaceHash: cosyncingClientContractSurfaceHash,
);
String _scope(BrokerProfile p) => jsonEncode([
  p.id,
  p.incarnationId,
  p.sourceIdentity ?? p.baseUri.toString(),
  p.credentialKey,
]);
String _id() {
  final r = Random.secure();
  final bytes = List<int>.generate(16, (_) => r.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final h = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-'
      '${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

class UpdateServerRow {
  UpdateServerRow(
    this.profile, {
    this.inventory,
    this.check,
    this.error,
    this.lastSeen,
    this.grants,
    this.history = const [],
  });
  final BrokerProfile profile;
  final BrokerUpdateInventory? inventory;
  final BrokerUpdateCheck? check;
  final String? error;
  final DateTime? lastSeen;
  final BrokerUpdateGrants? grants;
  final List<BrokerUpdateHistoryEntry> history;
  bool get available =>
      error == null &&
      check?.available?.releaseId != null &&
      (inventory?.broker.canPlan ?? false) &&
      (inventory?.broker.canApply ?? false);
}

class UpdateReviewStep {
  UpdateReviewStep({
    required this.label,
    required this.from,
    required this.to,
    required this.releaseId,
    this.profile,
    this.plan,
    this.acknowledgements = const [],
    this.clientContract = _currentContract,
  });
  final String label;
  final String? from;
  final String to;
  final String releaseId;
  final BrokerProfile? profile;
  final BrokerUpdatePlan? plan;
  final List<String> acknowledgements;
  final ClientContractIdentity clientContract;
  bool get app => profile == null;
}

class UpdatesState {
  const UpdatesState({
    this.servers = const [],
    this.local,
    this.manifest,
    this.localError,
    this.review = const [],
    this.operation,
    this.checking = false,
    this.working = false,
    this.error,
  });
  final List<UpdateServerRow> servers;
  final Map<String, dynamic>? local;
  final Map<String, Object?>? manifest;
  final String? localError;
  final List<UpdateReviewStep> review;
  final Map<String, dynamic>? operation;
  bool get unfinished =>
      operation != null &&
      !const ['complete', 'cancelled'].contains(operation!['phase']);
  final bool checking;
  final bool working;
  final String? error;
  UpdatesState copy({
    List<UpdateServerRow>? servers,
    Map<String, dynamic>? local,
    Map<String, Object?>? manifest,
    String? localError,
    List<UpdateReviewStep>? review,
    Map<String, dynamic>? operation,
    bool? checking,
    bool? working,
    String? error,
    bool clearLocal = false,
    bool clearLocalError = false,
  }) => UpdatesState(
    servers: servers ?? this.servers,
    local: clearLocal ? null : local ?? this.local,
    manifest: manifest ?? this.manifest,
    localError: clearLocalError ? null : localError ?? this.localError,
    review: review ?? this.review,
    operation: operation ?? this.operation,
    checking: checking ?? this.checking,
    working: working ?? this.working,
    error: error,
  );
  String? get appReleaseId => manifest?['updater'] is Map
      ? (manifest!['updater']! as Map)['releaseId'] as String?
      : null;
  bool get appAvailable {
    if (local == null || localError != null || appReleaseId == null) {
      return false;
    }
    final metadata = manifest?['updater'] as Map?;
    final platform = (metadata?['desktop'] as Map?)?[local!['host']] as Map?;
    final caps = platform?['capabilities'] as List?;
    bool meetsFloor(String key, Object? minimum) {
      if (minimum == null) return true;
      if (minimum is! String) return false;
      final comparison = compareStableReleaseVersions(
        local![key] as String? ?? '',
        minimum,
      );
      return comparison != null && comparison >= 0;
    }

    return metadata?['schemaVersion'] == 1 &&
        metadata?['clientContract'] is Map &&
        meetsFloor('helperVersion', metadata?['minimumHelperVersion']) &&
        meetsFloor('runtimeVersion', platform?['minimumRuntimeVersion']) &&
        caps != null &&
        caps.contains('prepare') &&
        caps.contains('client-replace') &&
        caps.contains('client-relaunch') &&
        compareStableReleaseVersions(
              manifest?['version'] as String? ?? '',
              local!['version'] as String? ?? '',
            ) ==
            1;
  }

  bool get appNewer =>
      local != null &&
      compareStableReleaseVersions(
            manifest?['version'] as String? ?? '',
            local!['version'] as String? ?? '',
          ) ==
          1;
}

final updatesControllerProvider =
    AsyncNotifierProvider<UpdatesController, UpdatesState>(
      UpdatesController.new,
    );

/// Lightweight row observations; opening Servers never starts update discovery.
final savedServerUpdateObservationsProvider =
    StateProvider<List<UpdateServerRow>>((ref) => const []);

class UpdatesController extends AsyncNotifier<UpdatesState> {
  bool _disposed = false;
  Future<void> _saveTail = Future<void>.value();
  Timer? _exitWatchdog;
  bool _inputFrozen = false;
  DateTime _now() => ref.read(appClockProvider)();
  UpdatesState get _data => state.requireValue;
  void _publish(UpdatesState value) {
    if (!_disposed) {
      ref.read(savedServerUpdateObservationsProvider.notifier).state =
          value.servers;
      state = AsyncData(value);
    }
  }

  @override
  Future<UpdatesState> build() async {
    ref.onDispose(() {
      _disposed = true;
      _exitWatchdog?.cancel();
      if (_inputFrozen) WebHandoffParticipants.instance.releaseAll();
    });
    final db = ref.read(appDatabaseProvider);
    final row = await (db.select(
      db.appSettingRows,
    )..where((r) => r.key.equals(_storageKey))).getSingleOrNull();
    final profiles = await ref.read(brokerProfileRepositoryProvider).getAll();
    var cached = <String, dynamic>{};
    if (row != null) {
      // Preserve future state rather than overwriting it with an older schema.
      final value = jsonDecode(row.value) as Map<String, dynamic>;
      if (value['schemaVersion'] != 1) {
        throw const FormatException('updates-schema-unsupported');
      }
      cached = value;
    }
    final observations = cached['servers'] as Map<String, dynamic>? ?? {};
    return UpdatesState(
      operation: cached['operation'] as Map<String, dynamic>?,
      error: (cached['operation'] as Map?)?['phase'] == 'paused'
          ? (cached['operation'] as Map)['detailCode'] as String?
          : null,
      servers: profiles.map((p) {
        final v = observations[_scope(p)] as Map<String, dynamic>?;
        return UpdateServerRow(
          p,
          inventory: v?['inventory'] == null
              ? null
              : BrokerUpdateInventory.fromJson(
                  v!['inventory'] as Map<String, dynamic>,
                ),
          lastSeen: DateTime.tryParse(v?['lastSeen'] as String? ?? ''),
          error: 'not-checked',
        );
      }).toList(),
    );
  }

  Future<void> _save() async {
    if (_disposed) return;
    final data = _data;
    final db = ref.read(appDatabaseProvider);
    final snapshot = AppSettingRowsCompanion.insert(
      key: _storageKey,
      value: jsonEncode({
        'schemaVersion': 1,
        'operation': data.operation,
        'servers': {
          for (final row in data.servers)
            _scope(row.profile): {
              'inventory': row.inventory?.toJson(),
              'lastSeen': row.lastSeen?.toIso8601String(),
            },
        },
      }),
      updatedAt: _now(),
    );
    final write = _saveTail.then((_) async {
      if (_disposed) return;
      await db.transaction(() async {
        for (final row in data.servers) {
          if (!await _stillCurrent(row.profile)) return;
        }
        await db.into(db.appSettingRows).insertOnConflictUpdate(snapshot);
      });
    });
    _saveTail = write.then<void>((_) {}, onError: (Object _) {});
    await write;
  }

  Future<bool> _stillCurrent(BrokerProfile profile) async {
    if (_disposed) return false;
    final current = await ref
        .read(brokerProfileRepositoryProvider)
        .getById(profile.id);
    return !_disposed && current != null && _scope(current) == _scope(profile);
  }

  Future<BrokerClient> _client(BrokerProfile profile) async {
    if (!await _stillCurrent(profile)) {
      throw StateError('update-source-changed');
    }
    return ref.read(brokerClientFactoryProvider)(profile);
  }

  Future<bool> _admitted(BrokerProfile profile, BrokerClient client) async {
    if (!await _stillCurrent(profile)) return false;
    final key = profile.credentialKey;
    final current = key == null
        ? null
        : await ref.read(credentialStoreProvider).readBrokerToken(key);
    return !_disposed &&
        current?.trim() ==
            (client.resolver.peerToken ?? client.resolver.token)?.trim();
  }

  Future<void> refresh() async {
    if (_data.checking || _data.working) return;
    _publish(
      _data.copy(checking: true, clearLocal: true, clearLocalError: true),
    );
    final profiles = await ref.read(brokerProfileRepositoryProvider).getAll();
    final results = <String, UpdateServerRow>{};
    var index = 0;
    Future<void> worker() async {
      while (index < profiles.length && !_disposed) {
        final p = profiles[index++];
        final old = _data.servers
            .where((r) => _scope(r.profile) == _scope(p))
            .firstOrNull;
        BrokerClient? client;
        try {
          client = await _client(p);
          final inventory = await client
              .getUpdateInventory(refresh: true)
              .timeout(const Duration(seconds: 25));
          final check = await client.checkUpdates().timeout(
            const Duration(seconds: 25),
          );
          BrokerUpdateGrants? grants;
          var history = const <BrokerUpdateHistoryEntry>[];
          try {
            grants = await client.getUpdateGrants().timeout(
              const Duration(seconds: 15),
            );
          } on BrokerException catch (e) {
            if (e.statusCode != 403) rethrow;
          }
          try {
            history = await client.getUpdateHistory().timeout(
              const Duration(seconds: 15),
            );
          } on BrokerException catch (e) {
            if (e.statusCode != 403) rethrow;
          }
          if (!await _admitted(p, client)) continue;
          results[_scope(p)] = UpdateServerRow(
            p,
            inventory: inventory,
            check: check,
            lastSeen: _now(),
            grants: grants,
            history: history,
          );
        } on Object catch (error) {
          if (!await _stillCurrent(p)) continue;
          results[_scope(p)] = UpdateServerRow(
            p,
            inventory: old?.inventory,
            lastSeen: old?.lastSeen,
            error: error is BrokerException
                ? error.statusCode == 404
                      ? 'legacy'
                      : error.statusCode == 403
                      ? 'permission-required'
                      : 'offline'
                : 'offline',
          );
        } finally {
          client?.close();
        }
      }
    }

    final local = () async {
      try {
        final manifest = await ref.read(stableReleaseManifestFetcherProvider)();
        if (_disposed) return;
        _publish(_data.copy(manifest: manifest, checking: true));
        final identity = await ref.read(localDesktopUpdaterProvider).inspect();
        if (_disposed) return;
        _publish(_data.copy(local: identity, checking: true));
      } on Object catch (error) {
        if (_disposed) return;
        _publish(
          _data.copy(
            localError: error is DesktopUpdaterUnavailable
                ? error.detailCode
                : 'check-failed',
            checking: true,
          ),
        );
      }
    }();
    await Future.wait([
      local,
      ...List.generate(min(3, profiles.length), (_) => worker()),
    ]);
    if (_disposed) return;
    _publish(
      _data.copy(
        servers: profiles
            .map((p) => results[_scope(p)])
            .whereType<UpdateServerRow>()
            .toList(),
        checking: false,
        localError: _data.localError,
      ),
    );
    await _save();
  }

  Map<String, dynamic> _contract(ClientContractIdentity c) => {
    'revision': c.revision,
    'minimumPeerRevision': c.minimumBrokerRevision,
    if (c.surfaceHash != null) 'surfaceHash': c.surfaceHash,
  };

  Future<void> review(Set<String> profileIds, {required bool app}) async {
    if (_data.working || _data.unfinished) return;
    _publish(_data.copy(working: true, review: []));
    try {
      final steps = <UpdateReviewStep>[];
      final metadata = _data.manifest?['updater'] as Map?;
      final rawCandidate = metadata?['clientContract'] as Map?;
      final candidate = rawCandidate == null
          ? null
          : ClientContractIdentity.fromJson(
              Map<String, dynamic>.from(rawCandidate),
            );
      var appFirst = false;
      for (final row in _data.servers.where(
        (r) => profileIds.contains(r.profile.id),
      )) {
        if (!row.available) throw StateError('update-check-required');
        final client = await _client(row.profile);
        try {
          var plan = await client.planUpdate(
            releaseId: row.check!.available!.releaseId!,
            expected: row.inventory!.broker.running,
            clientContract: _contract(_currentContract),
          );
          if (plan.blockers.isNotEmpty &&
              app &&
              _data.appAvailable &&
              candidate != null) {
            // A client-first order is allowed only if that client can still use
            // every selected server BEFORE any server has committed.
            final selected = _data.servers.where(
              (r) => profileIds.contains(r.profile.id),
            );
            if (selected.every((r) => _brokerPair(candidate, r.inventory))) {
              plan = await client.planUpdate(
                releaseId: row.check!.available!.releaseId!,
                expected: row.inventory!.broker.running,
                clientContract: _contract(candidate),
              );
              if (plan.blockers.isEmpty) appFirst = true;
            }
          }
          if (!await _admitted(row.profile, client)) {
            throw StateError('update-source-changed');
          }
          if (plan.installationId != row.inventory!.installationId ||
              plan.blockers.isNotEmpty) {
            throw StateError(
              plan.blockers.firstOrNull?.code ?? 'update-source-changed',
            );
          }
          steps.add(
            UpdateReviewStep(
              label: row.profile.displayName,
              profile: row.profile,
              from: row.inventory!.broker.running.version,
              to: row.check!.available!.version!,
              releaseId: plan.releaseId,
              plan: plan,
              acknowledgements: plan.requiredAcknowledgements,
              clientContract: appFirst ? candidate! : _currentContract,
            ),
          );
        } finally {
          client.close();
        }
      }
      if (app) {
        if (!_data.appAvailable) {
          throw StateError('desktop-update-setup-required');
        }
        // Unknown saved servers require an explicit review acknowledgement.
        if (candidate == null) throw StateError('contract-metadata-absent');
        final acknowledgements = <String>['app-will-close'];
        for (final row in _data.servers) {
          final selected = steps
              .where((s) => s.profile?.id == row.profile.id)
              .firstOrNull;
          final raw = row.inventory?.broker;
          final contract =
              row.inventory?.toJson()['components'] as List<dynamic>?;
          final broker =
              contract
                      ?.cast<Map<String, dynamic>>()
                      .where((v) => v['component'] == 'broker')
                      .firstOrNull?['contract']
                  as Map?;
          if (raw == null || broker == null || row.error != null) {
            if (selected != null) {
              throw StateError('contract-metadata-absent');
            }
            acknowledgements.add('compatibility-unconfirmed');
            continue;
          }
          final report = selected?.plan?.toJson()['compatibility'] as Map?;
          final target =
              (report?['final'] as Map?)?['broker'] as Map? ?? broker;
          if (!updatePairIsUsable(
            candidate,
            BrokerContractIdentity(
              revision: target['revision']! as int,
              minimumClientRevision: target['minimumPeerRevision']! as int,
              surfaceHash: target['surfaceHash'] as String? ?? '',
            ),
          )) {
            if (selected != null) throw StateError('no-safe-intermediate');
            acknowledgements.add('unselected-servers-unusable');
          }
        }
        if (appFirst) {
          // Re-plan earlier server rows too: all will run AFTER the app update.
          for (var i = 0; i < steps.length; i++) {
            final step = steps[i];
            final client = await _client(step.profile!);
            try {
              final plan = await client.planUpdate(
                releaseId: step.releaseId,
                expected: step.plan!.components.first.from,
                clientContract: _contract(candidate),
              );
              if (plan.blockers.isNotEmpty) {
                throw StateError('no-safe-intermediate');
              }
              steps[i] = UpdateReviewStep(
                label: step.label,
                from: step.from,
                to: step.to,
                releaseId: step.releaseId,
                profile: step.profile,
                plan: plan,
                acknowledgements: plan.requiredAcknowledgements,
                clientContract: candidate,
              );
            } finally {
              client.close();
            }
          }
        }
        final appStep = UpdateReviewStep(
          label: 'Cosyncing',
          from: _data.local!['version'] as String,
          to: _data.manifest!['version']! as String,
          releaseId: _data.appReleaseId!,
          acknowledgements: acknowledgements.toSet().toList(),
        );
        if (appFirst) {
          steps.insert(0, appStep);
        } else {
          steps.add(appStep);
        }
      }
      if (steps.isEmpty) throw StateError('update-selection-empty');
      if (_disposed) return;
      _publish(_data.copy(review: steps, working: false));
    } on Object catch (error) {
      if (_disposed) return;
      _publish(_data.copy(working: false, error: _errorCode(error)));
    }
  }

  bool _brokerPair(
    ClientContractIdentity client,
    BrokerUpdateInventory? inventory,
  ) {
    final rows = inventory?.toJson()['components'] as List?;
    final contract =
        rows
                ?.cast<Map<String, dynamic>>()
                .where((r) => r['component'] == 'broker')
                .firstOrNull?['contract']
            as Map?;
    return contract != null &&
        updatePairIsUsable(
          client,
          BrokerContractIdentity(
            revision: contract['revision']! as int,
            minimumClientRevision: contract['minimumPeerRevision']! as int,
            surfaceHash: contract['surfaceHash'] as String? ?? '',
          ),
        );
  }

  void discardReview() {
    if (!_data.working) _publish(_data.copy(review: []));
  }

  Future<void> confirm(Set<String> acknowledgements) async {
    if (_data.working || _data.review.isEmpty) return;
    final review = List<UpdateReviewStep>.of(_data.review);
    if (review.any((s) => !acknowledgements.containsAll(s.acknowledgements))) {
      return;
    }
    _publish(_data.copy(working: true));
    try {
      final steps = <Map<String, dynamic>>[];
      for (final step in review) {
        BrokerUpdatePlan? plan;
        if (!step.app) {
          final client = await _client(step.profile!);
          try {
            plan = await client.planUpdate(
              releaseId: step.releaseId,
              expected: step.plan!.components.first.from,
              clientContract: _contract(step.clientContract),
              acknowledgements: acknowledgements.toList(),
            );
            if (plan.blockers.isNotEmpty ||
                plan.outstandingAcknowledgements.isNotEmpty ||
                plan.releaseId != step.releaseId ||
                plan.installationId != step.plan!.installationId ||
                plan.installationGeneration !=
                    step.plan!.installationGeneration ||
                !acknowledgements.containsAll(plan.requiredAcknowledgements)) {
              throw StateError('update-plan-stale');
            }
          } finally {
            client.close();
          }
        }
        steps.add({
          'id': _id(),
          'label': step.label,
          'from': step.from,
          'to': step.to,
          'releaseId': step.releaseId,
          'profileId': step.profile?.id,
          'scope': step.profile == null ? null : _scope(step.profile!),
          'installationId': step.app ? _data.local!['installationId'] : null,
          'plan': plan?.toJson(),
          'phase': 'pending',
        });
      }
      _publish(
        _data.copy(
          operation: {
            'id': _id(),
            'createdAt': _now().toIso8601String(),
            'steps': steps,
            'acknowledgements': acknowledgements.toList(),
            'phase': 'running',
          },
          review: [],
          working: false,
        ),
      );
      await _save();
      await continueOperation();
    } on Object catch (error) {
      if (_disposed) return;
      _publish(_data.copy(working: false, error: _errorCode(error)));
    }
  }

  Future<Map<String, dynamic>> _desktopJob(Map<String, dynamic> step) async {
    final updater = ref.read(localDesktopUpdaterProvider);
    final id = step['id']! as String;
    final release = step['releaseId']! as String;
    Map<String, dynamic> job;
    try {
      // Status owns dead-worker recovery. Preparing an existing job alone
      // cannot reconcile an interrupted exit, replacement or startup.
      job = await updater.status(id);
    } on DesktopUpdaterUnavailable catch (error) {
      if (error.detailCode != 'desktop-update-job-not-found') rethrow;
      return updater.prepare(id, release);
    }
    if (job['releaseId'] != release) {
      throw StateError('update-source-changed');
    }
    // Rebind a recovered ready job to this app process, or reconcile a
    // preparation whose response was lost. Terminal and live workers stay put.
    if (const ['ready', 'preparing'].contains(job['phase'])) {
      return updater.prepare(id, release);
    }
    return job;
  }

  Future<void> continueOperation() async {
    if (_data.working || _data.operation == null) return;
    _publish(_data.copy(working: true));
    final operation = _data.operation!;
    try {
      final resuming =
          operation['phase'] == 'paused' ||
          (operation['steps']! as List).any(
            (step) => (step as Map)['prepareRequested'] == true,
          );
      // Stage every selected component before allowing the first interruption.
      // Durable preparation keys survive a lost response or an app restart.
      for (final step
          in (operation['steps']! as List).cast<Map<String, dynamic>>()) {
        if (_disposed) return;
        if (operation['cancelRequested'] == true) {
          await _cancelPrepared();
          return;
        }
        if (step['phase'] == 'succeeded' || step['phase'] == 'cancelled') {
          continue;
        }
        final profileId = step['profileId'] as String?;
        step['prepareRequested'] = true;
        await _save();
        if (profileId == null) {
          var job = await _desktopJob(step);
          if (resuming &&
              const ['failed', 'rolled_back'].contains(job['phase'])) {
            final local = await ref.read(localDesktopUpdaterProvider).inspect();
            if (local['version'] != step['from'] ||
                local['installationId'] != step['installationId']) {
              throw StateError('update-source-changed');
            }
            // A terminal attempt is immutable. Explicit Continue may retry
            // only this unchanged, unfinished app target under a fresh key.
            ((step['attempts'] ??= <Object?>[]) as List<Object?>).add({
              'id': step['id'],
              'phase': job['phase'],
            });
            step
              ..['id'] = _id()
              ..['phase'] = 'pending';
            await _save();
            job = await ref
                .read(localDesktopUpdaterProvider)
                .prepare(
                  step['id']! as String,
                  step['releaseId']! as String,
                );
          }
          step['phase'] = job['phase'];
          if (_disposed) return;
        } else {
          final profile = await ref
              .read(brokerProfileRepositoryProvider)
              .getById(profileId);
          if (profile == null || _scope(profile) != step['scope']) {
            throw StateError('update-source-changed');
          }
          final client = await _client(profile);
          try {
            final job = step['jobId'] == null
                ? await client.prepareUpdate(
                    planId: (step['plan']! as Map)['planId']! as String,
                    idempotencyKey: step['id']! as String,
                  )
                : await client.getUpdateJob(step['jobId']! as String);
            final plan = BrokerUpdatePlan.fromJson(
              step['plan']! as Map<String, dynamic>,
            );
            if (job.installationId != plan.installationId ||
                job.releaseId != plan.releaseId ||
                job.planId != plan.planId) {
              throw StateError('update-source-changed');
            }
            step['jobId'] = job.jobId;
            step['phase'] = job.phase;
          } finally {
            client.close();
          }
        }
        await _save();
        if (!const [
          'ready',
          'applying',
          'verifying',
          'succeeded',
        ].contains(step['phase'])) {
          throw StateError('update-preparation-incomplete');
        }
      }
      for (final step
          in (operation['steps']! as List).cast<Map<String, dynamic>>()) {
        if (_disposed) return;
        if (operation['cancelRequested'] == true) {
          await _cancelPrepared();
          return;
        }
        if (step['phase'] == 'succeeded') continue;
        if (step['phase'] == 'cancelled') break;
        final profileId = step['profileId'] as String?;
        if (profileId == null) {
          final updater = ref.read(localDesktopUpdaterProvider);
          var job = await _desktopJob(step);
          step['phase'] = job['phase'];
          await _save();
          if (job['phase'] == 'succeeded') continue;
          if (job['phase'] != 'ready') {
            throw StateError(
              job['detailCode'] as String? ?? 'update-status-unknown',
            );
          }
          final inputBarrier = WebHandoffParticipants.instance;
          var exiting = false;
          try {
            // The shared barrier freezes input synchronously before flushing
            // every mounted editor, including dialogs outside Sessions.
            if (!await inputBarrier.commit()) {
              throw StateError('update-draft-not-saved');
            }
            _inputFrozen = true;
            await ref.read(openSessionsControllerProvider.future);
            await ref
                .read(openSessionsControllerProvider.notifier)
                .flushDraftsForUpdate();
            if (_disposed) return;
            if (operation['cancelRequested'] == true) {
              throw StateError('update-cancel-requested');
            }
            job = await updater.arm(step['id']! as String);
            step['phase'] = job['phase'];
            if (job['phase'] != 'waiting-for-exit') {
              throw StateError(job['detailCode']! as String);
            }
            step['phase'] = 'waiting-for-exit';
            await _save();
            await ref.read(desktopWindowChannelProvider).quitForUpdate();
            exiting = true;
            _exitWatchdog?.cancel();
            // The helper refuses after its bounded exit wait. If the native
            // host failed to quit, restore interaction instead of wedging UI.
            _exitWatchdog = Timer(const Duration(seconds: 45), () {
              inputBarrier.releaseAll();
              _inputFrozen = false;
              if (_disposed) return;
              operation['phase'] = 'paused';
              operation['detailCode'] = 'desktop-update-exit-unconfirmed';
              _publish(
                _data.copy(
                  working: false,
                  error: 'desktop-update-exit-unconfirmed',
                ),
              );
              unawaited(_save().catchError((Object _) {}));
            });
          } finally {
            if (!exiting) {
              inputBarrier.releaseAll();
              _inputFrozen = false;
            }
          }
          return;
        }
        final profile = await ref
            .read(brokerProfileRepositoryProvider)
            .getById(profileId);
        if (profile == null || _scope(profile) != step['scope']) {
          throw StateError('update-source-changed');
        }
        final client = await _client(profile);
        try {
          BrokerUpdateJob job;
          if (step['jobId'] != null) {
            job = await client.getUpdateJob(step['jobId']! as String);
          } else {
            // A lost response retrieves the same job with its durable key.
            job = await client.prepareUpdate(
              planId: (step['plan']! as Map)['planId']! as String,
              idempotencyKey: step['id']! as String,
            );
            step['jobId'] = job.jobId;
          }
          final plan = BrokerUpdatePlan.fromJson(
            step['plan']! as Map<String, dynamic>,
          );
          void validate(BrokerUpdateJob value) {
            if (value.installationId != plan.installationId ||
                value.releaseId != plan.releaseId ||
                value.planId != plan.planId ||
                value.installationGeneration != plan.installationGeneration) {
              throw StateError('update-source-changed');
            }
          }

          validate(job);
          step['phase'] = job.phase;
          await _save();
          if (job.phase == 'ready') {
            if (!await _admitted(profile, client)) {
              throw StateError('update-source-changed');
            }
            if (operation['cancelRequested'] == true) {
              await _cancelPrepared();
              return;
            }
            // Persist intent before sending apply; resume uses the same key.
            step['applyRequested'] = true;
            await _save();
            if (!await _admitted(profile, client)) {
              throw StateError('update-source-changed');
            }
            if (operation['cancelRequested'] == true) {
              await _cancelPrepared();
              return;
            }
            job = await client.applyUpdate(
              jobId: job.jobId,
              idempotencyKey: '${step['id']}-apply',
            );
          }
          final deadline = _now().add(const Duration(minutes: 2));
          var backoff = 1;
          while (!job.terminal && !_disposed && _now().isBefore(deadline)) {
            // Reconnect observes progress without another install request.
            await Future<void>.delayed(Duration(seconds: backoff));
            backoff = min(backoff * 2, 10);
            try {
              job = await client
                  .getUpdateJob(job.jobId)
                  .timeout(const Duration(seconds: 15));
            } on Object {
              continue;
            }
            validate(job);
            step['phase'] = job.phase;
            _publish(_data.copy());
            await _save();
          }
          validate(job);
          step['phase'] = job.phase;
          await _save();
          if (job.phase != 'succeeded') {
            throw StateError(
              job.terminal
                  ? job.detailCode ?? 'update-failed'
                  : 'update-status-unknown',
            );
          }
        } finally {
          client.close();
        }
      }
      operation['phase'] = 'complete';
      _publish(_data.copy(working: false));
      await _save();
    } on Object catch (error) {
      if (_disposed) return;
      operation['phase'] = 'paused';
      operation['detailCode'] = _errorCode(error);
      _publish(_data.copy(working: false, error: _errorCode(error)));
      await _save();
    }
  }

  Future<void> permission(
    BrokerProfile profile, {
    String? peerId,
    bool revoke = false,
  }) async {
    final client = await _client(profile);
    try {
      if (peerId == null) {
        await client.requestUpdatePermission();
      } else if (revoke) {
        await client.revokeUpdatePermission(peerId);
      } else {
        await client.grantUpdatePermission(peerId);
      }
    } finally {
      client.close();
    }
    await refresh();
  }

  Future<void> cancel() async {
    if (_data.operation == null) return;
    _data.operation!['cancelRequested'] = true;
    _publish(_data.copy());
    await _save();
    if (!_data.working) await _cancelPrepared();
  }

  Future<void> _cancelPrepared() async {
    for (final step
        in (_data.operation!['steps']! as List).cast<Map<String, dynamic>>()) {
      if (step['phase'] == 'succeeded') continue;
      try {
        final profileId = step['profileId'] as String?;
        if (profileId == null && step['prepareRequested'] == true) {
          final updater = ref.read(localDesktopUpdaterProvider);
          var job = await updater.status(step['id']! as String);
          if (const ['preparing', 'ready'].contains(job['phase'])) {
            await updater.cancel(step['id']! as String);
            job = await updater.status(step['id']! as String);
          }
          step['phase'] = job['phase'];
          if (step['phase'] == 'succeeded') continue;
          if (!const [
            'failed',
            'cancelled',
            'rolled_back',
            'needs_attention',
          ].contains(step['phase'])) {
            throw StateError('update-cannot-cancel');
          }
        } else if (profileId != null &&
            (step['jobId'] != null || step['prepareRequested'] == true)) {
          final profile = await ref
              .read(brokerProfileRepositoryProvider)
              .getById(profileId);
          if (profile == null || _scope(profile) != step['scope']) {
            throw StateError('update-source-changed');
          }
          final client = await _client(profile);
          try {
            var job = step['jobId'] != null
                ? await client.getUpdateJob(step['jobId']! as String)
                : await client.prepareUpdate(
                    planId: (step['plan']! as Map)['planId']! as String,
                    idempotencyKey: step['id']! as String,
                  );
            step['jobId'] = job.jobId;
            if (!job.terminal) job = await client.cancelUpdateJob(job.jobId);
            step['phase'] = job.phase;
            if (job.phase == 'succeeded') continue;
            if (!job.terminal) {
              throw StateError('update-cannot-cancel');
            }
          } finally {
            client.close();
          }
        }
      } on Object catch (error) {
        // Cancel means no more components will be launched. An inaccessible
        // or already accepted host operation remains explicitly unconfirmed.
        step
          ..['phase'] = 'needs_attention'
          ..['detailCode'] = _errorCode(error);
      }
      if (!const [
        'failed',
        'rolled_back',
        'needs_attention',
      ].contains(step['phase'])) {
        step['phase'] = 'cancelled';
      }
    }
    _data.operation!['phase'] = 'cancelled';
    _publish(_data.copy(working: false));
    await _save();
  }

  String _errorCode(Object error) => error is BrokerException
      ? error.error?.code ?? 'update-request-failed'
      : error is DesktopUpdaterUnavailable
      ? error.detailCode
      : error is StateError
      ? error.message
      : 'update-request-failed';
}
