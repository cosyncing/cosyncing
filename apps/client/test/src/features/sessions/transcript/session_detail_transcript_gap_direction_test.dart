// Which way a released range fills when the reader moves toward it (contract
// revision 28): moving down, from its older edge with a newer page where the
// broker pages forward; moving up, from its newer edge — unless the range is
// open, which only a newer page can fill. A notice for rows no reload returns
// offers nothing to load.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

final class _DirectionalGapController extends SeededSessionDetailController {
  _DirectionalGapController(super.initialState, {required this.pagesForward});

  final bool pagesForward;
  final List<String> older = [];
  final List<({String cursor, String until})> newer = [];

  @override
  bool get canLoadNewerHistory => pagesForward;

  @override
  Future<bool> loadEarlierHistory({
    int limit = kTranscriptHistoryPageMessages,
    String? cursor,
  }) async {
    if (cursor == null) return false;
    older.add(cursor);
    state = state.copyWith(historyPageLoading: true);
    return true;
  }

  @override
  Future<bool> loadNewerHistory({
    required String cursor,
    required String until,
    int limit = kTranscriptHistoryPageMessages,
  }) async {
    newer.add((cursor: cursor, until: until));
    state = state.copyWith(historyPageLoading: true);
    return true;
  }

  /// Ends the page in flight without changing the window, as a page that
  /// answered with nothing new would.
  void settlePage() => state = state.copyWith(historyPageLoading: false);
}

AgentMessage _row(int index) => AgentMessage.fromJson({
  'type': 'model-output',
  'key': 'row-$index',
  'text': 'Gap direction row $index',
});

List<AgentMessage> _rows(int from, int through) => [
  for (var index = from; index < through; index++) _row(index),
];

/// A window read back from its tail far enough that the budget released the
/// pages between the reader and the tail: a closed range, reloadable from
/// either edge.
TranscriptHistoryWindow _readBackWindow() {
  var window = TranscriptHistoryWindow.fromHistory(
    HistoryWireEvent(
      messages: _rows(2400, 2500),
      reset: true,
      cursor: 'tail',
      olderCursor: 'cursor-24',
      hasEarlier: true,
    ),
  );
  for (var page = 23; page >= 16; page--) {
    final start = page * 100;
    final mutation = window.prependPage(
      HistoryPageWireEvent(
        messages: _rows(start, start + 100),
        cursor: 'cursor-$page',
        hasMore: true,
        endOfHistory: false,
      ),
      requestedCursor: 'cursor-${page + 1}',
      preserveMessageKey: stableTranscriptMessageKey(_row(start + 100)),
    );
    expect(mutation.accepted, isTrue);
    window = mutation.window;
  }
  return window;
}

/// A window a capped reconnect caught up: the rows read before it, then the
/// open range it could not replay, then the newest rows.
TranscriptHistoryWindow _caughtUpWindow() {
  final window = TranscriptHistoryWindow.fromHistory(
    HistoryWireEvent(
      messages: _rows(0, 100),
      reset: true,
      cursor: 'r100',
      endCursor: 'b100',
      newerHistory: true,
    ),
  );
  return window.applyHistory(
    HistoryWireEvent(
      messages: _rows(250, 300),
      reset: true,
      cursor: 'r300',
      olderCursor: 'b250',
      hasEarlier: true,
      endCursor: 'b300',
      newerHistory: true,
    ),
    catchUp: true,
  );
}

SessionDetailState _stateFor(TranscriptHistoryWindow window) =>
    SessionDetailState(
      tool: 'claude',
      sessionId: 'session-1',
      connectionStatus: SessionDetailConnectionStatus.connected,
      bootstrapState: const SessionDetailBootstrapState(
        readiness: SessionDetailBootstrapReadiness.ready,
        attempt: 1,
        hasCachedMessages: true,
      ),
      transcriptWindow: window,
      historyStartReached: true,
      transcriptResetGeneration: 1,
    );

ScrollPosition _position(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find
        .descendant(
          of: find.byKey(const Key('session-detail-chat-scroll')),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  return scrollable.controller!.position;
}

Future<_DirectionalGapController> _pump(
  WidgetTester tester,
  TranscriptHistoryWindow window, {
  required bool pagesForward,
}) async {
  useRoomyTestViewport(tester);
  final controller = _DirectionalGapController(
    _stateFor(window),
    pagesForward: pagesForward,
  );
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], seededController: controller),
  );
  await tester.pumpAndSettle();
  return controller;
}

/// Moves (without earning intent) until [gap] is built, walking down from the
/// start or up from the end.
Future<void> _bringIntoReach(
  WidgetTester tester,
  TranscriptHistoryGapSegment gap, {
  required bool fromStart,
}) async {
  final finder = find.byKey(Key(gap.id));
  final position = _position(tester);
  final step = position.viewportDimension / 2;
  for (var round = 0; round < 400; round++) {
    final offset = fromStart
        ? position.minScrollExtent + round * step
        : position.maxScrollExtent - round * step;
    position.jumpTo(
      offset.clamp(position.minScrollExtent, position.maxScrollExtent),
    );
    await tester.pump();
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('the gap ${gap.id} never rendered');
}

Future<void> _wheel(WidgetTester tester, {required double dy}) async {
  await tester.sendEventToBinding(
    PointerScrollEvent(
      position: tester.getCenter(
        find.byKey(const Key('session-detail-chat-scroll')),
      ),
      scrollDelta: Offset(0, dy),
    ),
  );
  await tester.pump();
}

void main() {
  group('moving toward a released range', () {
    testWidgets('down, it fills from its older edge with a newer page', (
      tester,
    ) async {
      final window = _readBackWindow();
      final gap = window.gaps.first;
      expect(gap.forwardCursor, isNotNull);
      final controller = await _pump(tester, window, pagesForward: true);
      await _bringIntoReach(tester, gap, fromStart: true);
      expect(controller.newer, isEmpty);

      await _wheel(tester, dy: 40);
      expect(controller.newer, [
        (cursor: gap.forwardCursor!, until: gap.reloadCursor!),
      ]);
      expect(controller.older, isEmpty);
    });

    testWidgets('down by keyboard it fills the same way, but End jumps to the '
        'latest rows without loading the range on the way', (tester) async {
      final window = _readBackWindow();
      final gap = window.gaps.first;
      final controller = await _pump(tester, window, pagesForward: true);
      await _bringIntoReach(tester, gap, fromStart: true);

      await tester.sendKeyEvent(LogicalKeyboardKey.end);
      await tester.pump();
      expect(controller.newer, isEmpty);
      expect(controller.older, isEmpty);

      await _bringIntoReach(tester, gap, fromStart: true);
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pump();
      expect(controller.newer, [
        (cursor: gap.forwardCursor!, until: gap.reloadCursor!),
      ]);
    });

    testWidgets('turning back up spends nothing earned moving down', (
      tester,
    ) async {
      final window = _readBackWindow();
      final gap = window.gaps.first;
      final controller = await _pump(tester, window, pagesForward: true);
      _position(tester).jumpTo(_position(tester).minScrollExtent);
      await tester.pump();
      expect(find.byKey(Key(gap.id)), findsNothing);

      // Down, with the range still out of reach, then back up.
      await _wheel(tester, dy: 40);
      await _wheel(tester, dy: -40);
      // The range comes into reach without the reader moving toward it.
      await _bringIntoReach(tester, gap, fromStart: true);
      expect(controller.newer, isEmpty);
      expect(controller.older, isEmpty);
    });

    testWidgets('after a page up, turning down waits for half a viewport '
        'before it fills the range the other way', (tester) async {
      final window = _readBackWindow();
      final gap = window.gaps.first;
      final controller = await _pump(tester, window, pagesForward: true);
      await _bringIntoReach(tester, gap, fromStart: true);
      final position = _position(tester);
      final rect = tester.getRect(
        find.byKey(const Key('session-detail-chat-scroll')),
      );
      // The range's row near the bottom of the screen.
      final top = tester.getTopLeft(find.byKey(Key(gap.id))).dy;
      position.jumpTo(
        position.pixels + top - (rect.top + position.viewportDimension * 0.8),
      );
      await tester.pump();

      await _wheel(tester, dy: -40);
      expect(controller.older, [gap.reloadCursor]);
      // The reader holds still before the page ends (this one changes
      // nothing), so it calls for no other.
      await tester.pump(const Duration(milliseconds: 400));
      controller.settlePage();
      await tester.pump();
      expect(controller.older, hasLength(1));

      final half = position.viewportDimension / 2;
      var travelled = 40.0;
      while (travelled < half - 40) {
        await _wheel(tester, dy: 40);
        await tester.pump();
        travelled += 40;
        expect(
          controller.newer,
          isEmpty,
          reason: 'turned around ${travelled - 40} px back',
        );
      }
      for (var tick = 0; tick < 3 && controller.newer.isEmpty; tick++) {
        await _wheel(tester, dy: 40);
        await tester.pump();
      }
      expect(controller.newer, [
        (cursor: gap.forwardCursor!, until: gap.reloadCursor!),
      ]);
    });

    testWidgets('down, without forward paging, it pages back from its newer '
        'edge', (tester) async {
      final window = _readBackWindow();
      final gap = window.gaps.first;
      final controller = await _pump(tester, window, pagesForward: false);
      await _bringIntoReach(tester, gap, fromStart: true);

      await _wheel(tester, dy: 40);
      expect(controller.older, [gap.reloadCursor]);
      expect(controller.newer, isEmpty);
    });

    testWidgets('up, a closed range still pages back from its newer edge', (
      tester,
    ) async {
      final window = _readBackWindow();
      final gap = window.gaps.first;
      final controller = await _pump(tester, window, pagesForward: true);
      await _bringIntoReach(tester, gap, fromStart: false);

      await _wheel(tester, dy: -40);
      expect(controller.older, [gap.reloadCursor]);
      expect(controller.newer, isEmpty);
    });

    testWidgets('up, an open range fills only with a newer page', (
      tester,
    ) async {
      final window = _caughtUpWindow();
      final gap = window.gaps.single;
      expect(window.reloadsOnlyForward(gap.reloadCursor!), isTrue);
      final controller = await _pump(tester, window, pagesForward: true);
      await _bringIntoReach(tester, gap, fromStart: false);

      await _wheel(tester, dy: -40);
      expect(controller.newer, [(cursor: 'b100', until: 'b250')]);
      expect(controller.older, isEmpty);
    });
  });

  testWidgets('a range whose position the broker refused says it cannot '
      'load, offers no retry, and is not asked for again', (tester) async {
    final window = _readBackWindow();
    final gap = window.gaps.first;
    useRoomyTestViewport(tester);
    final controller = _DirectionalGapController(
      _stateFor(window).copyWith(
        historyRefusedCursors: {gap.reloadCursor!: 'HISTORY_CURSOR_GONE'},
      ),
      pagesForward: true,
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: const [],
        seededController: controller,
      ),
    );
    await tester.pumpAndSettle();
    await _bringIntoReach(tester, gap, fromStart: true);

    final l10n = await AppLocalizations.delegate.load(const Locale('en'));
    expect(
      find.descendant(
        of: find.byKey(Key(gap.id)),
        matching: find.text(l10n.sessionHistoryLoadFailed),
      ),
      findsOneWidget,
    );
    expect(find.byKey(Key('${gap.id}-reload')), findsNothing);
    await _wheel(tester, dy: 40);
    await _wheel(tester, dy: -40);
    expect(controller.newer, isEmpty);
    expect(controller.older, isEmpty);
  });

  testWidgets('while another page loads, a range whose position the broker '
      'refused still shows that it cannot load', (tester) async {
    final window = _readBackWindow();
    final gap = window.gaps.first;
    useRoomyTestViewport(tester);
    final controller = _DirectionalGapController(
      _stateFor(window).copyWith(
        historyPageLoading: true,
        historyRefusedCursors: {gap.reloadCursor!: 'HISTORY_CURSOR_GONE'},
      ),
      pagesForward: true,
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: const [],
        seededController: controller,
      ),
    );
    for (var frame = 0; frame < 5; frame++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await _bringIntoReach(tester, gap, fromStart: true);

    expect(
      find.descendant(
        of: find.byKey(Key(gap.id)),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsNothing,
    );
    expect(
      find.descendant(
        of: find.byKey(Key(gap.id)),
        matching: find.byIcon(Icons.error_outline),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a refused start of the window says it cannot load earlier '
      'rows, offers no retry, and scrolling up asks for nothing', (
    tester,
  ) async {
    final window = _readBackWindow();
    final cursor = window.olderHistoryCursor!;
    useRoomyTestViewport(tester);
    final controller = _DirectionalGapController(
      _stateFor(window).copyWith(
        historyStartReached: false,
        historyRefusedCursors: {cursor: 'HISTORY_CURSOR_DIVERGED'},
      ),
      pagesForward: true,
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: const [],
        seededController: controller,
      ),
    );
    await tester.pumpAndSettle();
    _position(tester).jumpTo(_position(tester).minScrollExtent);
    await tester.pump();

    final l10n = await AppLocalizations.delegate.load(const Locale('en'));
    expect(
      tester
          .widget<Text>(find.byKey(const Key('session-history-page-error')))
          .data,
      l10n.sessionHistoryLoadFailed,
    );
    expect(find.byKey(const Key('session-history-load-earlier')), findsNothing);
    for (var round = 0; round < 6; round++) {
      await _wheel(tester, dy: -120);
    }
    await tester.pumpAndSettle();
    expect(controller.older, isEmpty);
    expect(controller.newer, isEmpty);
  });

  testWidgets('a notice for released rows no reload returns says so and '
      'offers nothing to load', (tester) async {
    // An approval arrived live and was never saved; a replacing reset could
    // not keep it.
    var window = TranscriptHistoryWindow.fromHistory(
      HistoryWireEvent(
        messages: _rows(0, 100),
        reset: true,
        cursor: 'r100',
        endCursor: 'b100',
        newerHistory: true,
      ),
    );
    for (final message in [
      AgentMessage.fromJson({
        'type': 'permission-request',
        'requestId': 'req1',
        'title': 'Run Bash?',
      }),
      AgentMessage.fromJson({
        'type': 'permission-resolved',
        'requestId': 'req1',
        'decision': 'allow',
      }),
      _row(100),
    ]) {
      window = window.applyLiveMessage(message);
    }
    window = window.applyHistory(
      HistoryWireEvent(
        messages: [_row(100)],
        cursor: 'r101',
        endCursor: 'b101',
        newerHistory: true,
      ),
    );
    window = window.applyHistory(
      HistoryWireEvent(
        messages: _rows(200, 300),
        reset: true,
        cursor: 'r300',
        olderCursor: 'b200',
        hasEarlier: true,
        endCursor: 'b300',
        newerHistory: true,
      ),
    );
    final notice =
        [
          ?window.leadingGap,
          ...window.gaps,
        ].singleWhere(
          (gap) => gap.kind == TranscriptHistoryGapKind.unsavedReleased,
        );
    final controller = await _pump(tester, window, pagesForward: true);
    await _bringIntoReach(tester, notice, fromStart: true);

    final l10n = await AppLocalizations.delegate.load(const Locale('en'));
    final text = tester.widget<Text>(
      find.descendant(
        of: find.byKey(Key(notice.id)),
        matching: find.byType(Text),
      ),
    );
    expect(text.data, l10n.sessionHistoryUnsavedReleased);

    // Even after a paging failure, there is nothing to retry.
    controller.emittedState = controller.emittedState.copyWith(
      historyPageError: const LocalizedFailure.notice(
        FailureLead.loadEarlierHistory,
      ),
      historyPageErrorCode: 'HISTORY_PAGE_SOURCE_CHANGED',
    );
    await tester.pump();
    expect(find.byKey(Key('${notice.id}-reload')), findsNothing);
    expect(controller.older, isEmpty);
    expect(controller.newer, isEmpty);
  });
}
