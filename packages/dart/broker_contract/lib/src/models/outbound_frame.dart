// The named constructors narrow nullable wire fields to non-null inputs.
// ignore_for_file: prefer_initializing_formals

import 'package:broker_contract/src/models/policy_token.dart';
import 'package:broker_contract/src/models/session_info.dart';

/// Maximum files attached to one prompt and retained in one composer.
const int promptAttachmentMaxFiles = 8;

/// Maximum decoded bytes for one file and one attachment prompt/client state.
const int promptAttachmentMaxFileBytes = 64 * 1024 * 1024;
const int promptAttachmentMaxPromptBytes = 64 * 1024 * 1024;

/// Inline files above this size use broker-owned chunked staging.
const int promptAttachmentInlineFileMaxBytes = 256 * 1024;

/// Aggregate inline payload bounds before WebSocket framing.
const int promptAttachmentInlineDecodedMaxBytes = 1024 * 1024;
const int promptAttachmentInlineEncodedMaxBytes = 1536 * 1024;

/// One inline or broker-staged file entry in a prompt frame.
final class PromptFileAttachment {
  /// Creates an inline attachment.
  const PromptFileAttachment.inline({
    required this.name,
    required this.mimeType,
    required this.size,
    required String data,
  }) : data = data,
       stagedRef = null;

  /// Creates an opaque staged-reference attachment.
  const PromptFileAttachment.staged({
    required this.name,
    required this.mimeType,
    required this.size,
    required String stagedRef,
  }) : data = null,
       stagedRef = stagedRef;

  /// Filename shown to the user; the broker sanitizes it before materializing.
  final String name;

  /// MIME type reported by the picker/staging response.
  final String mimeType;

  /// Exact decoded byte size.
  final int size;

  /// Canonical base64 inline bytes.
  final String? data;

  /// Opaque broker-issued staged reference.
  final String? stagedRef;

  /// Whether this entry has exactly one valid transport source.
  bool get isValid =>
      name.trim().isNotEmpty &&
      size >= 0 &&
      ((data != null && stagedRef == null) ||
          (data == null && stagedRef != null && stagedRef!.isNotEmpty));

  /// Encodes the bounded prompt-file wire entry.
  Map<String, dynamic> toJson() {
    if (!isValid) {
      throw const FormatException('Malformed prompt attachment.');
    }
    return {
      'name': name,
      'mimeType': mimeType,
      'size': size,
      if (data != null) 'data': data,
      if (stagedRef != null) 'stagedRef': stagedRef,
    };
  }
}

/// Semantic plan lifecycle action understood by the broker.
enum PlanActionKind {
  /// Accept the current plan.
  approve('approve'),

  /// Submit a revised plan instruction.
  edit('edit'),

  /// Leave planning mode.
  exit('exit');

  const PlanActionKind(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a broker wire value.
  static PlanActionKind fromWire(Object? value) => switch (value) {
    'approve' => PlanActionKind.approve,
    'edit' => PlanActionKind.edit,
    'exit' => PlanActionKind.exit,
    _ => throw FormatException('Unknown plan action: $value'),
  };
}

/// One typed item echoed with a semantic plan action.
final class PlanActionItem {
  /// Creates a plan item.
  const PlanActionItem({
    required this.title,
    required this.status,
    this.id,
    this.detail,
  });

  /// Decodes a persisted plan item.
  factory PlanActionItem.fromJson(Map<String, dynamic> json) {
    final title = json['title'];
    final status = json['status'];
    if (title is! String || title.trim().isEmpty || status is! String) {
      throw const FormatException('Malformed plan action item.');
    }
    return PlanActionItem(
      id: json['id'] as String?,
      title: title.trim(),
      status: status,
      detail: json['detail'] as String?,
    );
  }

  /// Optional native item identity.
  final String? id;

  /// User-visible plan item title.
  final String title;

  /// Canonical task item status.
  final String status;

  /// Optional task detail.
  final String? detail;

  /// Encodes the item for the broker.
  Map<String, dynamic> toJson() => {
    if (id != null) 'id': id,
    'title': title,
    'status': status,
    if (detail != null) 'detail': detail,
  };
}

/// Typed payload for a broker `plan-action` client frame.
final class PlanActionRequest {
  /// Creates a semantic plan action.
  const PlanActionRequest({
    required this.action,
    required this.planKey,
    required this.planRevision,
    this.title = '',
    this.items = const [],
    this.text,
    this.model,
    this.agent,
    this.permissionMode,
  });

  /// Decodes a persisted plan action payload.
  factory PlanActionRequest.fromJson(Map<String, dynamic> json) {
    final planKey = json['planKey'];
    final planRevision =
        (json['planRevision'] as String?) ?? (json['revision'] as String?);
    final title = json['title'];
    final rawItems = json['items'];
    if (planKey is! String || planRevision == null) {
      throw const FormatException('Malformed plan action payload.');
    }
    final request = PlanActionRequest(
      action: PlanActionKind.fromWire(json['action']),
      planKey: planKey,
      planRevision: planRevision,
      title: title is String ? title : '',
      items: (rawItems is List ? rawItems : const <Object?>[])
          .whereType<Map<Object?, Object?>>()
          .map(
            (item) => PlanActionItem.fromJson(
              Map<String, dynamic>.from(item),
            ),
          )
          .toList(growable: false),
      text: json['text'] as String?,
      model: switch (json['model']) {
        final Map<Object?, Object?> value => SessionCurrentModel.fromJson(
          Map<String, dynamic>.from(value),
        ),
        _ => null,
      },
      agent: json['agent'] as String?,
      permissionMode: json['permissionMode'] as String?,
    );
    if (!request.isValidBrokerRequest) {
      throw const FormatException('Malformed plan action payload.');
    }
    return request;
  }

  /// Requested lifecycle action.
  final PlanActionKind action;

  /// Stable canonical task-list key.
  final String planKey;

  /// Opaque revision advertised by the current typed plan marker.
  final String planRevision;

  /// User-facing plan title.
  final String title;

  /// Current structured plan items.
  final List<PlanActionItem> items;

  /// Revision instruction for [PlanActionKind.edit].
  final String? text;

  /// Optional exact broker model override.
  final SessionCurrentModel? model;

  /// Optional broker agent/mode selection.
  final String? agent;

  /// Optional broker permission mode.
  final String? permissionMode;

  /// Whether this request matches the broker's bounded authority shape.
  bool get isValidBrokerRequest {
    if (!isShortPolicyToken(planKey) || !isShortPolicyToken(planRevision)) {
      return false;
    }
    return switch (action) {
      PlanActionKind.edit =>
        text != null && text!.trim().isNotEmpty && text!.length <= 20000,
      PlanActionKind.approve || PlanActionKind.exit => text == null,
    };
  }

  /// Encodes the action payload without the frame kind or idempotency key.
  Map<String, dynamic> toJson() => {
    'action': action.wireValue,
    'planKey': planKey,
    'planRevision': planRevision,
    if (text != null) 'text': text,
    if (model != null) 'model': model!.toJson(),
    if (agent != null) 'agent': agent,
    if (permissionMode != null) 'permissionMode': permissionMode,
  };
}

/// Typed payload forwarded from a broker-sandboxed interactive artifact.
final class ArtifactInteractionRequest {
  /// Creates an artifact interaction.
  const ArtifactInteractionRequest({
    required this.artifactKey,
    required this.interaction,
    this.interactionRef = '',
    this.name,
    this.path,
    this.model,
    this.agent,
    this.permissionMode,
  });

  /// Decodes a persisted artifact interaction payload.
  factory ArtifactInteractionRequest.fromJson(Map<String, dynamic> json) {
    final artifactKey = json['artifactKey'];
    final interaction = json['interaction'];
    if (artifactKey is! String ||
        artifactKey.trim().isEmpty ||
        interaction is! Map<Object?, Object?>) {
      throw const FormatException('Malformed artifact interaction payload.');
    }
    return ArtifactInteractionRequest(
      artifactKey: artifactKey.trim(),
      interactionRef: json['interactionRef'] as String? ?? '',
      name: json['name'] as String?,
      path: json['path'] as String?,
      interaction: Map<String, dynamic>.from(interaction),
      model: switch (json['model']) {
        final Map<Object?, Object?> value => SessionCurrentModel.fromJson(
          Map<String, dynamic>.from(value),
        ),
        _ => null,
      },
      agent: json['agent'] as String?,
      permissionMode: json['permissionMode'] as String?,
    );
  }

  /// Broker-issued artifact identity.
  final String artifactKey;

  /// Broker-signed, session/content/policy-bound interaction reference.
  final String interactionRef;

  /// Optional user-visible artifact name.
  final String? name;

  /// Optional original artifact path.
  final String? path;

  /// Structured, sandbox-originated interaction data.
  final Map<String, dynamic> interaction;

  /// Optional exact broker model override.
  final SessionCurrentModel? model;

  /// Optional broker agent/mode selection.
  final String? agent;

  /// Optional broker permission mode.
  final String? permissionMode;

  /// Encodes the interaction without the frame kind or idempotency key.
  Map<String, dynamic> toJson() => {
    'artifactKey': artifactKey,
    'interactionRef': interactionRef,
    'interaction': interaction,
  };
}

/// Outbound WebSocket frames the client sends to the broker.
///
/// Each static method returns a JSON-encodable map matching the broker's
/// expected wire format. The client serializes to JSON in one place rather
/// than scattering frame construction across UI code.
///
/// See `docs/architecture/monorepo.md` and
/// `docs/protocol/contract-sync.md`.
abstract final class OutboundFrame {
  /// A user prompt message.
  ///
  /// The broker serializes prompts per-socket and spaces them ≥350ms.
  /// The broker reads `msg.text` (not `content`).
  ///
  /// [draftRevision] is the shared draft revision this device had adopted when
  /// it sent. Accepting a prompt clears the shared draft, and without this the
  /// broker would clear it unconditionally — erasing a newer draft another
  /// device typed that this prompt never contained. A versioned client always
  /// sends it (0 = "this device holds no shared draft"); it is omitted for a
  /// legacy (pre-revision-3) broker, which keeps the unconditional clear.
  ///
  /// [draftUpdateId] is the idempotency token of a draft write this device has
  /// sent but not yet seen acknowledged. Both frames share one socket, so the
  /// broker applies that draft first and [draftRevision] is already stale by
  /// the time the prompt is read — yet the shared draft it advanced to is this
  /// prompt's own text. The token lets the broker recognize that and still
  /// clear, instead of leaving the sent prompt behind as an unsent draft.
  ///
  /// [permissionMode] is a per-prompt approval mode and must be one of the
  /// exact tokens this session advertised through `listModes`; the broker
  /// rejects anything else rather than guessing at it. Omitting it means "use
  /// whatever mode the session is already in", which is NOT the same as
  /// re-asserting the current one — a re-assertion would override a mode the
  /// server changed underneath, which this prompt never asked to do.
  static Map<String, dynamic> prompt(
    String text, {
    SessionCurrentModel? model,
    List<PromptFileAttachment> files = const [],
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    String? permissionMode,
  }) {
    if (files.length > promptAttachmentMaxFiles) {
      throw RangeError.range(
        files.length,
        0,
        promptAttachmentMaxFiles,
        'files.length',
      );
    }
    final totalBytes = files.fold<int>(0, (sum, file) => sum + file.size);
    if (files.any((file) => file.size > promptAttachmentMaxFileBytes) ||
        totalBytes > promptAttachmentMaxPromptBytes) {
      throw RangeError('Prompt attachment bytes exceed the client limit.');
    }
    return {
      'kind': 'prompt',
      'text': text,
      if (files.isNotEmpty)
        'files': files.map((file) => file.toJson()).toList(),
      if (model != null) 'model': _modelOverride(model),
      if (permissionMode != null && permissionMode.isNotEmpty)
        'permissionMode': permissionMode,
      if (clientMessageId != null) 'clientMessageId': clientMessageId,
      if (draftRevision != null) 'draftRevision': draftRevision,
      if (draftUpdateId != null) 'draftUpdateId': draftUpdateId,
    };
  }

  /// Replaces the shared unsent composer draft for this session.
  ///
  /// Drafts are relay state, not agent input, so they deliberately stay
  /// outside the client-message idempotency journal. DR1 versioning instead
  /// rides two dedicated fields: [updateId] makes a reconnect retry of the
  /// same edit idempotent on the broker, and [baseRevision] is the last
  /// broker draft revision the writer observed — a write based on an older
  /// revision is rejected rather than silently overwriting a newer shared
  /// draft. Both are omitted for a legacy (pre-revision-3) broker.
  static Map<String, dynamic> draft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) => {
    'kind': 'draft',
    'text': text,
    if (updateId != null) 'updateId': updateId,
    if (baseRevision != null) 'baseRevision': baseRevision,
  };

  /// Requests one chronological page before the current attach tail/page.
  static Map<String, dynamic> historyPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) {
    if (limit != null && (limit < 1 || limit > 500)) {
      throw RangeError.range(limit, 1, 500, 'limit');
    }
    return {
      'kind': 'history-page',
      'cursor': cursor,
      if (limit != null) 'limit': limit,
      if (clientMessageId != null) 'clientMessageId': clientMessageId,
    };
  }

  /// A semantic plan approve/revise/exit action.
  static Map<String, dynamic> planAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) {
    if (!request.isValidBrokerRequest) {
      throw ArgumentError.value(
        request,
        'request',
        'Plan identity/action payload does not match broker policy.',
      );
    }
    return {
      'kind': 'plan-action',
      ...request.toJson(),
      if (clientMessageId != null) 'clientMessageId': clientMessageId,
    };
  }

  /// A structured interaction from a broker-sandboxed HTML artifact.
  static Map<String, dynamic> artifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) => {
    'kind': 'artifact-interaction',
    ...request.toJson(),
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// A slash command.
  ///
  /// [args] is optional command arguments (model, agent, permissionMode).
  static Map<String, dynamic> command(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) {
    if (model != null && (args?.containsKey('model') ?? false)) {
      throw ArgumentError.value(
        args,
        'args',
        'Command args cannot contain "model" when a typed model override is '
            'also provided.',
      );
    }
    return {
      'kind': 'command',
      'name': name,
      if (args != null) ...args,
      if (model != null) 'model': _modelOverride(model),
      if (clientMessageId != null) 'clientMessageId': clientMessageId,
    };
  }

  /// Switch the session's active agent/mode (e.g. opencode build/plan) for
  /// subsequent turns, without starting a turn.
  ///
  /// [agent] must be a name the broker advertised in the `options` frame's
  /// `agents` list; the broker rejects anything else (`AGENT_UNSUPPORTED`).
  static Map<String, dynamic> setAgent(
    String agent, {
    String? clientMessageId,
  }) => {
    'kind': 'set-agent',
    'agent': agent,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// Requests terminal handoff from the current Drive socket.
  ///
  /// The broker refuses while any peer driver remains and otherwise migrates
  /// this socket to Observe before closing the shared Resume owner.
  static Map<String, dynamic> handoff({required String clientMessageId}) => {
    'kind': 'handoff',
    'clientMessageId': clientMessageId,
  };

  /// Approve or reject a permission request.
  ///
  /// [decision] is typically `'approve'` or `'reject'`.
  static Map<String, dynamic> approve(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) => {
    'kind': 'approve',
    'requestId': requestId,
    'decision': decision,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// Answer a question from the agent.
  ///
  /// [answers] is `string[][]` per the broker/core contract:
  /// one list of strings per question in the request.
  static Map<String, dynamic> answer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) => {
    'kind': 'answer',
    'requestId': requestId,
    'answers': answers,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// Dismiss/reject a question from the agent.
  static Map<String, dynamic> rejectQuestion(
    String requestId, {
    String? clientMessageId,
  }) => {
    'kind': 'reject-question',
    'requestId': requestId,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// Upload a file to the session.
  ///
  /// The broker reads `msg.data` (not `content`).
  static Map<String, dynamic> file({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) => {
    'kind': 'file',
    'name': name,
    'data': data,
    if (mimeType != null) 'mimeType': mimeType,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// Acknowledge delivery of an attach ticket back to the broker.
  ///
  /// The broker issued [attachTicket] in the `history` wire event; the client
  /// acks it for delivery bookkeeping. [clientMessageId] optionally correlates
  /// the receipt with a mutating client message. The broker responds with an
  /// `ack` wire event (`ack: 'ack'`).
  static Map<String, dynamic> ack({
    String? attachTicket,
    String? clientMessageId,
  }) => {
    'kind': 'ack',
    if (attachTicket != null) 'attachTicket': attachTicket,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  /// Negatively acknowledge an attach ticket back to the broker.
  ///
  /// The client nacks an [attachTicket] it could not process (for example, a
  /// history gap it cannot reconcile). The broker responds with an `ack` wire
  /// event (`ack: 'nack'`), or a `nack` wire event with code
  /// `ACK_UNKNOWN_TARGET` if the ticket is unknown.
  static Map<String, dynamic> nack({
    String? attachTicket,
    String? clientMessageId,
  }) => {
    'kind': 'nack',
    if (attachTicket != null) 'attachTicket': attachTicket,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
  };

  static Map<String, dynamic> _modelOverride(SessionCurrentModel model) => {
    'providerID': model.providerID,
    'modelID': model.modelID,
    if (model.reasoningEffort != null) 'reasoningEffort': model.reasoningEffort,
    if (model.variant != null) 'variant': model.variant,
  };
}
