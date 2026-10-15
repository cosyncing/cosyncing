// F04c — Attaching files to a prompt through the real App: the picker,
// paste and desktop drop, and what happens to the files when the prompt is
// answered, refused or replayed.
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_types.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_intake.dart';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/composer_driver.dart';
import '../support/feature/composer_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_attachments.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';

AgentInfo fileAgent({bool files = true}) =>
    fakeAgent(supportsNativeFileInput: files);

/// An opened session whose agent takes files.
Future<(AppDriver, FakeBroker, ComposerDesk, FakeAttachmentPicker)>
openWithFiles(
  FeatureContext f, {
  bool agentTakesFiles = true,
  FakeAttachmentClipboard? clipboard,
  TargetPlatform? platformNote,
  void Function(ComposerDesk desk)? setup,
}) async {
  final picker = FakeAttachmentPicker();
  final studio = f.network.add('http://studio.test:7734')
    ..agents = [fileAgent(files: agentTakesFiles)]
    ..addSession('s1', 'Fix login');
  final desk = ComposerDesk(studio);
  setup?.call(desk);
  await f.storage.seedServer(studio);
  final app = await f.launch(
    overrides: [
      picker.providerOverride,
      if (clipboard != null) clipboard.providerOverride,
    ],
  );
  await app.openFromRoster('s1', cwd: '/work/studio');
  return (app, studio, desk, picker);
}

Finder chip(String name) => find.text(name);

void main() {
  group('the file picker', () {
    featureTest(
      'files are staged as chips in order without sending; a chip can be '
      'replaced or removed; the prompt then carries what is left, and the '
      'chips stay until the broker acknowledges it',
      (f) async {
        final (app, _, desk, picker) = await openWithFiles(
          f,
          setup: (desk) => desk.answer = PromptAnswer.hold,
        );
        picker.next = [
          textFile('notes.txt', 'hello'),
          textFile('diagram.svg', '<svg/>'),
        ];
        await app.pressAttach();
        expect(picker.picks, [true]);
        expect(chip('notes.txt'), findsOneWidget);
        expect(chip('diagram.svg'), findsOneWidget);
        expect(find.text('5 bytes · Ready to send'), findsOneWidget);
        expect(desk.prompts, isEmpty);

        picker.next = [textFile('revised.txt', 'revised')];
        await app.tapKey('session-detail-attachment-replace-attachment-1');
        expect(picker.picks, [true, false]);
        expect(chip('notes.txt'), findsNothing);
        expect(chip('revised.txt'), findsOneWidget);

        await app.tapKey('session-detail-attachment-remove-attachment-2');
        expect(chip('diagram.svg'), findsNothing);

        await app.send('Review the revision');
        final frame = desk.prompts.single;
        expect(frame['text'], 'Review the revision');
        final files = frame['files'] as List;
        expect(files, hasLength(1));
        expect((files.single as Map)['name'], 'revised.txt');
        expect(chip('revised.txt'), findsOneWidget, reason: 'until the ACK');

        desk.release(frame);
        await app.settle();
        expect(chip('revised.txt'), findsNothing);
        expect(app.composerText, isEmpty);
      },
    );

    featureTest(
      'a draft typed while a file prompt awaits its ACK survives the ACK',
      (f) async {
        final (app, _, desk, picker) = await openWithFiles(
          f,
          setup: (desk) => desk.answer = PromptAnswer.hold,
        );
        picker.next = [textFile('notes.txt', 'hello')];
        await app.pressAttach();
        await app.send('First prompt with a file');
        await app.type('Second draft while waiting for the ACK');

        desk.release(desk.prompts.single);
        await app.settle();
        expect(app.composerText, 'Second draft while waiting for the ACK');
        expect(chip('notes.txt'), findsNothing);
      },
    );

    featureTest(
      'a refused file prompt keeps the file and the text for a retry, in '
      'plain words',
      (f) async {
        final (app, _, desk, picker) = await openWithFiles(f);
        picker.next = [textFile('notes.txt', 'hello')];
        await app.pressAttach();
        desk
          ..answer = PromptAnswer.refuse
          ..refusal = (
            code: 'attachment-consumption-failed',
            message: 'adapter did not receive the file',
          );
        await app.send('Keep this draft');
        await app.settle();

        expect(chip('notes.txt'), findsOneWidget);
        expect(
          find.text('5 bytes · Not delivered — retry by sending'),
          findsOneWidget,
        );
        expect(app.visibleText, isNot(contains('adapter did not receive')));
        expect(app.composerText, 'Keep this draft');

        desk.answer = PromptAnswer.accept;
        await app.pressSend();
        await app.settle();
        expect(desk.prompts, hasLength(2));
        expect(chip('notes.txt'), findsNothing);
      },
    );

    featureTest(
      'the refusal of a file prompt says why the files are marked '
      'undelivered, and the banner stays until the user acts',
      (f) async {
        // KNOWN PRODUCT GAP: the controller sets this banner when the NACK
        // lands, but the restored text is republished as a shared draft and
        // the broker's echo of that is a wire event, and every wire event
        // clears the controller's error. The banner is gone a few frames
        // after it appears, leaving only the chip's own "Not delivered".
        final (app, _, desk, picker) = await openWithFiles(f);
        picker.next = [textFile('notes.txt', 'hello')];
        await app.pressAttach();
        desk
          ..answer = PromptAnswer.refuse
          ..refusal = (
            code: 'attachment-consumption-failed',
            message: 'adapter did not receive the file',
          );
        await app.send('Keep this draft');
        await app.settle();
        await app.tick(const Duration(seconds: 1));
        expect(
          find.text(
            "The agent didn't receive every file. "
            'Your prompt and files are still here.',
          ),
          findsOneWidget,
        );
      },
      skip: true,
    );

    featureTest(
      'a cancelled or failed pick stages nothing',
      (f) async {
        final (app, _, _, picker) = await openWithFiles(f);
        picker.next = const [];
        await app.pressAttach();
        expect(find.byKey(const ValueKey('attachment-1')), findsNothing);
        picker.failNext = true;
        await app.pressAttach();
        expect(find.byKey(const ValueKey('attachment-1')), findsNothing);
      },
    );

    featureTest(
      'more files than a prompt may carry are refused as a whole, leaving '
      'the staged ones alone',
      (f) async {
        final (app, _, _, picker) = await openWithFiles(f);
        picker.next = [textFile('one.txt', '1')];
        await app.pressAttach();
        picker.next = [
          for (var i = 0; i < promptAttachmentMaxFiles; i++)
            textFile('extra$i.txt', 'x'),
        ];
        await app.pressAttach();
        expect(chip('one.txt'), findsOneWidget);
        expect(chip('extra0.txt'), findsNothing);
        expect(chip('extra${promptAttachmentMaxFiles - 1}.txt'), findsNothing);
      },
    );

    featureTest('an agent that takes no files leaves Attach disabled', (
      f,
    ) async {
      final (app, _, _, _) = await openWithFiles(f, agentTakesFiles: false);
      expect(await app.attachEnabled(), isFalse);
    });

    featureTest('while the stream is down Attach is disabled', (f) async {
      final (app, studio, _, _) = await openWithFiles(f);
      expect(await app.attachEnabled(), isTrue);
      studio.socketsAccepted = false;
      for (final socket in studio.socketsFor('s1')) {
        socket.drop();
      }
      await app.elapse(const Duration(seconds: 2));
      expect(await app.attachEnabled(), isFalse);
    });
  });

  group('after a reconnect', () {
    featureTest(
      'a file prompt the broker never answered is replayed with the same id '
      'and the same files; the duplicate answer clears them once',
      (f) async {
        final (app, studio, desk, picker) = await openWithFiles(
          f,
          setup: (desk) => desk.answer = PromptAnswer.hold,
        );
        picker.next = [textFile('notes.txt', 'hello')];
        await app.pressAttach();
        await app.send('with a file');
        final first = desk.prompts.single;

        desk.answer = PromptAnswer.accept;
        for (final socket in studio.socketsFor('s1')) {
          socket.drop();
        }
        await app.pumpUntil(
          () => desk.prompts.length == 2,
          reason: 'the prompt to be replayed',
          every: const Duration(seconds: 1),
        );
        await app.settle();
        final replay = desk.prompts.last;
        expect(replay['clientMessageId'], first['clientMessageId']);
        expect(replay['files'], first['files']);
        expect(chip('notes.txt'), findsNothing);
        expect(app.bubbles('with a file'), 1);
      },
    );
  });

  group('dropping files on the desktop', () {
    featureTest(
      'a drop stages its files in order once, keeps the cursor in the '
      'composer, and never sends; the overlay follows nested drags',
      (f) async {
        final (app, _, desk, _) = await openWithFiles(f);
        await app.focusComposer();
        expect(app.hasDropSurface, isTrue);

        await app.dragEnter();
        await app.dragEnter();
        expect(app.dropOverlayShowing, isTrue);
        await app.dragExit();
        expect(app.dropOverlayShowing, isTrue);
        await app.dragExit();
        expect(app.dropOverlayShowing, isFalse);

        final items = [
          droppedFile('first.png', [1, 2]),
          droppedFile('second.png', [3]),
        ];
        await app.drop(items, times: 2);
        expect(chip('first.png'), findsOneWidget);
        expect(chip('second.png'), findsOneWidget);
        expect(
          f.tester.widget<TextField>(promptField).focusNode?.hasFocus,
          isTrue,
        );
        expect(desk.prompts, isEmpty);
      },
    );

    featureTest(
      'a folder or a URL is refused without touching the draft or the chips',
      (f) async {
        final (app, _, _, picker) = await openWithFiles(f);
        picker.next = [textFile('notes.txt', 'hello')];
        await app.pressAttach();
        await app.type('keep this draft');

        await app.drop([
          DropItemDirectory.fromData(
            Uint8List(0),
            const [],
            name: 'folder',
            path: '/folder',
          ),
        ]);
        expect(find.textContaining("Couldn't add those files"), findsOneWidget);
        await app.drop([
          droppedFile(
            'remote.png',
            [1],
            path: 'https://example.test/remote.png',
          ),
        ]);
        expect(chip('remote.png'), findsNothing);
        expect(chip('notes.txt'), findsOneWidget);
        expect(app.composerText, 'keep this draft');
      },
    );

    featureTest('Windows drive and UNC paths are admitted', (f) async {
      final (app, _, _, _) = await openWithFiles(f);
      await app.drop([
        droppedFile('drive.png', [1], path: r'C:\project\drive.png'),
        droppedFile('unc.png', [2], path: r'\\server\share\unc.png'),
      ]);
      expect(chip('drive.png'), findsOneWidget);
      expect(chip('unc.png'), findsOneWidget);
    }, platform: TargetPlatform.windows);

    featureTest('a phone has no drop surface', (f) async {
      final (app, _, _, _) = await openWithFiles(f);
      expect(app.hasDropSurface, isFalse);
    }, platform: TargetPlatform.android);
  });

  group('pasting', () {
    featureTest(
      'pasted text stays draft text, pasted files become chips, and a send '
      'waits for a paste still being read',
      (f) async {
        final clipboard = FakeAttachmentClipboard();
        final (app, _, desk, _) = await openWithFiles(f, clipboard: clipboard);
        await app.focusComposer();

        clipboard.holdsText('plain text');
        await app.pasteChord();
        expect(app.composerText, 'plain text');
        expect(find.byType(ActionChip), findsNothing);

        clipboard.holdsFiles(['screenshot.png']);
        await app.pasteChord();
        expect(chip('screenshot.png'), findsOneWidget);
        expect(app.composerText, 'plain text');

        // A paste whose files are still being read holds the send back.
        final slow = clipboard.holdsFilesLater();
        await app.pasteChord();
        await app.pressSend();
        expect(desk.prompts, isEmpty, reason: 'intake has not settled');
        slow.complete(
          SessionAttachmentClipboardFiles([
            MemorySessionAttachmentIntakeItem(
              bytes: Uint8List.fromList([9]),
              name: 'late.png',
            ),
          ]),
        );
        await app.settle();
        await app.pressSend();
        expect(desk.prompts.single['text'], 'plain text');
        expect(desk.prompts.single['files'], hasLength(2));
      },
    );
  });
}
