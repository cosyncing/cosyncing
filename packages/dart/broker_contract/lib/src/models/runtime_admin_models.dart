/// Runtime administration, recovery, and quota models for recovery UI.
///
/// These models preserve unknown strings and future fields. A newer broker can
/// therefore add states or components without breaking older clients.
library;

/// Known runtime update states from `AgentRuntimeUpdateStatus`.
const Set<String> knownRuntimeUpdateStates = <String>{
  'current',
  'pending',
  'unavailable',
  'error',
};

/// Known blocker states for runtime update blockers.
const Set<String> knownRuntimeUpdateBlockerStatuses = <String>{
  'idle',
  'working',
  'needs-input',
  'unknown',
};

/// Known managed-runtime freshness causes.
const Set<String> knownRuntimePendingChanges = <String>{
  'binary-version',
  'configuration',
};

/// Known broker-health statuses.
const Set<String> knownBrokerHealthStatuses = <String>{
  'healthy',
  'degraded',
  'critical',
};

/// Known broker restart policies for Codex runtime updates.
const Set<String> knownCodexUpdatePolicies = <String>{
  'when-detached',
  'when-idle',
};

/// One agent runtime update row from `/api/agent-runtime-updates`.
class AgentRuntimeUpdateStatus {
  /// Creates an [AgentRuntimeUpdateStatus].
  const AgentRuntimeUpdateStatus({
    required this.agent,
    required this.displayName,
    required this.managed,
    required this.state,
    required this.updateAvailable,
    required this.autoRestartReady,
    required this.checkedAt,
    this.runtimeKind,
    this.pendingChanges = const <String>[],
    this.installedVersion,
    this.runningVersion,
    this.blockers,
    this.blockerComposition,
    this.blockerDetails = const <AgentRuntimeUpdateBlockerDetail>[],
    this.detail,
    this.raw = const <String, dynamic>{},
  });

  /// Creates an [AgentRuntimeUpdateStatus] from JSON.
  ///
  /// Unknown states and fields are preserved in [raw].
  factory AgentRuntimeUpdateStatus.fromJson(Map<String, dynamic> json) {
    final blockerDetailsJson = json['blockerDetails'];
    final details = blockerDetailsJson is List
        ? blockerDetailsJson
              .whereType<Map<String, dynamic>>()
              .map(AgentRuntimeUpdateBlockerDetail.fromJson)
              .toList()
        : const <AgentRuntimeUpdateBlockerDetail>[];

    return AgentRuntimeUpdateStatus(
      agent: json['agent'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      runtimeKind: json['runtimeKind'] as String?,
      managed: json['managed'] as bool? ?? false,
      state: json['state'] as String? ?? 'unknown',
      updateAvailable: json['updateAvailable'] as bool? ?? false,
      autoRestartReady: json['autoRestartReady'] as bool? ?? false,
      pendingChanges: json['pendingChanges'] is List
          ? (json['pendingChanges'] as List).whereType<String>().toList()
          : const <String>[],
      installedVersion: json['installedVersion'] as String?,
      runningVersion: json['runningVersion'] as String?,
      blockers: _toInt(json['blockers']),
      blockerComposition: json['blockerComposition'] is Map<String, dynamic>
          ? AgentRuntimeBlockerComposition.fromJson(
              json['blockerComposition'] as Map<String, dynamic>,
            )
          : null,
      blockerDetails: details,
      detail: json['detail'] as String?,
      checkedAt: _toInt(json['checkedAt']) ?? 0,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Agent id (for example, `codex`).
  final String agent;

  /// Human-readable runtime name.
  final String displayName;

  /// Optional broker/runtime tag for this daemon.
  final String? runtimeKind;

  /// Whether broker lifecycle owns this runtime.
  final bool managed;

  /// Current updater state.
  final String state;

  /// Whether an update is available.
  final bool updateAvailable;

  /// Whether auto-restart is allowed once the agent is eligible.
  final bool autoRestartReady;

  /// Native freshness causes requiring a managed-runtime restart.
  final List<String> pendingChanges;

  /// Installed runtime version.
  final String? installedVersion;

  /// Current running runtime version.
  final String? runningVersion;

  /// Count of blocker snapshots available.
  final int? blockers;

  /// Runtime status composition by blocker kind.
  final AgentRuntimeBlockerComposition? blockerComposition;

  /// Runtime-specific blockers by session/runtime context.
  final List<AgentRuntimeUpdateBlockerDetail> blockerDetails;

  /// Optional broker-provided detail text.
  final String? detail;

  /// Last status check time (epoch ms).
  final int checkedAt;

  /// Raw payload for future compatibility.
  final Map<String, dynamic> raw;

  /// `true` when [state] is recognized by this client model.
  bool get isKnownState => knownRuntimeUpdateStates.contains(state);

  /// Converts this update status to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..remove('ok')
      ..['agent'] = agent
      ..['displayName'] = displayName
      ..['managed'] = managed
      ..['state'] = state
      ..['updateAvailable'] = updateAvailable
      ..['autoRestartReady'] = autoRestartReady
      ..['pendingChanges'] = pendingChanges
      ..['checkedAt'] = checkedAt
      ..['blockerDetails'] = blockerDetails.map((e) => e.toJson()).toList();

    if (runtimeKind == null) {
      output.remove('runtimeKind');
    } else {
      output['runtimeKind'] = runtimeKind;
    }
    if (blockers == null) {
      output.remove('blockers');
    } else {
      output['blockers'] = blockers;
    }
    if (blockerComposition == null) {
      output.remove('blockerComposition');
    } else {
      output['blockerComposition'] = blockerComposition?.toJson();
    }
    if (detail == null) {
      output.remove('detail');
    } else {
      output['detail'] = detail;
    }
    if (installedVersion == null) {
      output.remove('installedVersion');
    } else {
      output['installedVersion'] = installedVersion;
    }
    if (runningVersion == null) {
      output.remove('runningVersion');
    } else {
      output['runningVersion'] = runningVersion;
    }

    return output;
  }
}

/// Composition of blockers for runtime updater state.
class AgentRuntimeBlockerComposition {
  /// Creates an [AgentRuntimeBlockerComposition].
  const AgentRuntimeBlockerComposition({
    required this.idle,
    required this.working,
    required this.needsInput,
    required this.unknown,
    this.raw = const <String, dynamic>{},
  });

  /// Creates an [AgentRuntimeBlockerComposition] from JSON.
  factory AgentRuntimeBlockerComposition.fromJson(Map<String, dynamic> json) {
    return AgentRuntimeBlockerComposition(
      idle: _toInt(json['idle']) ?? 0,
      working: _toInt(json['working']) ?? 0,
      needsInput: _toInt(json['needsInput']) ?? 0,
      unknown: _toInt(json['unknown']) ?? 0,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Blockers currently idle.
  final int idle;

  /// Blockers currently active/working.
  final int working;

  /// Blockers waiting for user input.
  final int needsInput;

  /// Blockers in unknown states.
  final int unknown;

  /// Raw payload for future-compatible fields.
  final Map<String, dynamic> raw;

  /// Converts this composition to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['idle'] = idle
      ..['working'] = working
      ..['needsInput'] = needsInput
      ..['unknown'] = unknown;
    return output;
  }
}

/// One runtime blocker detail entry for `/api/agent-runtime-updates`.
class AgentRuntimeUpdateBlockerDetail {
  /// Creates an [AgentRuntimeUpdateBlockerDetail].
  const AgentRuntimeUpdateBlockerDetail({
    required this.id,
    required this.status,
    this.detail,
    this.raw = const <String, dynamic>{},
  });

  /// Creates an [AgentRuntimeUpdateBlockerDetail] from JSON.
  factory AgentRuntimeUpdateBlockerDetail.fromJson(Map<String, dynamic> json) {
    return AgentRuntimeUpdateBlockerDetail(
      id: json['id'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      detail: json['detail'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Blocker id.
  final String id;

  /// Blocker status, including future unknown values.
  final String status;

  /// Optional blocker detail.
  final String? detail;

  /// Full payload for forward compatibility.
  final Map<String, dynamic> raw;

  /// `true` when [status] is recognized by this model.
  bool get isKnownStatus => knownRuntimeUpdateBlockerStatuses.contains(status);

  /// Converts this blocker detail to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['id'] = id
      ..['status'] = status;
    if (detail == null) {
      output.remove('detail');
    } else {
      output['detail'] = detail;
    }
    return output;
  }
}

/// Response from `GET /api/agent-runtime-updates`.
class RuntimeUpdatesResponse {
  /// Creates a [RuntimeUpdatesResponse].
  const RuntimeUpdatesResponse({
    this.ok,
    this.updates = const <AgentRuntimeUpdateStatus>[],
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [RuntimeUpdatesResponse] from JSON.
  factory RuntimeUpdatesResponse.fromJson(Map<String, dynamic> json) {
    final updates = json['updates'];
    return RuntimeUpdatesResponse(
      ok: json['ok'] as bool?,
      updates: updates is List
          ? updates
                .whereType<Map<String, dynamic>>()
                .map(AgentRuntimeUpdateStatus.fromJson)
                .toList()
          : const <AgentRuntimeUpdateStatus>[],
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Whether the request was accepted.
  final bool? ok;

  /// Current update statuses for managed runtimes.
  final List<AgentRuntimeUpdateStatus> updates;

  /// Raw payload for forward-compatible parsing.
  final Map<String, dynamic> raw;

  /// Converts this response to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['updates'] = updates.map((e) => e.toJson()).toList();
    return output;
  }
}

/// Response from `GET /api/agent-runtime-update-policy` and `POST` same route.
class CodexUpdatePolicyResponse {
  /// Creates a [CodexUpdatePolicyResponse].
  const CodexUpdatePolicyResponse({
    required this.codexUpdatePolicy,
    this.ok,
    this.update,
    this.message,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [CodexUpdatePolicyResponse] from JSON.
  factory CodexUpdatePolicyResponse.fromJson(Map<String, dynamic> json) {
    return CodexUpdatePolicyResponse(
      ok: json['ok'] as bool?,
      codexUpdatePolicy: json['codexUpdatePolicy'] as String?,
      update: json['update'] is Map<String, dynamic>
          ? AgentRuntimeUpdateStatus.fromJson(
              json['update'] as Map<String, dynamic>,
            )
          : null,
      message: json['message'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Whether route returned success.
  final bool? ok;

  /// Policy string, preserving unknown future values.
  final String? codexUpdatePolicy;

  /// Optional refresh result from posting the policy.
  final AgentRuntimeUpdateStatus? update;

  /// Optional message from the broker.
  final String? message;

  /// Forward-compatible payload.
  final Map<String, dynamic> raw;

  /// True when policy is known (`when-detached` or `when-idle`).
  bool get isKnownPolicy =>
      codexUpdatePolicy != null &&
      knownCodexUpdatePolicies.contains(codexUpdatePolicy);

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['codexUpdatePolicy'] = codexUpdatePolicy;
    if (update == null) {
      output.remove('update');
    } else {
      output['update'] = update!.toJson();
    }
    if (message == null) {
      output.remove('message');
    } else {
      output['message'] = message;
    }
    return output;
  }
}

/// Request body for `POST /api/agent-runtime-update-policy`.
class SetCodexUpdatePolicyRequest {
  /// Creates a [SetCodexUpdatePolicyRequest].
  const SetCodexUpdatePolicyRequest({
    required this.codexUpdatePolicy,
  });

  /// Policy string from user selection.
  final String codexUpdatePolicy;

  /// Converts this request to JSON.
  Map<String, dynamic> toJson() => {'codexUpdatePolicy': codexUpdatePolicy};
}

/// Response from `POST /api/agent-runtime-updates/:agent/restart`.
class RuntimeUpdateRestartResponse {
  /// Creates a [RuntimeUpdateRestartResponse].
  const RuntimeUpdateRestartResponse({
    this.ok,
    this.update,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [RuntimeUpdateRestartResponse] from JSON.
  factory RuntimeUpdateRestartResponse.fromJson(Map<String, dynamic> json) {
    return RuntimeUpdateRestartResponse(
      ok: json['ok'] as bool?,
      update: json['update'] is Map<String, dynamic>
          ? AgentRuntimeUpdateStatus.fromJson(
              json['update'] as Map<String, dynamic>,
            )
          : null,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Whether restart confirmation succeeded.
  final bool? ok;

  /// Updated runtime status snapshot.
  final AgentRuntimeUpdateStatus? update;

  /// Forward-compatible payload.
  final Map<String, dynamic> raw;

  /// Converts this response to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw);
    if (update == null) {
      output.remove('update');
    } else {
      output['update'] = update!.toJson();
    }
    return output;
  }
}

/// Response from `POST /api/agent-runtime-updates/:agent/restart` request body.
class RuntimeUpdateRestartRequest {
  /// Creates a [RuntimeUpdateRestartRequest].
  const RuntimeUpdateRestartRequest({
    required this.confirmRestart,
  });

  /// Must be true for state-changing runtime restart calls.
  final bool confirmRestart;

  /// Converts this request to JSON.
  Map<String, dynamic> toJson() => {'confirmRestart': confirmRestart};
}

/// Authenticated broker health snapshot from `/api/broker/health`.
class BrokerHealthResponse {
  /// Creates a [BrokerHealthResponse].
  const BrokerHealthResponse({
    required this.status,
    required this.checkedAt,
    this.ok,
    this.machine,
    this.principalKind,
    this.principalRoles = const <String>[],
    this.components = const <String, BrokerHealthComponentSnapshot>{},
    this.diagnostics,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [BrokerHealthResponse] from JSON.
  factory BrokerHealthResponse.fromJson(Map<String, dynamic> json) {
    final componentsJson = json['components'];
    final principal = json['principal'];
    return BrokerHealthResponse(
      ok: json['ok'] as bool?,
      machine: json['machine'] as String?,
      principalKind: principal is Map ? principal['kind'] as String? : null,
      principalRoles: principal is Map
          ? _toStringList(principal['roles'])
          : const <String>[],
      status: json['status'] as String? ?? 'unknown',
      checkedAt: _toInt(json['checkedAt']) ?? 0,
      components: componentsJson is Map
          ? _parseBrokerHealthComponents(
              componentsJson.cast<String, dynamic>(),
            )
          : const <String, BrokerHealthComponentSnapshot>{},
      diagnostics: json['diagnostics'] is Map<String, dynamic>
          ? BrokerHealthDiagnostics.fromJson(
              json['diagnostics'] as Map<String, dynamic>,
            )
          : null,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Optional wrapper status flag.
  final bool? ok;

  /// Machine label, often host.
  final String? machine;

  /// Authenticated principal kind (`owner` or `peer`) when advertised.
  final String? principalKind;

  /// Roles carried by a paired-device principal.
  final List<String> principalRoles;

  /// Whether owner-only administration should be presented by clients.
  bool get ownerOperationsAvailable => principalKind != 'peer';

  /// Overall broker health state.
  final String status;

  /// Last check time in epoch ms.
  final int checkedAt;

  /// Per-component health snapshots, including unknown keys.
  final Map<String, BrokerHealthComponentSnapshot> components;

  /// Optional diagnostics map.
  final BrokerHealthDiagnostics? diagnostics;

  /// Forward-compatible payload.
  final Map<String, dynamic> raw;

  /// `true` when [status] is one of the known broker states.
  bool get isKnownStatus => knownBrokerHealthStatuses.contains(status);

  /// Converts this response to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['status'] = status
      ..['checkedAt'] = checkedAt
      ..['components'] = components.map(
        (name, component) => MapEntry(name, component.toJson()),
      );
    if (principalKind == null) {
      output.remove('principal');
    } else {
      output['principal'] = {
        'kind': principalKind,
        if (principalKind == 'peer') 'roles': principalRoles,
      };
    }
    if (diagnostics == null) {
      output.remove('diagnostics');
    } else {
      output['diagnostics'] = diagnostics!.toJson();
    }
    return output;
  }
}

/// Per-component broker health snapshot.
class BrokerHealthComponentSnapshot {
  /// Creates a [BrokerHealthComponentSnapshot].
  const BrokerHealthComponentSnapshot({
    required this.status,
    required this.detailCodes,
    required this.checkedAt,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [BrokerHealthComponentSnapshot] from JSON.
  factory BrokerHealthComponentSnapshot.fromJson(Map<String, dynamic> json) {
    return BrokerHealthComponentSnapshot(
      status: json['status'] as String? ?? 'unknown',
      detailCodes: _toStringList(json['detailCodes']),
      checkedAt: _toInt(json['checkedAt']) ?? 0,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Component status.
  final String status;

  /// Raw component detail codes.
  final List<String> detailCodes;

  /// Last check time in epoch ms.
  final int checkedAt;

  /// Forward-compatible payload.
  final Map<String, dynamic> raw;

  /// Converts this component snapshot to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['status'] = status
      ..['detailCodes'] = detailCodes
      ..['checkedAt'] = checkedAt;
    return output;
  }
}

/// Optional diagnostics in broker health responses.
class BrokerHealthDiagnostics {
  /// Creates [BrokerHealthDiagnostics].
  const BrokerHealthDiagnostics({
    this.eventLoopDelayMs,
    this.rssBytes,
    this.heapUsedBytes,
    this.heapTotalBytes,
    this.uptimeSeconds,
    this.raw = const <String, dynamic>{},
  });

  /// Creates [BrokerHealthDiagnostics] from JSON.
  factory BrokerHealthDiagnostics.fromJson(Map<String, dynamic> json) {
    return BrokerHealthDiagnostics(
      eventLoopDelayMs: _toNum(json['eventLoopDelayMs']),
      rssBytes: _toNum(json['rssBytes']),
      heapUsedBytes: _toNum(json['heapUsedBytes']),
      heapTotalBytes: _toNum(json['heapTotalBytes']),
      uptimeSeconds: _toNum(json['uptimeSeconds']),
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Event loop delay in milliseconds.
  final num? eventLoopDelayMs;

  /// Resident set size bytes.
  final num? rssBytes;

  /// Heap used bytes.
  final num? heapUsedBytes;

  /// Heap total bytes.
  final num? heapTotalBytes;

  /// Process uptime in seconds.
  final num? uptimeSeconds;

  /// Raw forward-compatible fields.
  final Map<String, dynamic> raw;

  /// Converts this diagnostics payload to JSON.
  Map<String, dynamic> toJson() => raw;
}

/// Response from `POST /api/broker/restart-all`.
class BrokerRestartAllResponse {
  /// Creates a [BrokerRestartAllResponse].
  const BrokerRestartAllResponse({
    this.ok,
    this.partialFailure,
    this.components,
    this.message,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [BrokerRestartAllResponse] from JSON.
  factory BrokerRestartAllResponse.fromJson(Map<String, dynamic> json) {
    return BrokerRestartAllResponse(
      ok: json['ok'] as bool?,
      partialFailure: json['partialFailure'] as bool?,
      components: json['components'] is Map<String, dynamic>
          ? BrokerRestartAllComponents.fromJson(
              json['components'] as Map<String, dynamic>,
            )
          : null,
      message: json['message'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Optional top-level success flag.
  final bool? ok;

  /// `true` when a partial failure happened.
  final bool? partialFailure;

  /// Result components from restart-all pipeline.
  final BrokerRestartAllComponents? components;

  /// Optional message.
  final String? message;

  /// Raw payload for forward compatibility.
  final Map<String, dynamic> raw;

  /// Converts to JSON, preserving unknown top-level/component fields.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..remove('ok')
      ..remove('partialFailure')
      ..remove('components')
      ..remove('message')
      ..['ok'] = ok
      ..['partialFailure'] = partialFailure
      ..['message'] = message;

    if (components == null) {
      output.remove('components');
    } else {
      output['components'] = components!.toJson();
    }
    if (ok == null) {
      output.remove('ok');
    }
    if (partialFailure == null) {
      output.remove('partialFailure');
    }
    if (message == null) {
      output.remove('message');
    }

    return output;
  }
}

/// Restart-all component-level payloads.
class BrokerRestartAllComponents {
  /// Creates [BrokerRestartAllComponents].
  const BrokerRestartAllComponents({
    this.codex,
    this.opencode,
    this.broker,
    this.extra = const <String, Map<String, dynamic>>{},
    this.raw = const <String, dynamic>{},
  });

  /// Creates [BrokerRestartAllComponents] from JSON.
  factory BrokerRestartAllComponents.fromJson(Map<String, dynamic> json) {
    final knownKeys = {
      'codex',
      'opencode',
      'broker',
    };
    final extras = <String, Map<String, dynamic>>{};
    for (final entry in json.entries) {
      if (!knownKeys.contains(entry.key) && entry.value is Map) {
        extras[entry.key] = Map<String, dynamic>.from(
          entry.value as Map<dynamic, dynamic>,
        );
      }
    }

    return BrokerRestartAllComponents(
      codex: json['codex'] is Map<String, dynamic>
          ? BrokerRestartAllCodexResult.fromJson(
              json['codex'] as Map<String, dynamic>,
            )
          : null,
      opencode: json['opencode'] is Map<String, dynamic>
          ? BrokerRestartAllOpencodeResult.fromJson(
              json['opencode'] as Map<String, dynamic>,
            )
          : null,
      broker: json['broker'] is Map<String, dynamic>
          ? BrokerRestartAllBrokerResult.fromJson(
              json['broker'] as Map<String, dynamic>,
            )
          : null,
      extra: extras,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Codex restart result.
  final BrokerRestartAllCodexResult? codex;

  /// Opencode restart result.
  final BrokerRestartAllOpencodeResult? opencode;

  /// Broker restart result.
  final BrokerRestartAllBrokerResult? broker;

  /// Unknown extra component payloads.
  final Map<String, Map<String, dynamic>> extra;

  /// Raw payload for forward compatibility.
  final Map<String, dynamic> raw;

  /// Unknown component payloads keyed by broker key.
  Map<String, Map<String, dynamic>> get extraComponents => extra;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = <String, dynamic>{}
      ..addEntries(
        raw.entries.where(
          (entry) => !['codex', 'opencode', 'broker'].contains(entry.key),
        ),
      )
      ..['codex'] = codex?.toJson()
      ..['opencode'] = opencode?.toJson()
      ..['broker'] = broker?.toJson()
      ..removeWhere((_, value) => value == null);
    return output;
  }
}

/// Response for Codex entry in `POST /api/broker/restart-all`.
class BrokerRestartAllCodexResult {
  /// Creates a [BrokerRestartAllCodexResult].
  const BrokerRestartAllCodexResult({
    this.ok,
    this.skipped,
    this.reason,
    this.error,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [BrokerRestartAllCodexResult] from JSON.
  factory BrokerRestartAllCodexResult.fromJson(Map<String, dynamic> json) {
    return BrokerRestartAllCodexResult(
      ok: json['ok'] as bool?,
      skipped: json['skipped'] as bool?,
      reason: json['reason'] as String?,
      error: json['error'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Codex restart success flag.
  final bool? ok;

  /// Whether restart was skipped intentionally.
  final bool? skipped;

  /// Optional skip reason.
  final String? reason;

  /// Optional error when restart fails.
  final String? error;

  /// Raw fields for future compatibility.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw);
    if (ok == null) {
      output.remove('ok');
    } else {
      output['ok'] = ok;
    }
    if (skipped == null) {
      output.remove('skipped');
    } else {
      output['skipped'] = skipped;
    }
    if (reason == null) {
      output.remove('reason');
    } else {
      output['reason'] = reason;
    }
    if (error == null) {
      output.remove('error');
    } else {
      output['error'] = error;
    }
    return output;
  }
}

/// Response for OpenCode entry in `POST /api/broker/restart-all`.
class BrokerRestartAllOpencodeResult {
  /// Creates a [BrokerRestartAllOpencodeResult].
  const BrokerRestartAllOpencodeResult({
    this.strategy,
    this.restartsWithBroker,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [BrokerRestartAllOpencodeResult] from JSON.
  factory BrokerRestartAllOpencodeResult.fromJson(Map<String, dynamic> json) {
    return BrokerRestartAllOpencodeResult(
      strategy: json['strategy'] as String?,
      restartsWithBroker: json['restartsWithBroker'] as bool?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// The broker restart strategy used for OpenCode.
  final String? strategy;

  /// Whether OpenCode restarts with broker process.
  final bool? restartsWithBroker;

  /// Raw fields for forward compatibility.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw);
    if (strategy == null) {
      output.remove('strategy');
    } else {
      output['strategy'] = strategy;
    }
    if (restartsWithBroker == null) {
      output.remove('restartsWithBroker');
    } else {
      output['restartsWithBroker'] = restartsWithBroker;
    }
    return output;
  }
}

/// Response for Broker entry in `POST /api/broker/restart-all`.
class BrokerRestartAllBrokerResult {
  /// Creates a [BrokerRestartAllBrokerResult].
  const BrokerRestartAllBrokerResult({
    this.scheduled,
    this.dryRun,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [BrokerRestartAllBrokerResult] from JSON.
  factory BrokerRestartAllBrokerResult.fromJson(Map<String, dynamic> json) {
    return BrokerRestartAllBrokerResult(
      scheduled: json['scheduled'] as bool?,
      dryRun: json['dryRun'] as bool?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Whether broker restart was scheduled.
  final bool? scheduled;

  /// Whether this was a dry-run request.
  final bool? dryRun;

  /// Raw payload fields.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw);
    if (scheduled == null) {
      output.remove('scheduled');
    } else {
      output['scheduled'] = scheduled;
    }
    if (dryRun == null) {
      output.remove('dryRun');
    } else {
      output['dryRun'] = dryRun;
    }
    return output;
  }
}

/// Response for `GET /api/tokdash/quota`.
class TokdashQuotaResponse {
  /// Creates a [TokdashQuotaResponse].
  const TokdashQuotaResponse({
    this.ok,
    this.baseUrl,
    this.endpoint,
    this.data,
    this.error,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [TokdashQuotaResponse] from JSON.
  factory TokdashQuotaResponse.fromJson(Map<String, dynamic> json) {
    return TokdashQuotaResponse(
      ok: json['ok'] as bool?,
      baseUrl: json['baseUrl'] as String?,
      endpoint: json['endpoint'] as String?,
      data: json['data'] is Map<String, dynamic>
          ? TokdashQuotaData.fromJson(json['data'] as Map<String, dynamic>)
          : null,
      error: json['error'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Optional wrapper flag.
  final bool? ok;

  /// Normalized Tokdash base URL used by broker.
  final String? baseUrl;

  /// Relative endpoint used for quota request.
  final String? endpoint;

  /// Parsed quota data.
  final TokdashQuotaData? data;

  /// Broker error string, if any.
  final String? error;

  /// Raw forward-compatible payload.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['ok'] = ok
      ..['baseUrl'] = baseUrl
      ..['endpoint'] = endpoint
      ..['error'] = error;

    if (data == null) {
      output.remove('data');
    } else {
      output['data'] = data!.toJson();
    }
    if (error == null) {
      output.remove('error');
    }
    if (baseUrl == null) {
      output.remove('baseUrl');
    }
    if (endpoint == null) {
      output.remove('endpoint');
    }
    if (ok == null) {
      output.remove('ok');
    }
    return output;
  }
}

/// Tokdash quota data for `/api/tokdash/quota`.
class TokdashQuotaData {
  /// Creates a [TokdashQuotaData].
  const TokdashQuotaData({
    required this.enabled,
    required this.timestamp,
    required this.providers,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [TokdashQuotaData] from JSON.
  factory TokdashQuotaData.fromJson(Map<String, dynamic> json) {
    final providersJson = json['providers'];
    final providers = <String, TokdashQuotaProvider>{};
    if (providersJson is Map) {
      final castedProviders = providersJson.cast<String, dynamic>();
      for (final entry in castedProviders.entries) {
        final providerKey = entry.key;
        final providerJson = entry.value;
        providers[providerKey] = providerJson is Map<String, dynamic>
            ? TokdashQuotaProvider.fromJson(
                providerJson,
                providerKey: providerKey,
              )
            : TokdashQuotaProvider.empty(provider: providerKey);
      }
    }

    return TokdashQuotaData(
      enabled: json['enabled'] as bool? ?? false,
      timestamp: _toEpochMs(json['timestamp'])?.toInt() ?? 0,
      providers: providers,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Whether quota monitoring is enabled.
  final bool enabled;

  /// Snapshot timestamp, epoch milliseconds.
  final int timestamp;

  /// Providers keyed by provider id.
  final Map<String, TokdashQuotaProvider> providers;

  /// Raw forward-compatible payload.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final providerMap = providers.map(
      (key, provider) => MapEntry(key, provider.toJson()),
    );
    final output = Map<String, dynamic>.of(raw)
      ..['enabled'] = enabled
      ..['timestamp'] = timestamp
      ..['providers'] = providerMap;
    return output;
  }
}

/// One provider record in tokdash quota state.
class TokdashQuotaProvider {
  /// Creates a [TokdashQuotaProvider].
  const TokdashQuotaProvider({
    required this.provider,
    required this.networkEnabled,
    required this.buckets,
    required this.status,
    required this.sources,
    required this.estimated,
    required this.raw,
    this.statusDetail,
    this.statusAt,
    this.updatedAt,
  });

  /// Creates an intentionally minimal fallback provider from unknown shape.
  factory TokdashQuotaProvider.empty({
    required String provider,
  }) {
    return TokdashQuotaProvider(
      provider: provider,
      networkEnabled: false,
      buckets: const <TokdashQuotaBucket>[],
      status: 'unknown',
      sources: const <String>[],
      estimated: false,
      raw: <String, dynamic>{'provider': provider},
    );
  }

  /// Creates a [TokdashQuotaProvider] from JSON.
  factory TokdashQuotaProvider.fromJson(
    Map<String, dynamic> json, {
    String? providerKey,
  }) {
    final bucketsJson = json['buckets'];
    final buckets = bucketsJson is List
        ? bucketsJson
              .whereType<Map<String, dynamic>>()
              .map(
                TokdashQuotaBucket.fromJson,
              )
              .toList()
        : const <TokdashQuotaBucket>[];
    final sourcesJson = json['sources'];
    return TokdashQuotaProvider(
      provider: json['provider'] as String? ?? providerKey ?? 'unknown',
      networkEnabled: json['network_enabled'] as bool? ?? false,
      buckets: buckets,
      status: json['status'] as String? ?? 'unknown',
      statusDetail: json['status_detail'] as String?,
      statusAt: _toEpochMs(json['status_at'])?.toInt(),
      updatedAt: _toEpochMs(json['updated_at'])?.toInt(),
      sources: sourcesJson is List
          ? sourcesJson.whereType<String>().toList()
          : const <String>[],
      estimated: json['estimated'] as bool? ?? false,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Provider identifier/name.
  final String provider;

  /// Whether network is enabled in this provider.
  final bool networkEnabled;

  /// Buckets reported by this provider.
  final List<TokdashQuotaBucket> buckets;

  /// Provider status.
  final String status;

  /// Optional status detail.
  final String? statusDetail;

  /// Optional status timestamp, epoch milliseconds.
  final int? statusAt;

  /// Optional most recent update timestamp, epoch milliseconds.
  final int? updatedAt;

  /// Source labels.
  final List<String> sources;

  /// Whether quota numbers are estimated.
  final bool estimated;

  /// Raw payload for future fields.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() => {
    ...raw,
    'provider': provider,
    'network_enabled': networkEnabled,
    'buckets': buckets.map((bucket) => bucket.toJson()).toList(),
    'status': status,
    'sources': sources,
    'estimated': estimated,
    if (statusDetail != null) 'status_detail': statusDetail,
    if (statusAt != null) 'status_at': statusAt,
    if (updatedAt != null) 'updated_at': updatedAt,
  };
}

/// Tokdash bucket detail for `/api/tokdash/quota`.
class TokdashQuotaBucket {
  /// Creates a [TokdashQuotaBucket].
  const TokdashQuotaBucket({
    required this.account,
    required this.bucket,
    required this.bucketLabel,
    required this.usedPercent,
    required this.remainingPercent,
    required this.resetsAt,
    required this.capturedAt,
    required this.source,
    required this.status,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [TokdashQuotaBucket] from JSON.
  factory TokdashQuotaBucket.fromJson(Map<String, dynamic> json) {
    return TokdashQuotaBucket(
      account: json['account'] as String? ?? '',
      bucket: json['bucket'] as String? ?? '',
      bucketLabel: json['bucket_label'] as String? ?? '',
      usedPercent: _toNum(json['used_percent']),
      remainingPercent: _toNum(json['remaining_percent']),
      resetsAt: _toEpochMs(json['resets_at']),
      capturedAt: _toEpochMs(json['captured_at']) ?? 0,
      source: json['source'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Provider account.
  final String account;

  /// Bucket identifier.
  final String bucket;

  /// Human bucket label.
  final String bucketLabel;

  /// Used percentage, if provided.
  final num? usedPercent;

  /// Remaining percentage.
  final num? remainingPercent;

  /// Reset epoch in milliseconds, if available.
  final num? resetsAt;

  /// Capture epoch in milliseconds.
  final num capturedAt;

  /// Bucket source.
  final String source;

  /// Bucket status.
  final String status;

  /// Raw payload for future-compatible fields.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() => {
    ...raw,
    'account': account,
    'bucket': bucket,
    'bucket_label': bucketLabel,
    if (usedPercent != null) 'used_percent': usedPercent,
    if (remainingPercent != null) 'remaining_percent': remainingPercent,
    if (resetsAt != null) 'resets_at': resetsAt,
    'captured_at': capturedAt,
    'source': source,
    'status': status,
  };
}

/// Response from `GET`/`POST /api/tokdash/quota-preference`.
class TokdashQuotaPreferenceResponse {
  /// Creates a [TokdashQuotaPreferenceResponse].
  const TokdashQuotaPreferenceResponse({
    this.ok,
    this.enabled,
    this.error,
    this.raw = const <String, dynamic>{},
  });

  /// Creates a [TokdashQuotaPreferenceResponse] from JSON.
  factory TokdashQuotaPreferenceResponse.fromJson(Map<String, dynamic> json) {
    return TokdashQuotaPreferenceResponse(
      ok: json['ok'] as bool?,
      enabled: json['enabled'] as bool?,
      error: json['error'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Optional wrapper flag.
  final bool? ok;

  /// Preference state.
  final bool? enabled;

  /// Error detail.
  final String? error;

  /// Raw payload.
  final Map<String, dynamic> raw;

  /// Converts to JSON.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..['enabled'] = enabled
      ..['ok'] = ok;
    if (error == null) {
      output.remove('error');
    } else {
      output['error'] = error;
    }
    if (ok == null) {
      output.remove('ok');
    }
    if (enabled == null) {
      output.remove('enabled');
    }
    return output;
  }
}

/// Request body for `POST /api/tokdash/quota-preference`.
class TokdashQuotaPreferenceRequest {
  /// Creates a [TokdashQuotaPreferenceRequest].
  const TokdashQuotaPreferenceRequest({
    required this.enabled,
  });

  /// New enabled state.
  final bool enabled;

  /// Converts this request to JSON.
  Map<String, dynamic> toJson() => {'enabled': enabled};
}

Map<String, BrokerHealthComponentSnapshot> _parseBrokerHealthComponents(
  Map<String, dynamic> json,
) {
  final components = <String, BrokerHealthComponentSnapshot>{};
  for (final entry in json.entries) {
    final value = entry.value;
    if (value is Map<String, dynamic>) {
      components[entry.key] = BrokerHealthComponentSnapshot.fromJson(value);
    } else if (value is Map) {
      components[entry.key] = BrokerHealthComponentSnapshot.fromJson(
        value.cast<String, dynamic>(),
      );
    }
  }
  return components;
}

List<String> _toStringList(dynamic value) =>
    value is List ? value.whereType<String>().toList() : const <String>[];

int? _toInt(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return null;
}

num? _toNum(dynamic value) {
  if (value is num) return value;
  return null;
}

/// Normalizes a Tokdash epoch timestamp to milliseconds.
///
/// The contract documents these fields as epoch milliseconds, but Tokdash's
/// `/api/quota` payload emits epoch seconds (10 digits) while fixtures and
/// future producers may already emit milliseconds (13 digits). The threshold
/// cleanly separates the two for any plausible date (epoch seconds pass 1e11
/// only in the year 5138), so the model always holds milliseconds regardless
/// of which unit arrived on the wire.
num? _toEpochMs(dynamic value) {
  final parsed = _toNum(value);
  if (parsed == null) return null;
  return parsed.abs() < 100000000000 ? parsed * 1000 : parsed;
}
