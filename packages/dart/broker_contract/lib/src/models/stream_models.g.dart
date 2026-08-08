// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'stream_models.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SlashCommand _$SlashCommandFromJson(Map<String, dynamic> json) => SlashCommand(
  name: json['name'] as String,
  description: json['description'] as String?,
  usage: json['usage'] as String?,
  args: json['args'] as Map<String, dynamic>?,
  kind:
      $enumDecodeNullable(
        _$SlashCommandKindEnumMap,
        json['kind'],
        unknownValue: SlashCommandKind.unknown,
      ) ??
      SlashCommandKind.unknown,
);

Map<String, dynamic> _$SlashCommandToJson(SlashCommand instance) =>
    <String, dynamic>{
      'name': instance.name,
      'description': instance.description,
      'usage': instance.usage,
      'args': instance.args,
      'kind': _$SlashCommandKindEnumMap[instance.kind]!,
    };

const _$SlashCommandKindEnumMap = {
  SlashCommandKind.action: 'action',
  SlashCommandKind.prompt: 'prompt',
  SlashCommandKind.unknown: 'unknown',
};

ModelOption _$ModelOptionFromJson(Map<String, dynamic> json) => ModelOption(
  providerID: json['providerID'] as String,
  modelID: json['modelID'] as String,
  label: json['label'] as String,
  variant: json['variant'] as String?,
  description: json['description'] as String?,
  reasoningEfforts: (json['reasoningEfforts'] as List<dynamic>?)
      ?.map((e) => ReasoningEffort.fromJson(e as Map<String, dynamic>))
      .toList(),
  defaultReasoningEffort: json['defaultReasoningEffort'] as String?,
);

Map<String, dynamic> _$ModelOptionToJson(ModelOption instance) =>
    <String, dynamic>{
      'providerID': instance.providerID,
      'modelID': instance.modelID,
      'variant': instance.variant,
      'label': instance.label,
      'description': instance.description,
      'reasoningEfforts': instance.reasoningEfforts,
      'defaultReasoningEffort': instance.defaultReasoningEffort,
    };

ReasoningEffort _$ReasoningEffortFromJson(Map<String, dynamic> json) =>
    ReasoningEffort(
      effort: json['effort'] as String,
      label: json['label'] as String,
      description: json['description'] as String?,
    );

Map<String, dynamic> _$ReasoningEffortToJson(ReasoningEffort instance) =>
    <String, dynamic>{
      'effort': instance.effort,
      'label': instance.label,
      'description': instance.description,
    };

AgentOption _$AgentOptionFromJson(Map<String, dynamic> json) => AgentOption(
  name: json['name'] as String,
  description: json['description'] as String?,
);

Map<String, dynamic> _$AgentOptionToJson(AgentOption instance) =>
    <String, dynamic>{
      'name': instance.name,
      'description': instance.description,
    };

ModeOption _$ModeOptionFromJson(Map<String, dynamic> json) => ModeOption(
  value: json['value'] as String,
  label: json['label'] as String,
  description: json['description'] as String?,
  category: json['category'] as String?,
);

Map<String, dynamic> _$ModeOptionToJson(ModeOption instance) =>
    <String, dynamic>{
      'value': instance.value,
      'label': instance.label,
      'description': instance.description,
      'category': instance.category,
    };
