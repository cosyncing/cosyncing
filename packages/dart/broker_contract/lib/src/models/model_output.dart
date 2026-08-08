import 'package:broker_contract/src/models/agent_message.dart';

/// Typed, tolerant accessors for the broker `model-output` message fields.
///
/// The broker `model-output` wire shape is:
/// `{ type: 'model-output'; text?: string; delta?: string;`
/// `final?: boolean; key?: string }`.
/// All four fields are optional. These accessors read the real fields
/// tolerantly - missing or wrong-typed values never throw - and expose the
/// contract-driven finality predicate shared by the transcript renderer and
/// the voice feature so there is one definition of "finished and speakable".
///
/// Completion is contract-driven only: the client must never infer finality
/// from an idle timer, connection state, or a pause in incoming events.
/// Finality is the broker's `final: true` field and nothing else. The field is
/// optional on the wire, so a `model-output` turn that never carries
/// `final: true` is simply not speakable.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Contract dependency").
extension AgentMessageModelOutput on AgentMessage {
  /// The complete turn text from a terminal `model-output` frame, or `null`
  /// when absent or not a string.
  ///
  /// The terminal frame carries the complete turn text in `text`; the client
  /// never accumulates `delta` chunks to read a message aloud. Missing `text`
  /// means "not speakable".
  String? get modelOutputText => _asString(raw['text']);

  /// The incremental streaming delta, or `null` when absent or not a string.
  String? get modelOutputDelta => _asString(raw['delta']);

  /// The stable turn-correlation key, or `null` when absent or not a string.
  String? get modelOutputKey => _asString(raw['key']);

  /// Whether this frame carries `final: true`.
  ///
  /// Missing or non-bool `final` is treated as "not final"; the client never
  /// guesses completion from a missing field.
  bool get modelOutputFinal {
    final value = raw['final'];
    return value is bool && value;
  }

  /// Whether this is a `model-output` frame marked `final: true`.
  bool get isFinalModelOutput =>
      type == AgentMessageType.modelOutput && modelOutputFinal;

  /// The speakable source text for read-aloud, or `null` when the frame is not
  /// a final `model-output` with non-empty `text`.
  ///
  /// Eligibility requires `type == modelOutput`, `final == true`, and
  /// non-empty `text`. It is evaluated per frame on `final == true`, not on a
  /// coalesced "turn" object, and never infers completion from timers or
  /// connection state.
  String? get readAloudSourceText {
    if (!isFinalModelOutput) {
      return null;
    }
    final text = modelOutputText;
    if (text == null || text.trim().isEmpty) {
      return null;
    }
    return text;
  }

  /// Whether this frame is eligible for read-aloud.
  bool get isReadAloudEligible => readAloudSourceText != null;
}

String? _asString(Object? value) => value is String ? value : null;
