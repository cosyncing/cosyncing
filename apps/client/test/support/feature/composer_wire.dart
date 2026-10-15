// The broker side of the composer (F04): how a session answers a prompt, a
// draft write and an attach, so the App's real send, outbox and shared-draft
// code runs against frames a real broker would emit.
//
// Rules mirrored from the broker (`hub.ts`, `draft-store.ts`):
//  - a draft write is versioned: `applied` is fanned out to every attached
//    client (the writer included, recognised by `updateId`), a repeated
//    `updateId` is answered to the writer only, and a write whose
//    `baseRevision` is behind the record with different text is `stale-base`
//    (answered to the writer with the current record, nothing broadcast);
//  - an accepted prompt is acknowledged by `clientMessageId`, echoed as a
//    `user-message` row carrying the id as `clientKey`, and clears the shared
//    draft it was written from (not a newer one);
//  - a late attach is replayed the current draft, a clear tombstone included.
import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';

import 'fake_broker.dart';
import 'transcript_wire.dart';

/// [frame] as it is on the wire: nested model objects become plain JSON.
Map<String, Object?> _wire(Map<String, Object?> frame) =>
    (jsonDecode(jsonEncode(frame)) as Map).cast<String, Object?>();

/// What the broker does with a prompt.
enum PromptAnswer {
  /// Acknowledge, echo the row and clear the shared draft.
  accept,

  /// Say nothing: the prompt is on the wire, the outcome unknown.
  hold,

  /// Refuse it (`nack`) with [ComposerDesk.refusal].
  refuse,
}

/// One session's composer-facing broker behaviour.
class ComposerDesk {
  /// Serves session [id] of [broker]; installs itself as the broker's attach
  /// policy and frame handler.
  ComposerDesk(
    this.broker, {
    this.id = 's1',
    this.tool = 'codex',
    this.versionedDrafts = true,
  }) {
    broker
      ..attachFrames = _attach
      ..onFrame = _onFrame;
  }

  /// The broker.
  final FakeBroker broker;

  /// Session id.
  final String id;

  /// Session tool.
  final String tool;

  /// Whether the broker speaks versioned drafts (revision 3+). A legacy
  /// broker keeps last-writer-wins and never sends a revision.
  final bool versionedDrafts;

  /// How the next prompts are answered.
  PromptAnswer answer = PromptAnswer.accept;

  /// Code and message a refused prompt carries.
  ({String code, String message}) refusal = (
    code: 'PROMPT_REFUSED',
    message: 'The agent refused this prompt.',
  );

  /// Echo accepted prompts as a `user-message` row.
  bool echo = true;

  /// When false the broker never answers a draft write (a dead relay).
  bool relayDrafts = true;

  /// Broker-side shared draft.
  String draftText = '';

  /// Revision of [draftText] (0 before any write).
  int draftRevision = 0;

  /// When true, the broker applies draft writes but its fan-out (the echo to
  /// the writer included) waits in [heldDraftFrames] until
  /// [releaseDraftFrames].
  bool holdDraftFrames = false;

  /// Draft frames waiting for [releaseDraftFrames].
  final List<Map<String, Object?>> heldDraftFrames = [];

  /// Delivers the held draft frames in order.
  void releaseDraftFrames() {
    holdDraftFrames = false;
    final frames = List.of(heldDraftFrames);
    heldDraftFrames.clear();
    for (final frame in frames) {
      for (final peer in _live) {
        peer.emit(frame);
      }
    }
  }

  void _fanOut() {
    final frame = _draftFrame;
    if (holdDraftFrames) {
      heldDraftFrames.add(frame);
      return;
    }
    for (final peer in _live) {
      peer.emit(frame);
    }
  }

  /// Update id of the last applied write.
  String? draftUpdateId;

  /// Prompt frames received, oldest first.
  final List<Map<String, dynamic>> prompts = [];

  /// Draft frames received, oldest first.
  final List<Map<String, dynamic>> drafts = [];

  /// Every other frame the app sent (commands, interrupts), oldest first.
  final List<Map<String, dynamic>> others = [];

  /// The control block of the session (null: Driving).
  Map<String, Object?>? get control => broker.controls[id];

  /// Fields merged into the session frame (`currentModel`, `currentMode`, ...).
  Map<String, Object?> sessionExtras = {};

  /// The session's run status the next frames report.
  String status = 'idle';

  /// Models the session offers (an `options` frame), when set.
  List<ModelOption>? models;

  /// Permission modes the session offers, when set.
  List<ModeOption>? modes;

  /// Agent modes the session offers (`options.agents`).
  List<AgentOption> agentOptions = const [];

  /// Slash commands the session advertises (a `commands` frame), when set.
  List<SlashCommand>? commands;

  var _seq = 0;
  var _attaches = 0;
  var _clock = 1000;

  /// Number of attaches served.
  int get attaches => _attaches;

  Map<String, Object?> get _draftFrame => {
    'kind': 'draft',
    'text': draftText,
    'at': ++_clock,
    if (versionedDrafts) 'revision': draftRevision,
    if (versionedDrafts && draftUpdateId != null) 'updateId': draftUpdateId,
  };

  List<Map<String, Object?>> _attach(
    FakeBrokerSocket socket,
    Map<String, Object?> session,
  ) {
    _attaches += 1;
    return [
      broker.helloFrame(),
      sessionFrame(session),
      if (commands != null) _wire({'kind': 'commands', 'commands': commands}),
      if (models != null || modes != null)
        _wire({
          'kind': 'options',
          'models': models ?? const <ModelOption>[],
          'agents': agentOptions,
          if (modes != null) 'modes': modes,
        }),
      {
        'kind': 'history',
        'messages': broker.transcripts[session['id']] ?? const <Object?>[],
        'cursor': 'cursor-$_attaches',
      },
      // A tombstone (empty text, revision > 0) is replayed to versioned
      // clients only; a legacy broker replays a non-empty draft.
      if (draftText.isNotEmpty || (versionedDrafts && draftRevision > 0))
        _draftFrame,
    ];
  }

  /// The `session` frame as the broker publishes it now.
  Map<String, Object?> sessionFrame([Map<String, Object?>? row]) {
    final session = row ?? broker.sessions.firstWhere((s) => s['id'] == id);
    return {
      'kind': 'session',
      'info': {
        ...session,
        'status': status,
        'control': broker.controls[id] ?? FakeBroker.drivingControl,
        ...sessionExtras,
      },
    };
  }

  /// The session advertises [next] commands from now on and tells every
  /// attached client.
  void advertise(List<SlashCommand> next) {
    commands = next;
    for (final peer in _live) {
      peer.emit(_wire({'kind': 'commands', 'commands': next}));
    }
  }

  /// A prompt id that was acknowledged: a replay of it is a duplicate.
  final Set<String> acknowledged = {};

  /// The session changes run status (or control, via [FakeBroker.controls]);
  /// every attached client is told.
  void publishSession({String? status}) {
    if (status != null) this.status = status;
    for (final peer in _live) {
      peer.emit(sessionFrame());
    }
  }

  Iterable<FakeBrokerSocket> get _live => [
    for (final socket in broker.socketsFor(id))
      if (socket.isConnected) socket,
  ];

  void _onFrame(FakeBrokerSocket socket, Map<String, dynamic> frame) {
    switch (frame['kind']) {
      case 'prompt':
        prompts.add(frame);
        _answerPrompt(socket, frame);
      case 'draft':
        drafts.add(frame);
        if (relayDrafts) _applyDraft(socket, frame);
      default:
        others.add(frame);
    }
  }

  void _answerPrompt(FakeBrokerSocket socket, Map<String, dynamic> frame) {
    final clientMessageId = frame['clientMessageId'] as String?;
    switch (answer) {
      case PromptAnswer.hold:
        return;
      case PromptAnswer.refuse:
        socket.emit({
          'kind': 'nack',
          'clientMessageId': clientMessageId,
          'code': refusal.code,
          'message': refusal.message,
        });
        return;
      case PromptAnswer.accept:
        break;
    }
    acceptPrompt(socket, frame);
  }

  /// Accepts a prompt frame: clear the draft it carried, acknowledge, echo.
  void acceptPrompt(FakeBrokerSocket socket, Map<String, dynamic> frame) {
    final clientMessageId = frame['clientMessageId'] as String?;
    final carried = (frame['draftRevision'] as num?)?.toInt();
    final updateId = frame['draftUpdateId'] as String?;
    // Clear only the draft the sender was looking at (or owns by token).
    final clears =
        draftText.isNotEmpty &&
        (!versionedDrafts ||
            carried == null ||
            carried >= draftRevision ||
            (updateId != null && updateId == draftUpdateId) ||
            draftText == frame['text']);
    if (clears) {
      draftText = '';
      draftRevision += 1;
      draftUpdateId = null;
      _fanOut();
    }
    if (clientMessageId != null && !acknowledged.add(clientMessageId)) {
      // The broker already ran this id: answer from its journal.
      socket.emit({
        'kind': 'ack',
        'ack': 'client-message',
        'clientMessageId': clientMessageId,
        'duplicate': true,
        if (versionedDrafts) 'draftRevision': draftRevision,
      });
      return;
    }
    socket.emit({
      'kind': 'ack',
      'ack': 'client-message',
      'clientMessageId': clientMessageId,
      if (versionedDrafts) 'draftRevision': draftRevision,
    });
    if (echo) {
      echoPrompt(frame['text'] as String, clientKey: clientMessageId);
    }
  }

  /// Refuses [prompt] now (a prompt that was [answer]ed with `hold`).
  void refuse(Map<String, dynamic> prompt) {
    _live.last.emit({
      'kind': 'nack',
      'clientMessageId': prompt['clientMessageId'],
      'code': refusal.code,
      'message': refusal.message,
    });
  }

  /// The broker streams a `user-message` row to every attached client.
  void echoPrompt(String text, {String? clientKey, String? key}) {
    final message = userRow(
      text,
      key: key ?? 'native-${_seq + 1}',
      queued: status == 'working',
      extra: {'clientKey': ?clientKey},
    );
    final seq = ++_seq;
    for (final peer in _live) {
      peer.emit({'kind': 'message', 'seq': seq, 'message': message});
    }
  }

  void _applyDraft(FakeBrokerSocket socket, Map<String, dynamic> frame) {
    final text = (frame['text'] as String?) ?? '';
    final updateId = frame['updateId'] as String?;
    final base = (frame['baseRevision'] as num?)?.toInt();
    if (!versionedDrafts) {
      draftText = text;
      draftRevision += 1;
      _fanOut();
      return;
    }
    if (updateId != null && updateId == draftUpdateId) {
      socket.emit(_draftFrame);
      return;
    }
    if (base != null && base < draftRevision && text != draftText) {
      socket.emit(_draftFrame);
      return;
    }
    draftText = text;
    draftRevision += 1;
    draftUpdateId = updateId;
    _fanOut();
  }

  /// Another client of the session (a terminal, another device) writes the
  /// shared draft: fanned out to every attached client.
  void writeFromElsewhere(String text) {
    draftText = text;
    draftRevision += 1;
    draftUpdateId = 'elsewhere-$draftRevision';
    _fanOut();
  }

  /// The prompt frames received, as `text` values.
  List<String> get promptTexts => [
    for (final frame in prompts) frame['text']! as String,
  ];

  /// Acknowledges (and echoes) a prompt that was [answer]ed with `hold`.
  void release(Map<String, dynamic> prompt) {
    final socket = _live.last;
    acceptPrompt(socket, prompt);
  }

  /// Every frame of kind [kind] the app sent, whatever the socket.
  List<Map<String, dynamic>> framesOfKind(String kind) => [
    for (final socket in broker.socketsFor(id))
      for (final frame in socket.sent)
        if (frame['kind'] == kind) frame,
  ];

  /// JSON of the frame, for failure messages.
  static String show(Object? frame) => jsonEncode(frame);
}
