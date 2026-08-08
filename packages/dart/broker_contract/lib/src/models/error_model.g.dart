// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'error_model.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

BrokerError _$BrokerErrorFromJson(Map<String, dynamic> json) =>
    BrokerError(error: json['error'] as String, code: json['code'] as String?);

Map<String, dynamic> _$BrokerErrorToJson(BrokerError instance) =>
    <String, dynamic>{'error': instance.error, 'code': instance.code};
