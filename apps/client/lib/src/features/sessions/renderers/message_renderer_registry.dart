import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_diff_body_loader.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_presentation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

part 'conversation_message_widgets.dart';
part 'message_family_renderers.dart';
part 'message_renderer_formatting.dart';
part 'tool_diff_view.dart';
part 'tool_family_views.dart';
part 'tool_message_cards.dart';
part 'transcript_code_block.dart';
part 'transcript_file_link.dart';
part 'transcript_markdown_body.dart';
part 'transcript_message_widgets.dart';

/// Render callback for one `AgentMessage`.
typedef AgentMessageRenderer =
    Widget Function(
      BuildContext context,
      AgentMessage message,
    );

/// Registry of canonical message renderers keyed by [AgentMessageType].
///
/// This registry intentionally remains type-driven and does not branch on tool
/// names. Final rendering behavior grows over modules.
/// Governing doc: docs/architecture/client-ui.md
final Map<AgentMessageType, AgentMessageRenderer> agentMessageRendererRegistry =
    {
      AgentMessageType.modelOutput: _modelOutputMessageRenderer,
      AgentMessageType.thinking: _thinkingMessageRenderer,
      AgentMessageType.status: _statusMessageRenderer,
      AgentMessageType.toolCall: _toolCallMessageRenderer,
      AgentMessageType.toolResult: _toolResultMessageRenderer,
      AgentMessageType.fsEdit: _fsEditMessageRenderer,
      AgentMessageType.fileArtifact: _fileArtifactMessageRenderer,
      AgentMessageType.permissionRequest: _permissionRequestMessageRenderer,
      AgentMessageType.permissionResolved: _permissionResolvedMessageRenderer,
      AgentMessageType.questionRequest: _questionRequestMessageRenderer,
      AgentMessageType.questionResolved: _questionResolvedMessageRenderer,
      AgentMessageType.terminalOutput: _terminalOutputMessageRenderer,
      AgentMessageType.notice: _noticeMessageRenderer,
      AgentMessageType.metadataUpdate: _metadataUpdateMessageRenderer,
      AgentMessageType.tokenCount: _tokenCountMessageRenderer,
      AgentMessageType.runSummary: _runSummaryMessageRenderer,
      AgentMessageType.userMessage: _userMessageRenderer,
      AgentMessageType.event: _eventMessageRenderer,
      AgentMessageType.goalState: _goalStateMessageRenderer,
      AgentMessageType.taskListState: _taskListMessageRenderer,
      AgentMessageType.agentActivity: _agentActivityMessageRenderer,
      AgentMessageType.historyReset: _historyResetMessageRenderer,
      AgentMessageType.error: _errorMessageRenderer,
    };

/// Builds a renderer for one [AgentMessage].
Widget buildAgentMessageRenderer(
  BuildContext context,
  AgentMessage message, {
  Widget? fileArtifactAction,
  Widget? requestAction,
}) {
  if (message.type == AgentMessageType.fileArtifact) {
    return _fileArtifactMessageRenderer(
      context,
      message,
      action: fileArtifactAction,
    );
  }
  if (message.type == AgentMessageType.permissionRequest) {
    return _permissionRequestMessageRenderer(
      context,
      message,
      action: requestAction,
    );
  }
  if (message.type == AgentMessageType.questionRequest) {
    return _questionRequestMessageRenderer(
      context,
      message,
      action: requestAction,
    );
  }
  return (agentMessageRendererRegistry[message.type] ??
      _unknownMessageRenderer)(
    context,
    message,
  );
}

/// Renders [source] as markdown blocks, for a host outside the transcript.
///
/// The file viewer's Rendered mode is this same block set at file scale. A
/// second markdown implementation would drift from the transcript's within a
/// release, and the two would disagree about the same file.
Widget buildTranscriptMarkdownBody(String source) =>
    _MarkdownBody(source: source);

/// Supplies the device-global D9 policy to type-driven message renderers.
class ToolDisplayModeScope extends InheritedWidget {
  /// Creates a scope for one transcript subtree.
  const ToolDisplayModeScope({
    required this.mode,
    required super.child,
    this.toolsExpanded,
    this.expansionRevision = 0,
    super.key,
  });

  /// Active global display policy.
  final ToolDisplayMode mode;

  /// Transcript-local override used by Collapse all / Expand all.
  final bool? toolsExpanded;

  /// Rebuild generation for stateful expansion surfaces.
  final int expansionRevision;

  /// Reads the active mode, defaulting to [ToolDisplayMode.responsive].
  static ToolDisplayMode of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<ToolDisplayModeScope>()
          ?.mode ??
      ToolDisplayMode.responsive;

  /// Reads the nearest transcript-local expansion override.
  static bool? toolsExpandedOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<ToolDisplayModeScope>()
      ?.toolsExpanded;

  /// Reads the current expansion generation.
  static int expansionRevisionOf(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<ToolDisplayModeScope>()
          ?.expansionRevision ??
      0;

  @override
  bool updateShouldNotify(ToolDisplayModeScope oldWidget) =>
      oldWidget.mode != mode ||
      oldWidget.toolsExpanded != toolsExpanded ||
      oldWidget.expansionRevision != expansionRevision;
}

/// Supplies broker completion time to a transcript renderer header.
class TranscriptMessageMetadataScope extends InheritedWidget {
  /// Creates metadata for one message renderer subtree.
  const TranscriptMessageMetadataScope({
    required this.timestamp,
    required super.child,
    super.key,
  });

  /// Broker timestamp in epoch milliseconds.
  final int? timestamp;

  /// Reads the current message timestamp.
  static int? timestampOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<TranscriptMessageMetadataScope>()
      ?.timestamp;

  @override
  bool updateShouldNotify(TranscriptMessageMetadataScope oldWidget) =>
      oldWidget.timestamp != timestamp;
}

/// Builds one normalized call/result tool card.
Widget buildToolTranscriptRenderer(
  BuildContext context,
  ToolTranscriptDisplayEntry entry, {
  bool? toolsExpanded,
  int? expansionRevision,
}) {
  final revision =
      expansionRevision ?? ToolDisplayModeScope.expansionRevisionOf(context);
  return _ToolMessageCard(
    key: ValueKey(
      'tool-message-${entry.callId ?? identityHashCode(entry.primaryMessage)}-'
      '$revision',
    ),
    call: entry.call,
    result: entry.result,
    initiallyExpanded:
        toolsExpanded ?? ToolDisplayModeScope.toolsExpandedOf(context) ?? false,
  );
}

/// Builds the clean right-aligned user bubble used inside a conversation turn.
///
/// No author icon or `User message` header: right alignment carries authorship.
/// A queued prompt renders dimmed with a localized badge.
///
/// [attachments] are the file artifacts sent with this prompt; they render
/// inside the bubble. [attachmentActionBuilder] supplies each one's existing
/// download/open control, so the transcript keeps the controller out of the
/// renderer library.
Widget buildConversationUserBubble(
  BuildContext context,
  AgentMessage message, {
  List<AgentMessage> attachments = const [],
  Widget? Function(AgentMessage attachment)? attachmentActionBuilder,
}) => _ConversationUserBubble(
  message: message,
  attachments: attachments,
  attachmentActionBuilder: attachmentActionBuilder,
);

/// Builds the continuous left-aligned model-output surface for a turn.
///
/// Renders Markdown as one clean surface with no enclosing card, robot icon, or
/// `Model output` header.
Widget buildConversationModelOutput(
  BuildContext context,
  AgentMessage message,
) => _ConversationModelOutput(message: message);

/// Builds the quiet expandable thinking row used inside a conversation turn.
Widget buildConversationThinkingRow(
  BuildContext context,
  AgentMessage message,
) => _ConversationThinkingRow(message: message);

/// Builds one collapsed group for two or more consecutive lookups.
Widget buildLookupGroupRenderer(
  BuildContext context,
  LookupGroupTranscriptDisplayEntry entry, {
  bool? toolsExpanded,
  int? expansionRevision,
}) {
  return _LookupToolGroup(
    tools: entry.tools,
    toolsExpanded:
        toolsExpanded ?? ToolDisplayModeScope.toolsExpandedOf(context) ?? false,
    expansionRevision:
        expansionRevision ?? ToolDisplayModeScope.expansionRevisionOf(context),
  );
}
