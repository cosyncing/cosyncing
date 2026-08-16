import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_test/flutter_test.dart';

SessionControlState _control({
  required DriveState driveState,
  bool driveSupported = true,
  bool? willFork,
  bool? handoffAvailable,
  String? driveReason,
  bool syncSupported = false,
  bool syncAvailable = false,
  bool syncActive = false,
  String? input,
  String? command,
  String? syncReason,
  TerminalSyncAction? terminalAction,
  TerminalSyncPresence? terminalPresence,
  bool? terminalBehind,
}) {
  return SessionControlState(
    drive: SessionDriveControl(
      state: driveState,
      supported: driveSupported,
      reason: driveReason,
      willFork: willFork,
      handoffAvailable: handoffAvailable,
    ),
    terminalSync: SessionTerminalSync(
      supported: syncSupported,
      syncAvailable: syncAvailable,
      active: syncActive,
      input: input,
      command: command,
      reason: syncReason,
      action: terminalAction,
      presence: terminalPresence,
      behind: terminalBehind,
    ),
  );
}

void main() {
  group('SessionControlView two-gate derivation', () {
    test('null control fails closed like the broker', () {
      final view = SessionControlView.fromControl(null);
      expect(view.pill, SessionControlPill.unknown);
      expect(view.action, SessionControlAction.disabled);
      expect(view.canMutate, isFalse);
      expect(view.canPrompt, isFalse);
    });

    test('synced full-input: composer live, no button', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.unavailable,
          syncSupported: true,
          syncAvailable: true,
          syncActive: true,
          input: 'full',
        ),
      );
      expect(view.pill, SessionControlPill.synced);
      expect(view.action, SessionControlAction.none);
      expect(view.canMutate, isTrue);
      expect(view.canPrompt, isTrue);
      expect(view.answerOnly, isFalse);
    });

    test('synced answer-only: cards live, composer read-only', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.unavailable,
          syncSupported: true,
          syncAvailable: true,
          syncActive: true,
          input: 'answer-only',
        ),
      );
      expect(view.pill, SessionControlPill.synced);
      expect(view.answerOnly, isTrue);
      expect(view.canMutate, isTrue, reason: 'cards stay answerable');
      expect(view.canPrompt, isFalse, reason: 'composer is not live');
    });

    test('driving preserves action and willFork', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.driving,
          willFork: true,
          command: 'cd /w && claude --resume abc',
          terminalAction: TerminalSyncAction.handoff,
        ),
      );
      expect(view.pill, SessionControlPill.driving);
      expect(view.action, SessionControlAction.handoff);
      expect(view.canMutate, isTrue);
      expect(view.canPrompt, isTrue);
      expect(view.willFork, isTrue);
      expect(view.command, 'cd /w && claude --resume abc');
    });

    test('driving with handoffAvailable false offers NO handoff control', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.driving, handoffAvailable: false),
      );
      expect(
        view.action,
        SessionControlAction.none,
        reason:
            'the broker would refuse the call — offer nothing, not a '
            'button whose only outcome is a refusal',
      );
      expect(view.pill, SessionControlPill.driving);
      expect(view.canMutate, isTrue, reason: 'Drive itself is unaffected');
      expect(view.canPrompt, isTrue);
    });

    test('driving with handoffAvailable true offers handoff', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.driving, handoffAvailable: true),
      );
      expect(view.action, SessionControlAction.handoff);
    });

    test('absent handoffAvailable keeps the established behaviour', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.driving),
      );
      expect(
        view.action,
        SessionControlAction.handoff,
        reason: 'an older broker omits the field; it must not lose handoff',
      );
    });

    test('handoffAvailable false suppresses ONLY handoff, never join', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.driving,
          handoffAvailable: false,
          syncSupported: true,
          syncAvailable: true,
          terminalAction: TerminalSyncAction.join,
        ),
      );
      expect(
        view.action,
        SessionControlAction.join,
        reason: 'the field speaks about handoff, not about every action',
      );
    });

    test('handoffAvailable false overrides an explicit handoff action', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.driving,
          handoffAvailable: false,
          terminalAction: TerminalSyncAction.handoff,
        ),
      );
      expect(
        view.action,
        SessionControlAction.none,
        reason: 'the specific declaration wins over the routed default',
      );
    });

    test('a read-only socket is not offered Take over', () {
      // The session IS drivable — but not by this socket, which renounced
      // authority, and the read-only latch is monotone, so the re-attach a
      // takeover issues is still read-only and cannot succeed. Offering it
      // would be offering a control that can only fail.
      final view = SessionControlView.fromSessionDetail(
        info: const SessionInfo(
          id: 'session-1',
          tool: 'opencode',
          title: 'Future owner',
          status: SessionStatus.idle,
          attachMode: AttachMode.observe,
          control: SessionControlState(
            drive: SessionDriveControl(
              state: DriveState.observing,
              supported: true,
            ),
            terminalSync: SessionTerminalSync(
              supported: false,
              syncAvailable: false,
              active: false,
            ),
          ),
        ),
        authority: null,
        joinExisting: null,
        socketReadOnly: true,
      );
      expect(view.pill, SessionControlPill.observing, reason: 'still truthful');
      expect(view.action, SessionControlAction.disabled);
      expect(view.canTakeOver, isFalse);
    });

    test('the same session offers Take over on an ordinary socket', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.observing),
      );
      expect(view.action, SessionControlAction.takeOver);
      expect(view.canTakeOver, isTrue);
    });

    test('sync available (not active): explicit join action, not mutable', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.observing,
          syncSupported: true,
          syncAvailable: true,
          command: 'codex resume --remote sock 123',
          terminalAction: TerminalSyncAction.join,
        ),
      );
      expect(view.pill, SessionControlPill.syncAvailable);
      expect(view.action, SessionControlAction.join);
      expect(view.canMutate, isFalse);
      expect(view.canPrompt, isFalse);
    });

    test(
      'fromSessionInfo injects launchSurface and derives terminal fields',
      () {
        final info = SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'opencode',
          'title': 'Terminal test',
          'status': 'idle',
          'attachMode': 'live',
          'launchSurface': 'app',
          'control': {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': true,
              'syncAvailable': false,
              'active': false,
              'presence': 'absent',
            },
          },
        });
        final direct = SessionControlView.fromControl(info.control);
        final view = SessionControlView.fromSessionInfo(
          info,
        );
        expect(direct.terminalPresence, TerminalSyncPresence.absent);
        expect(view.launchSurface, SessionLaunchSurface.app);
        expect(view.terminalPresence, TerminalSyncPresence.absent);
        expect(view.terminalBehind, isNull);
      },
    );

    test('observing (drive supported): Take over with confirm', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.observing),
      );
      expect(view.pill, SessionControlPill.observing);
      expect(view.action, SessionControlAction.takeOver);
      expect(view.canMutate, isFalse);
    });

    test(
      'shareable remote Drive is truthful but keeps this socket read-only',
      () {
        const revision = SessionOwnerRevision(epoch: 'broker-1', seq: 3);
        final view = SessionControlView.fromSessionDetail(
          info: SessionInfo(
            id: 'session-1',
            tool: 'pi',
            title: 'Shared Pi session',
            status: SessionStatus.idle,
            attachMode: AttachMode.observe,
            control: _control(driveState: DriveState.observing),
            sessionOwner: const SessionOwnerProjection(
              revision: revision,
              state: SessionOwnerState.drive,
            ),
          ),
          authority: const SessionConnectionAuthority(
            canMutate: false,
            prompt: SessionPromptAuthority.none,
          ),
          joinExisting: const SessionJoinExistingAction(
            ownerRevision: revision,
          ),
        );

        expect(view.pill, SessionControlPill.driverActive);
        expect(view.action, SessionControlAction.none);
        expect(view.canMutate, isFalse);
        expect(view.canPrompt, isFalse);
        expect(view.canTakeOver, isFalse);
      },
    );

    test('Claude-shaped Observe remains unchanged without a join action', () {
      final view = SessionControlView.fromSessionDetail(
        info: SessionInfo(
          id: 'session-1',
          tool: 'claude',
          title: 'Claude session',
          status: SessionStatus.idle,
          attachMode: AttachMode.observe,
          control: _control(driveState: DriveState.observing),
          sessionOwner: const SessionOwnerProjection(
            revision: SessionOwnerRevision(epoch: 'broker-1', seq: 3),
            state: SessionOwnerState.drive,
          ),
        ),
        authority: const SessionConnectionAuthority(
          canMutate: false,
          prompt: SessionPromptAuthority.none,
        ),
        joinExisting: null,
      );

      expect(view.pill, SessionControlPill.observing);
      expect(view.action, SessionControlAction.takeOver);
      expect(view.canMutate, isFalse);
      expect(view.canPrompt, isFalse);
    });

    test('explicit socket authority overrides stale local Driving control', () {
      const revision = SessionOwnerRevision(epoch: 'broker-1', seq: 4);
      final view = SessionControlView.fromSessionDetail(
        info: SessionInfo(
          id: 'session-1',
          tool: 'codex',
          title: 'Codex session',
          status: SessionStatus.idle,
          attachMode: AttachMode.observe,
          control: _control(driveState: DriveState.driving),
          sessionOwner: const SessionOwnerProjection(
            revision: revision,
            state: SessionOwnerState.drive,
          ),
        ),
        authority: const SessionConnectionAuthority(
          canMutate: false,
          prompt: SessionPromptAuthority.none,
        ),
        joinExisting: const SessionJoinExistingAction(
          ownerRevision: revision,
        ),
      );

      expect(view.pill, SessionControlPill.driverActive);
      expect(view.canPrompt, isFalse);
    });

    test('neither provable: disabled with reason', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.unavailable,
          driveSupported: false,
          driveReason: 'Take over unavailable for this wrapper.',
        ),
      );
      expect(view.pill, SessionControlPill.unavailable);
      expect(view.action, SessionControlAction.disabled);
      expect(view.canMutate, isFalse);
      expect(view.reason, 'Take over unavailable for this wrapper.');
    });

    test('precedence: sync-active outranks driving', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.driving,
          syncSupported: true,
          syncAvailable: true,
          syncActive: true,
          input: 'full',
        ),
      );
      expect(view.pill, SessionControlPill.synced);
      expect(view.action, SessionControlAction.none);
    });

    test('precedence: driving outranks sync-available', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.driving,
          syncSupported: true,
          syncAvailable: true,
        ),
      );
      expect(view.pill, SessionControlPill.driving);
      expect(view.action, SessionControlAction.handoff);
    });

    test('terminal action fallback preserves legacy Drive behavior', () {
      SessionControlAction expectAction({
        required bool syncSupported,
        TerminalSyncAction? terminalAction,
      }) => SessionControlView.fromControl(
        _control(
          driveState: DriveState.driving,
          syncSupported: syncSupported,
          terminalAction: terminalAction,
        ),
      ).action;
      for (final row in [
        (true, TerminalSyncAction.join, SessionControlAction.join),
        (true, TerminalSyncAction.handoff, SessionControlAction.handoff),
        (true, null, SessionControlAction.handoff),
        (false, null, SessionControlAction.handoff),
      ]) {
        expect(
          expectAction(syncSupported: row.$1, terminalAction: row.$2),
          row.$3,
        );
      }
    });

    test('missing terminal action still joins from sync-available', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.observing,
          syncSupported: true,
          syncAvailable: true,
        ),
      );

      expect(view.action, SessionControlAction.join);
    });

    test('willFork defaults false when absent (non-Claude agents)', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.observing),
      );
      expect(view.willFork, isFalse);
    });

    test('unsupported drive cannot render Driving or pass either gate', () {
      final view = SessionControlView.fromControl(
        _control(driveState: DriveState.driving, driveSupported: false),
      );

      expect(view.pill, SessionControlPill.unavailable);
      expect(view.action, SessionControlAction.disabled);
      expect(view.canMutate, isFalse);
      expect(view.canPrompt, isFalse);
    });

    test('unsupported sync cannot render Sync available or Synced', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.observing,
          syncAvailable: true,
          syncActive: true,
        ),
      );

      expect(view.pill, SessionControlPill.observing);
      expect(view.action, SessionControlAction.takeOver);
      expect(view.canMutate, isFalse);
      expect(view.canPrompt, isFalse);
    });

    test('answer-only is inert unless supported sync is active', () {
      final view = SessionControlView.fromControl(
        _control(
          driveState: DriveState.unavailable,
          driveSupported: false,
          syncSupported: true,
          syncAvailable: true,
          input: 'answer-only',
        ),
      );

      expect(view.answerOnly, isFalse);
      expect(view.canMutate, isFalse);
      expect(view.canPrompt, isFalse);
    });
  });
}
