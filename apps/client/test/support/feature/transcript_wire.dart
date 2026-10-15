// Transcript rows as the broker's history and live frames carry them, and the
// verbs a feature test needs to open a session over them and read what the
// user sees (F03).
//
// Rows are plain JSON maps in the broker's canonical shape (see the normalized
// message types in `broker_contract`). Nothing here is the client's own model:
// the App decodes and projects them exactly as it does for a real broker.
import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'cosyncing_app.dart';
import 'fake_broker.dart';
import 'roster_driver.dart';

/// A user prompt row.
Map<String, Object?> userRow(
  String text, {
  String? key,
  String? turnId,
  bool queued = false,
  Map<String, Object?> extra = const {},
}) => {
  'type': 'user-message',
  'text': text,
  'key': ?key,
  'turnId': ?turnId,
  if (queued) 'queued': true,
  ...extra,
};

/// A model answer row (a whole message, or a streaming `delta`).
Map<String, Object?> answerRow(
  String text, {
  String? key,
  bool final_ = true,
  Map<String, Object?> extra = const {},
}) => {
  'type': 'model-output',
  'text': text,
  'key': ?key,
  if (final_) 'final': true,
  ...extra,
};

/// A streaming chunk of the answer under [key].
Map<String, Object?> answerDelta(String delta, String key) => {
  'type': 'model-output',
  'delta': delta,
  'key': key,
};

/// A tool invocation.
Map<String, Object?> toolCallRow(
  String callId, {
  String toolClass = 'execute',
  String toolName = 'bash',
  Map<String, Object?>? semantic,
  Map<String, Object?> extra = const {},
}) => {
  'type': 'tool-call',
  'callId': callId,
  'toolName': toolName,
  'toolClass': toolClass,
  'semantic': ?semantic,
  ...extra,
};

/// A tool result.
Map<String, Object?> toolResultRow(
  String callId, {
  String toolClass = 'execute',
  String toolName = 'bash',
  Map<String, Object?>? semantic,
  Map<String, Object?> extra = const {},
}) => {
  'type': 'tool-result',
  'callId': callId,
  'toolName': toolName,
  'toolClass': toolClass,
  'semantic': ?semantic,
  ...extra,
};

/// A command's `semantic` block.
Map<String, Object?> commandSemantic(
  String command, {
  String state = 'completed',
  String? cwd,
  String? stdout,
  String? stderr,
  bool stdoutTruncated = false,
}) => {
  'kind': 'command',
  'command': command,
  'state': state,
  'cwd': ?cwd,
  if (stdout != null)
    'stdout': {'text': stdout, if (stdoutTruncated) 'truncated': true},
  if (stderr != null) 'stderr': {'text': stderr},
};

/// A run summary closing a turn.
Map<String, Object?> runSummaryRow(
  String turnId, {
  String status = 'done',
  int? totalRuntimeMs = 1500,
  String? key,
  Map<String, Object?> extra = const {},
}) => {
  'type': 'run-summary',
  'key': key ?? 'run:$turnId',
  'turnId': turnId,
  'status': status,
  'totalRuntimeMs': ?totalRuntimeMs,
  ...extra,
};

/// A canonical row of type [type] with [fields].
Map<String, Object?> row(
  String type, [
  Map<String, Object?> fields = const {},
]) => {'type': type, ...fields};

/// A normalized history frame captured from the broker over an adapter's fake
/// store (`e2e/adapters/kits/capture-history-frames.ts`).
class CapturedHistory {
  CapturedHistory._(this.agent, this.texts, this.messages);

  /// Loads the capture for [agent] (`claude`, `codex`, `pi`, ...).
  factory CapturedHistory.load(String agent) {
    final file = File(
      'test/support/feature/fixtures/history-$agent.json',
    );
    final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final history = json['history'] as Map<String, dynamic>;
    return CapturedHistory._(
      json['agent'] as String,
      [for (final text in json['texts'] as List) text as String],
      [
        for (final message in history['messages'] as List)
          (message as Map).cast<String, Object?>(),
      ],
    );
  }

  /// Every adapter with a capture.
  static const agents = [
    'claude',
    'codex',
    'grok',
    'omp',
    'opencode',
    'pi',
    'reasonix',
  ];

  /// The adapter.
  final String agent;

  /// Visible texts the fake store held, oldest first (user, answer, ...).
  final List<String> texts;

  /// The history rows exactly as the broker sent them.
  final List<Map<String, Object?>> messages;
}

/// Opens session [id] with [messages] as its durable history.
///
/// [setup] runs before the app launches (preferences, extra session fields).
/// [deepLink] opens the session page directly (no roster pane) instead of
/// through the roster row.
Future<AppDriver> openTranscript(
  FeatureContext f,
  List<Map<String, Object?>> messages, {
  String id = 's1',
  String tool = 'codex',
  FeatureViewport viewport = FeatureViewport.desktopTall,
  String? locale,
  String? textScale,
  double? systemTextScale,
  String? themeMode,
  String? toolDisplay,
  bool deepLink = false,
  List<Override> overrides = const [],
  FakeBroker? broker,
  void Function(FakeBroker broker)? setup,
}) async {
  final studio = broker ?? f.network.add('http://studio.test:7734');
  if (!studio.sessions.any((s) => s['id'] == id)) {
    studio.addSession(id, 'Fix login', tool: tool, cwd: '/work/studio');
  }
  studio.transcripts[id] = messages;
  setup?.call(studio);
  if (locale != null) await f.storage.preferences.setLocaleTag(locale);
  if (textScale != null) await f.storage.preferences.setTextScale(textScale);
  if (themeMode != null) await f.storage.preferences.setThemeMode(themeMode);
  if (systemTextScale != null) {
    // The operating system's text size (what the default "System" setting
    // follows).
    f.tester.platformDispatcher.textScaleFactorTestValue = systemTextScale;
    addTearDown(f.tester.platformDispatcher.clearTextScaleFactorTestValue);
  }
  if (toolDisplay != null) {
    await DriftSessionDisplayPreferencesStore(
      f.storage.database,
    ).setToolDisplayMode(toolDisplay);
  }
  await f.storage.seedServer(studio);
  if (deepLink) {
    // Straight to the session page: no roster beside it.
    return f.launch(
      viewport: viewport,
      initialLocation: '/sessions/$tool/$id',
      overrides: overrides,
    );
  }
  final app = await f.launch(viewport: viewport, overrides: overrides);
  // The narrow layout keeps the roster in a drawer.
  if (viewport.size.width < 700) await app.tapKey('workspace-open-drawer');
  await app.openFromRoster(id, tool: tool, cwd: '/work/studio');
  return app;
}

final Expando<int> _liveSeq = Expando<int>('live seq');

/// Transcript verbs over a running App.
extension TranscriptDriver on AppDriver {
  /// The newest open session socket of [id] on [broker].
  FakeBrokerSocket socket(FakeBroker broker, [String id = 's1']) =>
      broker.socketsFor(id).last;

  /// A live `message` frame, the way the broker streams a row.
  Future<void> live(
    FakeBroker broker,
    Map<String, Object?> message, {
    String id = 's1',
  }) => liveAll(broker, [message], id: id);

  /// Several live rows in order (each with the next sequence number), then
  /// one settle.
  Future<void> liveAll(
    FakeBroker broker,
    List<Map<String, Object?>> messages, {
    String id = 's1',
  }) async {
    final target = socket(broker, id);
    for (final message in messages) {
      target.emit({
        'kind': 'message',
        'seq': _liveSeq[target] = (_liveSeq[target] ?? 0) + 1,
        'message': message,
      });
    }
    await settle();
  }

  /// Expands (or collapses) the tool row [callId].
  Future<void> toggleTool(String callId) =>
      tap(find.byKey(ValueKey('tool-$callId-details')));

  /// The transcript list.
  Finder get transcriptView => find.byWidgetPredicate(
    (w) => w.runtimeType.toString() == '_TranscriptScrollView',
  );

  /// The transcript's vertical scrollable.
  Finder get transcriptScrollable => find
      .descendant(of: transcriptView, matching: find.byType(Scrollable))
      .first;

  /// The card of tool [callId] (the first one when an id repeats).
  Finder toolCard(String callId) =>
      find.byKey(ValueKey('tool-card-$callId')).first;

  /// Opens the lookup group that starts with the tool of `firstCallId`.
  Future<void> openLookupGroup() =>
      tap(find.byKey(const ValueKey('lookup-group-details-0')));

  /// Expands tool row [callId], runs [check] with its card, collapses it.
  Future<void> inspect(String callId, void Function(Finder card) check) async {
    await toggleTool(callId);
    check(toolCard(callId));
    await toggleTool(callId);
  }

  /// Number of rows on screen whose text contains [text].
  int count(String text) => find.textContaining(text).evaluate().length;

  /// Text of one rendered widget [finder] matches (its rich text).
  String textOf(Finder finder) {
    final buffer = StringBuffer();
    for (final element
        in find
            .descendant(of: finder, matching: find.byType(RichText))
            .evaluate()) {
      buffer
        ..write((element.widget as RichText).text.toPlainText())
        ..write('\n');
    }
    return buffer.toString();
  }

  /// The visible text with each text run on its own line, in tree order.
  List<String> get lines => visibleText.split('\n');
}

/// Order and count assertions over what the page shows.
extension TranscriptExpectations on AppDriver {
  /// Asserts every text of [texts] is on screen, in this order top to bottom.
  void expectInOrder(List<String> texts, {String? reason}) {
    final screen = visibleText;
    var from = 0;
    for (final text in texts) {
      final at = screen.indexOf(text, from);
      expect(
        at,
        isNonNegative,
        reason:
            '${reason ?? 'order'}: "$text" not found after offset $from in:\n'
            '$screen',
      );
      from = at + text.length;
    }
  }

  /// How many times [text] appears in what the page shows.
  int shown(String text) => text.allMatches(visibleText).length;
}

/// [finder] restricted to the descendants of [card].
Finder inside(Finder card, Finder finder) =>
    find.descendant(of: card, matching: finder);
