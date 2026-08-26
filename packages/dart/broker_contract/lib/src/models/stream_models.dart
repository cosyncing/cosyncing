import 'package:json_annotation/json_annotation.dart';

part 'stream_models.g.dart';

/// Behavioral class advertised for a slash command.
enum SlashCommandKind {
  /// A quick state mutation that does not start a prompt turn.
  action,

  /// A prompt-like command that starts or participates in a turn.
  prompt,

  /// Missing or future command kind. Consumers must fail closed when an
  /// action requires explicit capability proof.
  unknown,
}

/// A slash command available in the session.
///
/// Sent by the broker in `commands` wire events.
@JsonSerializable()
class SlashCommand {
  const SlashCommand({
    required this.name,
    this.description,
    this.usage,
    this.args,
    this.kind = SlashCommandKind.unknown,
  });

  factory SlashCommand.fromJson(Map<String, dynamic> json) =>
      _$SlashCommandFromJson(json);

  final String name;
  final String? description;
  final String? usage;

  /// Command arguments schema or help text, if provided.
  final Map<String, dynamic>? args;

  /// Whether this command is an action or starts a prompt turn.
  @JsonKey(unknownEnumValue: SlashCommandKind.unknown)
  final SlashCommandKind kind;

  Map<String, dynamic> toJson() => _$SlashCommandToJson(this);
}

/// A model option available for the session.
///
/// Matches the broker/core `ModelOption` interface exactly.
@JsonSerializable()
class ModelOption {
  const ModelOption({
    required this.providerID,
    required this.modelID,
    required this.label,
    this.providerLabel,
    this.variant,
    this.description,
    this.reasoningEfforts,
    this.defaultReasoningEffort,
  });

  factory ModelOption.fromJson(Map<String, dynamic> json) =>
      _$ModelOptionFromJson(json);

  final String providerID;
  final String? providerLabel;
  final String modelID;
  final String? variant;
  final String label;
  final String? description;

  /// Available reasoning effort levels for this model.
  final List<ReasoningEffort>? reasoningEfforts;
  final String? defaultReasoningEffort;

  Map<String, dynamic> toJson() => _$ModelOptionToJson(this);
}

/// A reasoning effort level for a model.
@JsonSerializable()
class ReasoningEffort {
  const ReasoningEffort({
    required this.effort,
    required this.label,
    this.description,
  });

  factory ReasoningEffort.fromJson(Map<String, dynamic> json) =>
      _$ReasoningEffortFromJson(json);

  final String effort;
  final String label;
  final String? description;

  Map<String, dynamic> toJson() => _$ReasoningEffortToJson(this);
}

/// An agent/mode option available for the session.
///
/// Matches the broker/core `AgentOption` interface exactly.
@JsonSerializable()
class AgentOption {
  const AgentOption({
    required this.name,
    this.description,
  });

  factory AgentOption.fromJson(Map<String, dynamic> json) =>
      _$AgentOptionFromJson(json);

  final String name;
  final String? description;

  Map<String, dynamic> toJson() => _$AgentOptionToJson(this);
}

/// A permission/approval mode option available for the session.
///
/// Matches the broker/core `ModeOption` interface exactly.
@JsonSerializable()
class ModeOption {
  const ModeOption({
    required this.value,
    required this.label,
    this.description,
    this.category,
  });

  factory ModeOption.fromJson(Map<String, dynamic> json) =>
      _$ModeOptionFromJson(json);

  final String value;
  final String label;
  final String? description;

  /// Grouping for UI copy: ask-permission, approve-for-me, full-access, custom.
  final String? category;

  Map<String, dynamic> toJson() => _$ModeOptionToJson(this);
}
