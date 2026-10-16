import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// The close paths that have no composer to read.
///
/// The compact page barriers before it closes, because it owns the
/// `TextEditingController` and can also report a refused write. The wide layout
/// owns neither: the tab strip's close button and the Ctrl/Cmd+W chord both
/// hand a key straight to [OpenSessionsController.close]. Closing a tab is what
/// drops the resident lease on that session's detail controller, so a value
/// typed inside the 300 ms debounce died with it.
///
/// The barrier therefore lives inside `close` itself — every close path gets it
/// by construction, and a close button added later cannot forget it.
void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
  const tabKey = 'claude/session-1';
  const ref = SessionRef(
    tool: 'claude',
    id: 'session-1',
    title: 'First',
    status: SessionStatus.idle,
  );

  late ProviderContainer container;
  late DriftSessionDraftRepository drafts;

  setUp(() {
    container = buildControllerContainer(
      key,
      FakeSessionDetailConnection(),
      FakeControllerAttachmentPicker(),
    );
    addTearDown(container.dispose);
    drafts = DriftSessionDraftRepository(container.read(appDatabaseProvider));
  });

  SessionDetailController detail() =>
      container.read(sessionDetailControllerProvider(key).notifier);

  OpenSessionsController openSessions() =>
      container.read(openSessionsControllerProvider.notifier);

  List<SessionRef> openRefs() =>
      container.read(openSessionsControllerProvider).value!.refs;

  Future<SessionLocalDraft?> storedRow() => drafts.load(
    brokerProfileId: fakeControllerBrokerScope(),
    sessionKey: key,
  );

  /// Lets the Drift-backed working set finish one write plus the membership
  /// emission it watches back, so a close cannot race the open that preceded
  /// it.
  Future<void> settleWorkingSet() async {
    for (var turn = 0; turn < 8; turn++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<void> openTab() async {
    await container.read(openSessionsControllerProvider.future);
    openSessions().open(ref);
    await settleWorkingSet();
    expect(openRefs().map((entry) => entry.key), [tabKey]);
  }

  group('OpenSessionsController.close', () {
    test('makes a draft still inside the debounce window durable', () async {
      await openTab();
      // The supervisor's resident lease, which is what keeps a detail
      // controller (and its staged composer value) alive for an open session.
      keepSessionDetailAlive(container, key);

      // The user typed. `stageLocalDraft` runs in the keystroke's own turn;
      // the 300 ms debounce that would persist it has NOT fired.
      detail().stageLocalDraft('half a sentence nobody sent');
      expect(await storedRow(), isNull);

      await openSessions().close(tabKey);

      expect((await storedRow())?.text, 'half a sentence nobody sent');
      expect(openRefs(), isEmpty);
    });

    test('holds the tab open until that draft is durable', () async {
      await openTab();
      keepSessionDetailAlive(container, key);
      detail().stageLocalDraft('still being written');

      final closing = openSessions().close(tabKey);
      // Ordering is the whole point: dropping the tab first would retire the
      // controller holding the only copy of this text.
      expect(openRefs().map((entry) => entry.key), [tabKey]);

      await closing;
      expect(openRefs(), isEmpty);
      expect((await storedRow())?.text, 'still being written');
    });

    test('flushes a draft on a tab that is not the active one', () async {
      await openTab();
      keepSessionDetailAlive(container, key);
      openSessions().open(
        const SessionRef(
          tool: 'codex',
          id: 'session-2',
          title: 'Second',
          status: SessionStatus.idle,
        ),
      );
      await settleWorkingSet();
      detail().stageLocalDraft('typed in the tab left behind');

      await openSessions().close(tabKey);

      expect((await storedRow())?.text, 'typed in the tab left behind');
      expect(openRefs().map((entry) => entry.key), ['codex/session-2']);
    });

    test(
      'coalesces with the compact page barrier instead of writing twice',
      () async {
        await openTab();
        keepSessionDetailAlive(container, key);
        detail().stageLocalDraft('typed then closed');

        // What `_closeOpenSession` does first: the page flushes the live
        // composer value itself, because only the page can report a refusal
        // and abandon the close.
        final result = await detail().flushLocalDraft('typed then closed');
        expect(result.isDurable, isTrue);
        final before = (await storedRow())!.mutationVersion;

        await openSessions().close(tabKey);

        final after = (await storedRow())!;
        expect(after.text, 'typed then closed');
        // The second flush found the same value already durable, so it wrote
        // nothing. Draft mutations are serialized and never nested, so it also
        // cannot deadlock behind the first.
        expect(after.mutationVersion, before);
      },
    );

    test('is a synchronous no-op when the session has no draft', () async {
      await openTab();
      keepSessionDetailAlive(container, key);

      // A live controller that never staged anything must not defer the tab
      // mutation by a microtask.
      unawaited(openSessions().close(tabKey));
      expect(openRefs(), isEmpty);
      expect(await storedRow(), isNull);
    });

    test('is a synchronous no-op with no detail controller at all', () async {
      await openTab();

      // Nothing ever watched this session, so reading its controller here would
      // CREATE an attach-capable one for a session being walked away from.
      unawaited(openSessions().close(tabKey));
      expect(openRefs(), isEmpty);
      expect(await storedRow(), isNull);
    });

    test('closing a key that is not open never touches a draft', () async {
      await openTab();
      keepSessionDetailAlive(container, key);
      detail().stageLocalDraft('still open, still being typed');

      unawaited(openSessions().close('claude/never-opened'));

      expect(openRefs().map((entry) => entry.key), [tabKey]);
      expect(await storedRow(), isNull);
    });
  });
}
