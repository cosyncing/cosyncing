// The broker's runtime-administration surface for feature tests (F09): the
// managed agent runtimes, their update policy, broker health, the
// workspace-browsing gate, the quota proxy and its warning preference, the
// broker release channel and the restart actions.
//
// One stateful fake in place of the two private `_FakeManagedRuntimeApi`
// copies the legacy settings tests carried. It plugs into a `FakeBroker`
// through `routes`, so the app's real `BrokerClient`, identity-bound API
// context and `ManagedRuntimeController` run against it, and it keeps ledgers
// of what the app asked (policy writes, restarts, quota reads), so a scenario
// asserts what reached the broker and what the user then sees.
import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/settings/data/conversation_display_store.dart';
import 'package:cosyncing_client/src/features/settings/model/conversation_display_preferences.dart';

import 'fake_broker.dart';

/// A managed runtime row as the broker reports it.
AgentRuntimeUpdateStatus runtimeStatus({
  String agent = 'codex',
  String displayName = 'Codex',
  bool managed = true,
  String state = 'pending',
  bool updateAvailable = true,
  bool autoRestartReady = false,
  List<String> pendingChanges = const ['configuration'],
  String? runningVersion = '0.144.1',
  String? installedVersion = '0.144.1',
  int? blockers = 1,
  AgentRuntimeBlockerComposition? composition =
      const AgentRuntimeBlockerComposition(
        idle: 1,
        working: 0,
        needsInput: 0,
        unknown: 0,
      ),
}) => AgentRuntimeUpdateStatus(
  agent: agent,
  displayName: displayName,
  managed: managed,
  state: state,
  updateAvailable: updateAvailable,
  autoRestartReady: autoRestartReady,
  pendingChanges: pendingChanges,
  checkedAt: 1,
  runningVersion: runningVersion,
  installedVersion: installedVersion,
  blockers: blockers,
  blockerComposition: composition,
);

/// A runtime the broker reports as current: nothing pending, no blocker count.
AgentRuntimeUpdateStatus currentRuntime({
  String agent = 'codex',
  String displayName = 'Codex',
}) => runtimeStatus(
  agent: agent,
  displayName: displayName,
  state: 'current',
  updateAvailable: false,
  pendingChanges: const [],
  runningVersion: '0.155.1',
  installedVersion: '0.155.1',
  blockers: null,
  composition: null,
);

/// Runtime administration of one broker.
class RuntimeDesk {
  /// Serves the runtime-administration routes of [broker].
  RuntimeDesk(this.broker, {String? version = '0.7.0'}) {
    broker.routes.add(_route);
    this.version = version;
  }

  /// The broker.
  final FakeBroker broker;

  /// Managed runtimes the broker lists.
  List<AgentRuntimeUpdateStatus> updates = [runtimeStatus()];

  /// The Codex automatic-update policy.
  String policy = 'when-detached';

  /// Principal kind health reports: `owner` or `peer`.
  String principal = 'owner';

  /// The overall status broker health reports.
  String healthStatus = 'healthy';

  /// Workspace-browsing gate health reports, or null when not advertised.
  bool? workspaceBrowsing;

  /// Whether the quota-warning preference is on.
  bool quotaWarnings = false;

  /// What `GET /api/tokdash/quota` answers (the broker's proxy body).
  Map<String, Object?> quotaBody = {'ok': true};

  /// Answer quota reads with a broker failure (Tokdash down).
  bool quotaFails = false;

  /// Answer runtime-status reads with a broker failure.
  bool runtimeUpdatesFail = false;

  /// The release-channel snapshot `GET /api/broker/update` serves.
  Map<String, Object?> brokerUpdate = {
    'status': 'current',
    'currentVersion': '0.7.0',
    'checkedAt': '2026-07-18T00:00:00Z',
    'detailCode': 'current',
  };

  /// The broker version `/api/health` reports (null: none reported).
  String? get version => _version;
  set version(String? value) {
    _version = value;
    broker.files['/api/health'] = FakeBrokerResponse(200, {
      'ok': true,
      'product': 'cosyncing',
      'version': ?value,
      'machine': broker.machine,
      'contract': broker.helloFrame()['broker'],
    });
  }

  String? _version;

  /// Called after a runtime restart is accepted: the place for the broker to
  /// report the runtime in its new state.
  void Function(String agent)? onRestart;

  /// Answer the next runtime restart with a broker failure.
  bool restartFails = false;

  /// Policy values written, oldest first.
  final List<String> policyWrites = [];

  /// Agents whose runtime was restarted, oldest first.
  final List<String> restarts = [];

  /// `POST /api/broker/restart-all` calls.
  int restartAllCalls = 0;

  /// Workspace-browsing writes (`enabled`), oldest first.
  final List<bool> workspaceWrites = [];

  /// Quota-warning preference writes, oldest first.
  final List<bool> quotaPreferenceWrites = [];

  /// `GET /api/tokdash/quota` reads, answered or held.
  int quotaReads = 0;

  /// `POST /api/broker/update` calls.
  int updateTriggers = 0;

  FakeBrokerResponse _ok(Map<String, Object?> body) =>
      FakeBrokerResponse(200, {'ok': true, ...body});

  Future<FakeBrokerResponse?> _route(FakeBrokerRequest request) async {
    final path = request.path;
    final method = request.method;
    switch ((method, path)) {
      case ('GET', '/api/broker/health'):
        return FakeBrokerResponse(
          200,
          BrokerHealthResponse(
            status: healthStatus,
            checkedAt: 1,
            principalKind: principal,
            principalRoles: principal == 'peer' ? const ['peer'] : const [],
            raw: {
              'machine': broker.machine,
              if (workspaceBrowsing != null)
                'features': {'httpWorkspaceBrowsing': workspaceBrowsing},
            },
          ).toJson(),
        );
      case ('GET', '/api/agent-runtime-updates'):
        if (runtimeUpdatesFail) {
          return FakeBrokerResponse.error(
            502,
            'RUNTIME_UNAVAILABLE',
            'runtime endpoint unavailable',
          );
        }
        return FakeBrokerResponse(
          200,
          RuntimeUpdatesResponse(ok: true, updates: updates).toJson(),
        );
      case ('GET', '/api/agent-runtime-update-policy'):
        return _ok({'codexUpdatePolicy': policy});
      case ('POST', '/api/agent-runtime-update-policy'):
        final value = (request.body! as Map)['codexUpdatePolicy']! as String;
        policyWrites.add(value);
        policy = value;
        return _ok({'codexUpdatePolicy': value});
      case ('POST', '/api/broker/features/workspace-browsing'):
        final enabled = (request.body! as Map)['enabled']! as bool;
        workspaceWrites.add(enabled);
        workspaceBrowsing = enabled;
        return _ok({
          'enabled': enabled,
          'restartRequired': true,
          'message': 'restart scheduled',
        });
      case ('GET', '/api/broker/update'):
        return _ok({'update': brokerUpdate});
      case ('POST', '/api/broker/update'):
        updateTriggers += 1;
        return _ok({
          'accepted': false,
          'message': 'Already current',
          'update': brokerUpdate,
        });
      case ('POST', '/api/broker/restart-all'):
        restartAllCalls += 1;
        return _ok({'message': 'scheduled'});
      case ('GET', '/api/tokdash/quota'):
        quotaReads += 1;
        if (quotaFails) {
          return FakeBrokerResponse.error(
            502,
            'TOKDASH_UNAVAILABLE',
            'tokdash is not reachable',
          );
        }
        return FakeBrokerResponse(200, quotaBody);
      case ('GET', '/api/tokdash/quota-preference'):
        return _ok({'enabled': quotaWarnings});
      case ('POST', '/api/tokdash/quota-preference'):
        final enabled = (request.body! as Map)['enabled']! as bool;
        quotaPreferenceWrites.add(enabled);
        quotaWarnings = enabled;
        return _ok({'enabled': enabled});
    }
    final restart = RegExp(
      r'^/api/agent-runtime-updates/([^/]+)/restart$',
    ).firstMatch(path);
    if (method == 'POST' && restart != null) {
      if (restartFails) {
        restartFails = false;
        return FakeBrokerResponse.error(
          500,
          'RESTART_FAILED',
          'restart did not complete',
        );
      }
      final agent = Uri.decodeComponent(restart.group(1)!);
      restarts.add(agent);
      onRestart?.call(agent);
      return _ok({});
    }
    return null;
  }
}

// --- quota snapshots, in the shape Tokdash's read-only proxy emits ----------

int _epochSeconds(DateTime value) => value.millisecondsSinceEpoch ~/ 1000;

/// One quota window of a provider.
Map<String, Object?> quotaBucket({
  String id = '5h',
  String label = '5-hour window',
  double? remaining = 42,
  DateTime? resetsAt,
  String status = 'ok',
}) => {
  'account': 'default',
  'bucket': id,
  'bucket_label': label,
  'used_percent': remaining == null ? null : 100 - remaining,
  'remaining_percent': remaining,
  'resets_at': resetsAt == null ? null : _epochSeconds(resetsAt),
  'captured_at': 0,
  'source': 'test',
  'status': status,
};

/// One provider of a quota snapshot.
Map<String, Object?> quotaProvider(
  String id, {
  List<Map<String, Object?>> buckets = const [],
  bool networkEnabled = true,
  bool estimated = false,
  String status = 'ok',
  String? statusDetail,
  Map<String, Object?>? resetCredits,
}) => {
  'provider': id,
  'network_enabled': networkEnabled,
  'buckets': buckets,
  'status': status,
  'status_detail': statusDetail,
  'status_at': null,
  'updated_at': null,
  'sources': const ['test'],
  'estimated': estimated,
  'reset_credits': ?resetCredits,
};

/// A provider shell exactly as Tokdash ships an unconfigured one.
Map<String, Object?> quotaEmptyShell(String id) =>
    quotaProvider(id, networkEnabled: false, status: 'unavailable');

/// A provider's reset-credit block: [count] spendable, expiring at [expiries]
/// (ISO 8601 strings, as Codex reports them).
Map<String, Object?> quotaResetCredits(
  int count,
  List<DateTime> expiries,
) => {
  'available_count': count,
  'credits': [
    for (final (index, expiry) in expiries.indexed)
      {
        'id': 'rc-$index',
        'title': 'Full reset',
        'expires_at': expiry.toUtc().toIso8601String(),
      },
  ],
};

/// A whole quota proxy answer.
Map<String, Object?> quotaSnapshot(
  Map<String, Map<String, Object?>> providers, {
  bool enabled = true,
}) => {
  'ok': true,
  'data': {
    'enabled': enabled,
    'timestamp': _epochSeconds(DateTime.now()),
    'providers': providers,
  },
};

/// The conversation-display store with its first read held until the test
/// lets it through: a store that has not loaded when the user acts.
class GatedConversationDisplayStore implements ConversationDisplayStore {
  /// Wraps [inner].
  GatedConversationDisplayStore(this.inner);

  /// The real store reads and writes go to.
  final ConversationDisplayStore inner;

  /// While set, reads wait on it.
  Completer<void>? gate;

  @override
  Future<ConversationDisplayPreferences> read() async {
    await gate?.future;
    return inner.read();
  }

  @override
  Future<void> write(ConversationDisplayPreferences preferences) =>
      inner.write(preferences);
}
