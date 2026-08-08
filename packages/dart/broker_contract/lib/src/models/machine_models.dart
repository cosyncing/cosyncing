import 'package:broker_contract/src/models/session_info.dart';

/// A machine's relation to the broker serving `/api/machines`.
enum MachineRosterRole {
  local('local'),
  peer('peer'),
  unknown('unknown');

  const MachineRosterRole(this.wireValue);
  final String wireValue;

  static MachineRosterRole fromWire(Object? value) => switch (value) {
    'local' => MachineRosterRole.local,
    'peer' => MachineRosterRole.peer,
    _ => MachineRosterRole.unknown,
  };
}

/// Health of one machine roster fetch.
enum MachineRosterStatus {
  ok('ok'),
  degraded('degraded'),
  unknown('unknown');

  const MachineRosterStatus(this.wireValue);
  final String wireValue;

  static MachineRosterStatus fromWire(Object? value) => switch (value) {
    'ok' => MachineRosterStatus.ok,
    'degraded' => MachineRosterStatus.degraded,
    _ => MachineRosterStatus.unknown,
  };
}

/// Freshness of one configured machine roster.
enum MachineRosterFreshness {
  fresh('fresh'),
  stale('stale'),
  unknown('unknown');

  const MachineRosterFreshness(this.wireValue);
  final String wireValue;

  static MachineRosterFreshness fromWire(Object? value) => switch (value) {
    'fresh' => MachineRosterFreshness.fresh,
    'stale' => MachineRosterFreshness.stale,
    _ => MachineRosterFreshness.unknown,
  };
}

/// Direct-owner route state for a machine session.
enum MachineSessionRouteState {
  local('local'),
  direct('direct'),
  stale('stale'),
  ambiguous('ambiguous'),
  unknown('unknown');

  const MachineSessionRouteState(this.wireValue);
  final String wireValue;

  static MachineSessionRouteState fromWire(Object? value) => switch (value) {
    'local' => MachineSessionRouteState.local,
    'direct' => MachineSessionRouteState.direct,
    'stale' => MachineSessionRouteState.stale,
    'ambiguous' => MachineSessionRouteState.ambiguous,
    _ => MachineSessionRouteState.unknown,
  };
}

/// Stable composite session identity supplied by the aggregator.
final class MachineSessionIdentity {
  const MachineSessionIdentity({
    required this.machineId,
    required this.tool,
    required this.sessionId,
    required this.key,
  });

  factory MachineSessionIdentity.fromJson(Map<String, dynamic> json) =>
      MachineSessionIdentity(
        machineId: _requiredString(json, 'machineId'),
        tool: _requiredString(json, 'tool'),
        sessionId: _requiredString(json, 'sessionId'),
        key: _requiredString(json, 'key'),
      );

  final String machineId;
  final String tool;
  final String sessionId;

  /// Opaque stable key. Clients must not reconstruct its formatting.
  final String key;

  Map<String, dynamic> toJson() => {
    'machineId': machineId,
    'tool': tool,
    'sessionId': sessionId,
    'key': key,
  };
}

/// Owning-broker connection metadata for one machine session.
final class MachineSessionOwner {
  const MachineSessionOwner({
    required this.machineId,
    required this.machine,
    required this.role,
    required this.route,
    required this.authoritative,
    required this.requiresIndependentAuthentication,
    this.baseUrl,
    this.streamUrl,
  });

  factory MachineSessionOwner.fromJson(Map<String, dynamic> json) =>
      MachineSessionOwner(
        machineId: _requiredString(json, 'machineId'),
        machine: _requiredString(json, 'machine'),
        role: MachineRosterRole.fromWire(json['role']),
        route: MachineSessionRouteState.fromWire(json['route']),
        authoritative: json['authoritative'] == true,
        baseUrl: _optionalString(json['baseUrl']),
        streamUrl: _optionalString(json['streamUrl']),
        requiresIndependentAuthentication:
            json['requiresIndependentAuthentication'] == true,
      );

  final String machineId;
  final String machine;
  final MachineRosterRole role;
  final MachineSessionRouteState route;
  final bool authoritative;
  final String? baseUrl;
  final String? streamUrl;
  final bool requiresIndependentAuthentication;

  /// Whether this route can be used for direct mutation after authentication.
  bool get isDirectlyRoutable =>
      authoritative &&
      ((role == MachineRosterRole.local &&
              route == MachineSessionRouteState.local) ||
          (role == MachineRosterRole.peer &&
              route == MachineSessionRouteState.direct)) &&
      baseUrl != null;

  Map<String, dynamic> toJson() => {
    'machineId': machineId,
    'machine': machine,
    'role': role.wireValue,
    'route': route.wireValue,
    'authoritative': authoritative,
    if (baseUrl != null) 'baseUrl': baseUrl,
    if (streamUrl != null) 'streamUrl': streamUrl,
    'requiresIndependentAuthentication': requiresIndependentAuthentication,
  };
}

/// One session plus its composite identity and owning-broker route.
final class MachineSessionInfo {
  const MachineSessionInfo({
    required this.session,
    required this.identity,
    required this.owner,
  });

  factory MachineSessionInfo.fromJson(
    Map<String, dynamic> json, {
    required String fallbackMachineId,
    required String fallbackMachine,
    required MachineRosterRole fallbackRole,
    String? fallbackBaseUrl,
  }) {
    final session = SessionInfo.fromJson(json);
    final identity = switch (json['identity']) {
      final Map<Object?, Object?> value => MachineSessionIdentity.fromJson(
        Map<String, dynamic>.from(value),
      ),
      _ => MachineSessionIdentity(
        machineId: fallbackMachineId,
        tool: session.tool,
        sessionId: session.id,
        key: '$fallbackMachineId:${session.tool}:${session.id}',
      ),
    };
    final owner = switch (json['owner']) {
      final Map<Object?, Object?> value => MachineSessionOwner.fromJson(
        Map<String, dynamic>.from(value),
      ),
      _ => MachineSessionOwner(
        machineId: fallbackMachineId,
        machine: fallbackMachine,
        role: fallbackRole,
        route: fallbackRole == MachineRosterRole.local
            ? MachineSessionRouteState.local
            : MachineSessionRouteState.unknown,
        authoritative: fallbackRole == MachineRosterRole.local,
        baseUrl: fallbackBaseUrl,
        requiresIndependentAuthentication:
            fallbackRole == MachineRosterRole.peer,
      ),
    };
    return MachineSessionInfo(
      session: session,
      identity: identity,
      owner: owner,
    );
  }

  final SessionInfo session;
  final MachineSessionIdentity identity;
  final MachineSessionOwner owner;

  String get id => session.id;
  String get tool => session.tool;
  String get title => session.title;
  String? get machine => session.machine ?? owner.machine;

  Map<String, dynamic> toJson() => {
    ...session.toJson(),
    'machine': machine,
    'identity': identity.toJson(),
    'owner': owner.toJson(),
  };
}

/// One local or peer machine roster from `/api/machines`.
final class MachineRoster {
  const MachineRoster({
    required this.machineId,
    required this.machine,
    required this.role,
    required this.status,
    required this.sessions,
    required this.sessionCount,
    required this.checkedAt,
    required this.freshness,
    this.baseUrl,
    this.generatedAt,
    this.invalidSessionCount,
    this.code,
    this.error,
  });

  factory MachineRoster.fromJson(Map<String, dynamic> json) {
    final machine = _requiredString(json, 'machine');
    final machineId = _optionalString(json['machineId']) ?? machine;
    final role = MachineRosterRole.fromWire(json['role']);
    final baseUrl = _optionalString(json['baseUrl']);
    final rawSessions = json['sessions'];
    if (rawSessions is! List) {
      throw const FormatException('Malformed machine roster sessions.');
    }
    final sessions = <MachineSessionInfo>[];
    for (final value in rawSessions) {
      if (value is! Map) continue;
      try {
        sessions.add(
          MachineSessionInfo.fromJson(
            Map<String, dynamic>.from(value),
            fallbackMachineId: machineId,
            fallbackMachine: machine,
            fallbackRole: role,
            fallbackBaseUrl: baseUrl,
          ),
        );
      } on Object {
        // A malformed peer row is counted by the broker and must not make the
        // remaining valid sessions unusable.
      }
    }
    return MachineRoster(
      machineId: machineId,
      machine: machine,
      role: role,
      status: MachineRosterStatus.fromWire(json['status']),
      sessions: List.unmodifiable(sessions),
      sessionCount: _optionalInt(json['sessionCount']) ?? sessions.length,
      baseUrl: baseUrl,
      checkedAt: _optionalInt(json['checkedAt']) ?? 0,
      generatedAt: _optionalInt(json['generatedAt']),
      freshness: MachineRosterFreshness.fromWire(json['freshness']),
      invalidSessionCount: _optionalInt(json['invalidSessionCount']),
      code: _optionalString(json['code']),
      error: _optionalString(json['error']),
    );
  }

  final String machineId;
  final String machine;
  final MachineRosterRole role;
  final MachineRosterStatus status;
  final List<MachineSessionInfo> sessions;
  final int sessionCount;
  final String? baseUrl;
  final int checkedAt;
  final int? generatedAt;
  final MachineRosterFreshness freshness;
  final int? invalidSessionCount;
  final String? code;
  final String? error;

  /// Stale/degraded/ambiguous rows remain displayable but read-only.
  bool get isAuthoritative =>
      status == MachineRosterStatus.ok &&
      freshness != MachineRosterFreshness.stale;

  /// Whether one individually valid session can be resolved directly.
  ///
  /// A degraded roster may still contain valid routed sessions; only stale
  /// freshness or the session's own non-authoritative owner blocks routing.
  bool canRoute(MachineSessionInfo session) =>
      freshness != MachineRosterFreshness.stale &&
      session.owner.isDirectlyRoutable;

  Map<String, dynamic> toJson() => {
    'machineId': machineId,
    'machine': machine,
    'role': role.wireValue,
    'status': status.wireValue,
    'sessions': sessions.map((session) => session.toJson()).toList(),
    'sessionCount': sessionCount,
    if (baseUrl != null) 'baseUrl': baseUrl,
    'checkedAt': checkedAt,
    if (generatedAt != null) 'generatedAt': generatedAt,
    'freshness': freshness.wireValue,
    if (invalidSessionCount != null) 'invalidSessionCount': invalidSessionCount,
    if (code != null) 'code': code,
    if (error != null) 'error': error,
  };
}

/// Authenticated response from `GET /api/machines`.
final class AggregatedMachinesResponse {
  const AggregatedMachinesResponse({
    required this.ok,
    required this.version,
    required this.machine,
    required this.machineId,
    required this.generatedAt,
    required this.machines,
  });

  factory AggregatedMachinesResponse.fromJson(Map<String, dynamic> json) {
    final machine = _requiredString(json, 'machine');
    final rawMachines = json['machines'];
    if (rawMachines is! List) {
      throw const FormatException('Malformed aggregated machine response.');
    }
    return AggregatedMachinesResponse(
      ok: json['ok'] == true,
      version: _optionalInt(json['version']) ?? 1,
      machine: machine,
      machineId: _optionalString(json['machineId']) ?? machine,
      generatedAt: _optionalInt(json['generatedAt']) ?? 0,
      machines: rawMachines
          .whereType<Map<Object?, Object?>>()
          .map(
            (value) => MachineRoster.fromJson(
              Map<String, dynamic>.from(value),
            ),
          )
          .toList(growable: false),
    );
  }

  final bool ok;
  final int version;
  final String machine;
  final String machineId;
  final int generatedAt;
  final List<MachineRoster> machines;

  Map<String, dynamic> toJson() => {
    'ok': ok,
    'version': version,
    'machine': machine,
    'machineId': machineId,
    'generatedAt': generatedAt,
    'machines': machines.map((roster) => roster.toJson()).toList(),
  };
}

/// Resolution status for a direct owner lookup.
enum MachineSessionResolutionStatus {
  resolved('resolved'),
  ownerUnreachable('owner-unreachable'),
  ambiguous('ambiguous'),
  notFound('not-found'),
  stale('stale'),
  unknown('unknown');

  const MachineSessionResolutionStatus(this.wireValue);
  final String wireValue;

  static MachineSessionResolutionStatus fromWire(Object? value) =>
      switch (value) {
        'resolved' => MachineSessionResolutionStatus.resolved,
        'owner-unreachable' => MachineSessionResolutionStatus.ownerUnreachable,
        'ambiguous' => MachineSessionResolutionStatus.ambiguous,
        'not-found' => MachineSessionResolutionStatus.notFound,
        'stale' => MachineSessionResolutionStatus.stale,
        _ => MachineSessionResolutionStatus.unknown,
      };
}

/// Typed response from `/api/machines/resolve`.
final class MachineSessionResolution {
  const MachineSessionResolution({
    required this.ok,
    required this.identity,
    required this.status,
    this.session,
    this.owner,
    this.code,
    this.message,
  });

  factory MachineSessionResolution.fromJson(Map<String, dynamic> json) {
    final identity = MachineSessionIdentity.fromJson(
      _requiredMap(json['identity'], 'identity'),
    );
    final owner = switch (json['owner']) {
      final Map<Object?, Object?> value => MachineSessionOwner.fromJson(
        Map<String, dynamic>.from(value),
      ),
      _ => null,
    };
    final session = switch (json['session']) {
      final Map<Object?, Object?> value => MachineSessionInfo.fromJson(
        Map<String, dynamic>.from(value),
        fallbackMachineId: owner?.machineId ?? identity.machineId,
        fallbackMachine: owner?.machine ?? identity.machineId,
        fallbackRole: owner?.role ?? MachineRosterRole.unknown,
        fallbackBaseUrl: owner?.baseUrl,
      ),
      _ => null,
    };
    return MachineSessionResolution(
      ok: json['ok'] == true,
      identity: identity,
      status: MachineSessionResolutionStatus.fromWire(json['status']),
      session: session,
      owner: owner,
      code: _optionalString(json['code']),
      message: _optionalString(json['message']),
    );
  }

  final bool ok;
  final MachineSessionIdentity identity;
  final MachineSessionResolutionStatus status;
  final MachineSessionInfo? session;
  final MachineSessionOwner? owner;
  final String? code;
  final String? message;

  /// Only an authoritative resolved owner may be connected.
  bool get canConnect {
    final resolvedOwner = owner;
    final resolvedSession = session;
    if (!ok ||
        status != MachineSessionResolutionStatus.resolved ||
        resolvedOwner == null ||
        resolvedSession == null ||
        !resolvedOwner.isDirectlyRoutable ||
        resolvedOwner.machineId != identity.machineId) {
      return false;
    }
    final sessionIdentity = resolvedSession.identity;
    final sessionOwner = resolvedSession.owner;
    return sessionIdentity.machineId == identity.machineId &&
        sessionIdentity.tool == identity.tool &&
        sessionIdentity.sessionId == identity.sessionId &&
        sessionIdentity.key == identity.key &&
        sessionOwner.machineId == resolvedOwner.machineId &&
        sessionOwner.role == resolvedOwner.role &&
        sessionOwner.route == resolvedOwner.route &&
        sessionOwner.authoritative == resolvedOwner.authoritative &&
        sessionOwner.baseUrl == resolvedOwner.baseUrl;
  }

  Map<String, dynamic> toJson() => {
    'ok': ok,
    'identity': identity.toJson(),
    'status': status.wireValue,
    if (session != null) 'session': session!.toJson(),
    if (owner != null) 'owner': owner!.toJson(),
    if (code != null) 'code': code,
    if (message != null) 'message': message,
  };
}

String _requiredString(Map<String, dynamic> json, String field) {
  final value = json[field];
  if (value is String && value.trim().isNotEmpty) return value.trim();
  throw FormatException('$field must be a non-empty string');
}

Map<String, dynamic> _requiredMap(Object? value, String field) {
  if (value is Map) return Map<String, dynamic>.from(value);
  throw FormatException('$field must be an object');
}

String? _optionalString(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

int? _optionalInt(Object? value) =>
    value is num && value.isFinite ? value.toInt() : null;
