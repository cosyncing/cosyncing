// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'health_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

HealthResponse _$HealthResponseFromJson(Map<String, dynamic> json) =>
    HealthResponse(
      ok: json['ok'] as bool,
      product: json['product'] as String?,
      version: json['version'] as String?,
      contract: json['contract'] == null
          ? null
          : BrokerContractIdentity.fromJson(
              json['contract'] as Map<String, dynamic>,
            ),
      machine: json['machine'] as String?,
      controlMode: json['controlMode'] as String?,
      codexSyncServer: json['codexSyncServer'] as bool?,
      healthStatus: json['healthStatus'] as String?,
      healthCheckedAt: (json['healthCheckedAt'] as num?)?.toInt(),
    );

Map<String, dynamic> _$HealthResponseToJson(HealthResponse instance) =>
    <String, dynamic>{
      'ok': instance.ok,
      'product': instance.product,
      'version': instance.version,
      'contract': instance.contract?.toJson(),
      'machine': instance.machine,
      'controlMode': instance.controlMode,
      'codexSyncServer': instance.codexSyncServer,
      'healthStatus': instance.healthStatus,
      'healthCheckedAt': instance.healthCheckedAt,
    };
