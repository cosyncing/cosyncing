/// The versioned update management surface, independent of session driving.
library;

Map<String, dynamic> _object(Object? value) =>
    Map<String, dynamic>.from(value! as Map);
List<Map<String, dynamic>> _objects(Object? value) =>
    (value as List<dynamic>? ?? const []).map(_object).toList();
List<String> _strings(Object? value) =>
    (value as List<dynamic>? ?? const []).cast<String>();

void _schema(Map<String, dynamic> json) {
  if (json['schemaVersion'] != 1) {
    throw const FormatException('Unsupported update management schema');
  }
}

class UpdateBuildIdentity {
  const UpdateBuildIdentity({this.version, this.buildId, this.releaseId});
  factory UpdateBuildIdentity.fromJson(Map<String, dynamic> json) =>
      UpdateBuildIdentity(
        version: json['version'] as String?,
        buildId: json['buildId'] as String?,
        releaseId: json['releaseId'] as String?,
      );
  final String? version;
  final String? buildId;
  final String? releaseId;
  Map<String, dynamic> toJson() => {
    if (version != null) 'version': version,
    if (buildId != null) 'buildId': buildId,
    if (releaseId != null) 'releaseId': releaseId,
  };
}

class UpdateBlocker {
  UpdateBlocker.fromJson(Map<String, dynamic> json)
    : code = json['code'] as String,
      detail = json['detail'] as String,
      guidance = json['guidance'] as String?;
  final String code;
  final String detail;
  final String? guidance;
}

class UpdateComponentInventory {
  UpdateComponentInventory.fromJson(Map<String, dynamic> json)
    : component = json['component'] as String,
      ownership = json['ownership'] as String,
      running = UpdateBuildIdentity.fromJson(_object(json['running'])),
      available = json['available'] == null
          ? null
          : UpdateBuildIdentity.fromJson(_object(json['available'])),
      canPlan = json['canPlan'] == true,
      canApply = json['canApply'] == true,
      activeJobId = json['activeJobId'] as String?,
      blockers = _objects(
        json['blockers'],
      ).map(UpdateBlocker.fromJson).toList();
  final String component;
  final String ownership;
  final UpdateBuildIdentity running;
  final UpdateBuildIdentity? available;
  final bool canPlan;
  final bool canApply;
  final String? activeJobId;
  final List<UpdateBlocker> blockers;
}

class BrokerUpdateInventory {
  BrokerUpdateInventory.fromJson(Map<String, dynamic> json)
    : _json = Map.unmodifiable(json),
      installationId = json['installationId'] as String,
      installationGeneration = json['installationGeneration'] as int,
      managementVersion = json['updateManagementVersion'] as int?,
      components = _objects(
        json['components'],
      ).map(UpdateComponentInventory.fromJson).toList(),
      busy = _object(json['busy'])['state'] as String,
      checkedAt = DateTime.parse(json['checkedAt'] as String) {
    _schema(json);
  }
  final Map<String, dynamic> _json;
  Map<String, dynamic> toJson() => Map.of(_json);
  final String installationId;
  final int installationGeneration;
  final int? managementVersion;
  final List<UpdateComponentInventory> components;
  final String busy;
  final DateTime checkedAt;
  UpdateComponentInventory get broker =>
      components.firstWhere((row) => row.component == 'broker');
}

class BrokerUpdateCheck {
  BrokerUpdateCheck.fromJson(Map<String, dynamic> json)
    : _json = Map.unmodifiable(json),
      status = json['status'] as String,
      detailCode = json['detailCode'] as String,
      available = _objects(json['components'])
          .where((row) => row['component'] == 'broker')
          .map((row) => row['available'])
          .whereType<Map<String, dynamic>>()
          .map(UpdateBuildIdentity.fromJson)
          .firstOrNull {
    _schema(json);
  }
  final Map<String, dynamic> _json;
  Map<String, dynamic> toJson() => Map.of(_json);
  final String status;
  final String detailCode;
  final UpdateBuildIdentity? available;
}

class UpdatePlannedComponent {
  UpdatePlannedComponent.fromJson(Map<String, dynamic> json)
    : component = json['component'] as String,
      from = UpdateBuildIdentity.fromJson(_object(json['from'])),
      to = UpdateBuildIdentity.fromJson(_object(json['to'])),
      noOp = json['noOp'] == true,
      downloadBytes = json['downloadBytes'] as int?;
  final String component;
  final UpdateBuildIdentity from;
  final UpdateBuildIdentity to;
  final bool noOp;
  final int? downloadBytes;
}

class BrokerUpdatePlan {
  BrokerUpdatePlan.fromJson(Map<String, dynamic> json)
    : _json = Map.unmodifiable(json),
      planId = json['planId'] as String,
      releaseId = json['releaseId'] as String,
      installationId = json['installationId'] as String,
      installationGeneration = json['installationGeneration'] as int,
      expiresAt = DateTime.parse(json['expiresAt'] as String),
      components = _objects(
        json['components'],
      ).map(UpdatePlannedComponent.fromJson).toList(),
      requiredAcknowledgements = _strings(json['requiredAcknowledgements']),
      outstandingAcknowledgements = _strings(
        json['outstandingAcknowledgements'],
      ),
      blockers = _objects(
        json['blockers'],
      ).map(UpdateBlocker.fromJson).toList() {
    _schema(json);
  }
  final Map<String, dynamic> _json;
  final String planId;
  final String releaseId;
  final String installationId;
  final int installationGeneration;
  final DateTime expiresAt;
  final List<UpdatePlannedComponent> components;
  final List<String> requiredAcknowledgements;
  final List<String> outstandingAcknowledgements;
  final List<UpdateBlocker> blockers;
  Map<String, dynamic> toJson() => Map.of(_json);
}

class BrokerUpdateJob {
  BrokerUpdateJob.fromJson(Map<String, dynamic> json)
    : _json = Map.unmodifiable(json),
      jobId = json['jobId'] as String,
      planId = json['planId'] as String,
      releaseId = json['releaseId'] as String,
      installationId = json['installationId'] as String,
      installationGeneration = json['installationGeneration'] as int,
      phase = json['phase'] as String,
      sequence = json['sequence'] as int,
      result = json['result'] as String?,
      detailCode =
          _objects(json['events']).lastOrNull?['detailCode'] as String? {
    _schema(json);
  }
  final Map<String, dynamic> _json;
  final String jobId;
  final String planId;
  final String releaseId;
  final String installationId;
  final int installationGeneration;
  final String phase;
  final int sequence;
  final String? result;
  final String? detailCode;
  bool get terminal => const {
    'succeeded',
    'failed',
    'rolled_back',
    'needs_attention',
    'cancelled',
  }.contains(phase);
  Map<String, dynamic> toJson() => Map.of(_json);
}

class BrokerUpdateGrant {
  BrokerUpdateGrant.fromJson(Map<String, dynamic> json)
    : peerId = json['peerId'] as String,
      revoked = json['revokedAt'] != null;
  final String peerId;
  final bool revoked;
}

class BrokerUpdateGrants {
  BrokerUpdateGrants.fromJson(Map<String, dynamic> json)
    : grants = _objects(
        json['grants'],
      ).map(BrokerUpdateGrant.fromJson).toList(),
      requests = _objects(
        json['requests'],
      ).map((row) => row['peerId']! as String).toList();
  final List<BrokerUpdateGrant> grants;
  final List<String> requests;
}

class BrokerUpdateHistoryEntry {
  BrokerUpdateHistoryEntry.fromJson(Map<String, dynamic> json)
    : jobId = json['jobId'] as String,
      releaseId = json['releaseId'] as String,
      result = json['result'] as String,
      finishedAt = DateTime.parse(json['finishedAt'] as String),
      detailCodes = _strings(json['detailCodes']);
  final String jobId;
  final String releaseId;
  final String result;
  final DateTime finishedAt;
  final List<String> detailCodes;
}
