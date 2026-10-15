// Permission and question cards for F06 feature tests: the rows the broker
// streams, and the verbs and finders over the cards the app draws from them.
//
// Rows are plain JSON in the broker's canonical shape; the app decodes and
// draws them exactly as it does for a real broker. Nothing here is the
// client's own model.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'fake_broker.dart';

/// A permission request row. [idKey] is the field carrying [id] (some
/// adapters send `permissionId`).
Map<String, Object?> permissionRequest(
  String id, {
  String idKey = 'requestId',
  String? title,
  String? permission,
  String? reason,
  String? operation,
  String? target,
  String? detail,
  String? inputPreview,
  String? toolName,
  List<String>? options,
  bool? readOnly,
  bool? blocking,
  String? releaseReason,
  String? permissionMode,
}) => {
  'type': 'permission-request',
  idKey: id,
  'title': ?title,
  'permission': ?permission,
  'reason': ?reason,
  'operation': ?operation,
  'target': ?target,
  'detail': ?detail,
  'inputPreview': ?inputPreview,
  'toolName': ?toolName,
  'options': ?options,
  'readOnly': ?readOnly,
  'blocking': ?blocking,
  'releaseReason': ?releaseReason,
  'permissionMode': ?permissionMode,
};

/// A permission resolution. [decidedBy] names the seat (`band` is the
/// terminal, `app` this app, `expired` a deadline).
Map<String, Object?> permissionResolved(
  String id, {
  String? decision,
  String? decidedBy,
  String? releaseReason,
}) => {
  'type': 'permission-resolved',
  'requestId': id,
  'decision': ?decision,
  'decidedBy': ?decidedBy,
  'releaseReason': ?releaseReason,
};

/// One question of a question request.
Map<String, Object?> askQuestion(
  String question, {
  String? header,
  List<Object>? options,
  bool? multiple,
  bool? freeText,
  String? kind,
  num? min,
  num? max,
  num? step,
  String? unit,
}) => {
  'question': question,
  'header': ?header,
  'options': ?options,
  'multiple': ?multiple,
  'freeText': ?freeText,
  'kind': ?kind,
  'min': ?min,
  'max': ?max,
  'step': ?step,
  'unit': ?unit,
};

/// A question request row.
Map<String, Object?> questionRequest(
  String id,
  List<Map<String, Object?>> questions, {
  bool? readOnly,
  bool? blocking,
  bool? answerInTerminal,
}) => {
  'type': 'question-request',
  'requestId': id,
  'questions': questions,
  'readOnly': ?readOnly,
  'blocking': ?blocking,
  'answerInTerminal': ?answerInTerminal,
};

/// A question resolution, with the answers it closed with when the broker
/// says them.
Map<String, Object?> questionResolved(
  String id, {
  List<List<String>>? answers,
  String? decidedBy,
  String? releaseReason,
}) => {
  'type': 'question-resolved',
  'requestId': id,
  'answers': ?answers,
  'decidedBy': ?decidedBy,
  'releaseReason': ?releaseReason,
};

/// Approval-card verbs and finders over a running App.
extension ApprovalDriver on AppDriver {
  /// The answer button [kind] (`approve`, `approve-session`, `approve-rule`,
  /// `reject`) of permission card [id].
  Finder permissionButton(String id, String kind) =>
      find.byKey(Key('session-detail-permission-$kind-$id'));

  /// Every answer button permission card [id] draws.
  Finder permissionButtons(String id) => find.byWidgetPredicate((widget) {
    final key = widget.key;
    if (key is! ValueKey<String>) return false;
    return const [
      'approve',
      'approve-session',
      'approve-rule',
      'reject',
    ].any((kind) => key.value == 'session-detail-permission-$kind-$id');
  });

  /// Whether the button [finder] matches can be pressed.
  bool canPress(Finder finder) {
    final widget = tester.widget(finder.first);
    return switch (widget) {
      FilledButton(:final onPressed) => onPressed != null,
      OutlinedButton(:final onPressed) => onPressed != null,
      TextButton(:final onPressed) => onPressed != null,
      FilterChip(:final onSelected) => onSelected != null,
      _ => throw StateError('not a button: ${widget.runtimeType}'),
    };
  }

  /// Whether permission card [id] still takes an answer.
  bool permissionAnswerable(String id) =>
      permissionButtons(id).evaluate().isNotEmpty &&
      canPress(permissionButton(id, 'approve'));

  /// Presses [kind] on permission card [id].
  Future<void> answerPermission(String id, String kind) =>
      tap(permissionButton(id, kind));

  /// Opens (or closes) the detail disclosure of the one permission card that
  /// has a toggle on screen.
  Future<void> toggleDetail() => tapKey('session-permission-detail-toggle');

  /// The question card's controls.
  Finder questionControl(String part, String id, [String suffix = '']) =>
      find.byKey(Key('session-detail-question-$part-$id$suffix'));

  /// Option [option] of question [question] on card [id].
  Finder questionOption(String id, int question, int option) =>
      questionControl('option', id, '-$question-$option');

  /// Whether chip [option] of [question] on card [id] is checked.
  bool optionChecked(String id, int question, int option) =>
      tester.widget<FilterChip>(questionOption(id, question, option)).selected;

  /// Sends the answer of question card [id].
  Future<void> sendAnswer(String id) =>
      tap(questionControl('answer-button', id));

  /// The sentence a settled question card closes with.
  String? questionOutcome(String id) => tester
      .widgetList<Text>(questionControl('outcome', id))
      .singleOrNull
      ?.data;

  /// The sentence a settled permission card closes with.
  String? permissionOutcome(String id) => tester
      .widgetList<Text>(
        find.byKey(Key('session-detail-permission-outcome-$id')),
      )
      .singleOrNull
      ?.data;

  /// Approval frames the app sent to [broker]: `approve`, `answer` and
  /// `reject-question`, oldest first.
  List<Map<String, dynamic>> decisionsSent(FakeBroker broker) => [
    for (final socket in network.sockets)
      if (identical(socket.broker, broker))
        for (final frame in socket.sent)
          if (const {
            'approve',
            'answer',
            'reject-question',
          }.contains(frame['kind']))
            frame,
  ];
}
