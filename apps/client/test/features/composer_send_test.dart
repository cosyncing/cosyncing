// The desk is configured field by field inside setup callbacks.
// ignore_for_file: cascade_invocations
// F04a — Sending from the composer, through the real App: the optimistic
// bubble and its echo, a refused prompt, the send chords, the model and
// permission chips, Stop, and the slash palette.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/composer_driver.dart';
import '../support/feature/composer_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_speech.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/session_wire.dart';
import '../support/feature/transcript_wire.dart';

const stop = SlashCommand(name: 'stop', kind: SlashCommandKind.action);

const gpt = ModelOption(
  providerID: 'openai',
  modelID: 'gpt-5.4',
  label: 'GPT-5.4',
  reasoningEfforts: [
    ReasoningEffort(effort: 'low', label: 'Low'),
    ReasoningEffort(effort: 'high', label: 'High'),
  ],
  defaultReasoningEffort: 'low',
);

const opus = ModelOption(
  providerID: 'anthropic',
  modelID: 'claude-opus-4-6',
  label: 'Claude Opus 4.6',
  reasoningEfforts: [
    ReasoningEffort(effort: 'high', label: 'High'),
    ReasoningEffort(effort: 'max', label: 'Max'),
  ],
  defaultReasoningEffort: 'high',
);

void main() {
  group('phone keyboard', () {
    for (final scenario in [
      (platform: TargetPlatform.android, viewport: FeatureViewport.phone),
      (platform: TargetPlatform.iOS, viewport: FeatureViewport.narrowPhone),
      // Desktop outside-tap handling also unfocuses on pointer-down, as
      // mobile web does. Native mobile touch deliberately does not.
      (platform: TargetPlatform.linux, viewport: FeatureViewport.phone),
    ]) {
      featureTest(
        'keeps the composer above the keyboard and sends on the first tap '
        '(${scenario.platform.name})',
        (f) async {
          await f.storage.preferences.setThemeMode(
            scenario.platform == TargetPlatform.android ? 'dark' : 'light',
          );
          final (app, _, desk) = await openComposer(
            f,
            viewport: scenario.viewport,
            setup: (_, desk) => desk.answer = PromptAnswer.hold,
          );
          final composer = find.byKey(const Key('session-detail-composer'));
          f.tester.view
            ..viewPadding = const FakeViewPadding(bottom: 24)
            ..padding = const FakeViewPadding(bottom: 24);
          await app.type('First phone prompt');

          // Intermediate keyboard metrics must consume only the newly
          // obscured space, including after dismissal and reopening.
          for (final inset in [0.0, 96.0, 300.0, 320.0, 0.0, 300.0]) {
            f.tester.view
              ..viewInsets = FakeViewPadding(bottom: inset)
              ..padding = FakeViewPadding(bottom: inset == 0 ? 24 : 0);
            await app.settle();
            expect(
              f.tester.getRect(composer).bottom,
              closeTo(
                scenario.viewport.size.height - (inset == 0 ? 24 : inset) - 8,
                1,
              ),
              reason: 'the composer sits 8 dp above the keyboard or safe area',
            );
            expect(app.composerText, 'First phone prompt');
            expect(f.tester.takeException(), isNull);
          }

          final field = f.tester.widget<TextField>(promptField);
          final sendRect = f.tester.getRect(sendButton);
          expect(field.focusNode!.hasFocus, isTrue);
          final gesture = await f.tester.startGesture(sendRect.center);
          await f.tester.pump();
          expect(
            field.focusNode!.hasFocus,
            isTrue,
            reason: 'pressing Send must not dismiss the keyboard',
          );
          expect(f.tester.getRect(sendButton), sendRect);
          expect(desk.prompts, isEmpty);
          await gesture.up();
          await app.settle();
          expect(desk.promptTexts, ['First phone prompt']);
          expect(app.composerText, isEmpty);
          expect(field.focusNode!.hasFocus, isTrue);

          // Another tap while delivery is pending cannot duplicate the send.
          await f.tester.tap(sendButton);
          await app.settle();
          expect(desk.prompts, hasLength(1));
          desk.release(desk.prompts.single);
          await app.settle();

          await app.type('Keep this if refused');
          desk.answer = PromptAnswer.refuse;
          await app.pressSend();
          await app.settle();
          expect(app.composerText, 'Keep this if refused');
          expect(app.canSend, isTrue);
          expect(field.focusNode!.hasFocus, isTrue);
        },
        platform: scenario.platform,
      );
    }

    featureTest(
      'long drafts shrink to leave reading space without losing text',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          viewport: FeatureViewport.phone,
        );
        final draft = List.generate(
          12,
          (index) => 'Draft line $index',
        ).join('\n');
        await app.type(draft);
        final roomyHeight = f.tester.getSize(promptField).height;
        final field = f.tester.widget<TextField>(promptField);
        final selection = field.controller!.selection;
        f.tester.view.viewInsets = const FakeViewPadding(bottom: 320);
        await app.settle();
        expect(f.tester.getSize(promptField).height, lessThan(roomyHeight));
        expect(
          f.tester
              .getSize(find.byKey(const Key('session-detail-chat-scroll')))
              .height,
          greaterThan(100),
        );
        expect(app.composerText, draft);
        expect(field.controller!.selection, selection);
        expect(field.focusNode!.hasFocus, isTrue);
        expect(sendButton.hitTestable(), findsOneWidget);
        expect(f.tester.takeException(), isNull);
        await app.pressSend();
        expect(desk.promptTexts, [draft]);
        f.tester.view.viewInsets = FakeViewPadding.zero;
        await app.settle();
        expect(app.composerText, isEmpty);
        expect(f.tester.takeException(), isNull);
      },
      platform: TargetPlatform.android,
    );
  });

  group('a prompt and its echo', () {
    featureTest(
      'a sent prompt is a bubble at once, the composer empties, and the '
      "broker's echo adopts that same bubble",
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('ship it');

        expect(app.composerText, isEmpty);
        expect(app.bubbles('ship it'), 1);
        final frame = desk.prompts.single;
        expect(frame['text'], 'ship it');
        expect(frame['clientMessageId'], isA<String>());

        // The ACK alone changes nothing the user sees; the echo adopts the
        // bubble (no second row, none dropped).
        desk.release(frame);
        await app.settle();
        expect(app.bubbles('ship it'), 1);
        expect(desk.prompts, hasLength(1));
      },
    );

    featureTest(
      'a refused prompt takes its bubble back and gives the text to the '
      'composer, without leaking the broker code',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        desk.answer = PromptAnswer.refuse;
        await app.send('ship it');
        await app.settle();

        expect(app.bubbles('ship it'), 0);
        expect(app.composerText, 'ship it');
        expect(app.visibleText, isNot(contains('PROMPT_REFUSED')));
        expect(app.canSend, isTrue);

        // The refusal is final for that id: a second try is a new prompt.
        desk.answer = PromptAnswer.accept;
        await app.pressSend();
        expect(desk.prompts, hasLength(2));
        expect(
          desk.prompts.last['clientMessageId'],
          isNot(desk.prompts.first['clientMessageId']),
        );
        expect(app.bubbles('ship it'), 1);
      },
    );

    featureTest('nothing is sent for an empty or whitespace-only prompt', (
      f,
    ) async {
      final (app, _, desk) = await openComposer(f);
      expect(app.canSend, isFalse);
      await app.type('   \n ');
      expect(app.canSend, isFalse);
      await app.type('ok');
      expect(app.canSend, isTrue);
      expect(desk.prompts, isEmpty);
    });

    featureTest(
      'while the stream is down the composer stays editable but cannot send; '
      'the text is still there when the stream returns',
      (f) async {
        final (app, studio, desk) = await openComposer(f);
        studio.socketsAccepted = false;
        for (final socket in studio.socketsFor('s1')) {
          socket.drop();
        }
        await app.elapse(const Duration(seconds: 2));
        expect(app.visibleText, contains('Reconnecting'));

        await app.type('typed while offline');
        expect(app.composerText, 'typed while offline');
        expect(app.canSend, isFalse);

        studio.socketsAccepted = true;
        await app.pumpUntil(
          () => !app.visibleText.contains('Reconnecting'),
          reason: 'the stream to come back',
          every: const Duration(seconds: 1),
        );
        expect(app.composerText, 'typed while offline');
        expect(desk.prompts, isEmpty);
        await app.pressSend();
        expect(desk.promptTexts, ['typed while offline']);
      },
    );

    featureTest(
      'a follow-up sent while the agent works is labelled queued; one sent to '
      'an idle session is not',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.send('first');
        expect(
          find.byKey(const Key('queued-user-message-badge')),
          findsNothing,
        );

        desk.publishSession(status: 'working');
        await app.settle();
        await app.send('follow up');
        expect(
          find.byKey(const Key('queued-user-message-badge')),
          findsOneWidget,
        );
      },
    );
  });

  group('how an echo is matched to its bubble', () {
    featureTest(
      'an answer that streams before the echo never overtakes the prompt',
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('question');
        await app.live(studio, answerRow('The answer', key: 'a1'));
        app.expectInOrder(['question', 'The answer']);

        desk.acceptPrompt(studio.socketsFor('s1').last, desk.prompts.single);
        await app.settle();
        app.expectInOrder(['question', 'The answer']);
        expect(app.bubbles('question'), 1);
      },
    );

    featureTest(
      'an echo stamped with the prompt id adopts it even if the adapter '
      'changed the text; one stamped for no local send adopts nothing',
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('original words');
        final id = desk.prompts.single['clientMessageId']! as String;

        await app.live(
          studio,
          userRow(
            'another device said this',
            key: 'n1',
            extra: {
              'clientKey': 'ca.other-device.0',
            },
          ),
        );
        expect(app.bubbles('original words'), 1);
        expect(app.bubbles('another device said this'), 1);

        await app.live(
          studio,
          userRow(
            'original words, normalised',
            key: 'n2',
            extra: {
              'clientKey': id,
            },
          ),
        );
        expect(app.bubbles('original words'), 0);
        expect(app.bubbles('original words, normalised'), 1);
      },
    );

    featureTest(
      'an echo without an id adopts only the oldest bubble with that exact '
      'text; two identical prompts stay two bubbles',
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('again');
        await app.send('again');
        expect(app.bubbles('again'), 2);

        await app.live(studio, userRow('again', key: 'n1'));
        expect(app.bubbles('again'), 2);
        await app.live(studio, userRow('again', key: 'n2'));
        expect(app.bubbles('again'), 2);
        await app.live(studio, userRow('again', key: 'n3'));
        expect(app.bubbles('again'), 3);
      },
    );
  });

  group('the send keys', () {
    featureTest(
      'Ctrl+Enter sends on Linux and plain Enter only adds a line',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.type('first line');
        await app.chord(LogicalKeyboardKey.enter);
        expect(desk.prompts, isEmpty);
        expect(app.composerText, 'first line');

        await app.chord(
          LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft],
        );
        expect(desk.promptTexts, ['first line']);
        expect(app.composerText, isEmpty);
      },
    );

    featureTest(
      'Command+Enter is the macOS send chord and Control+Enter is not',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.type('from a mac');
        await app.chord(
          LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft],
        );
        expect(desk.prompts, isEmpty);
        await app.chord(
          LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.metaLeft],
        );
        expect(desk.promptTexts, ['from a mac']);
      },
      platform: TargetPlatform.macOS,
    );

    featureTest(
      'the chord never submits an active IME composition, and repeating it '
      'sends once',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.focusComposer();
        f.tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: 'ni hao',
            selection: TextSelection.collapsed(offset: 6),
            composing: TextRange(start: 0, end: 6),
          ),
        );
        await app.settle();
        await app.chord(
          LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft],
        );
        expect(desk.prompts, isEmpty);
        expect(app.composerText, 'ni hao');

        // Composition ends; two quick chords still deliver one prompt.
        f.tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: 'ni hao',
            selection: TextSelection.collapsed(offset: 6),
          ),
        );
        await app.settle();
        await f.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await f.tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await f.tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await f.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await app.settle();
        expect(desk.promptTexts, ['ni hao']);
      },
    );

    featureTest('Ctrl+K moves focus to the composer', (f) async {
      final (app, _, _) = await openComposer(f);
      await app.chord(
        LogicalKeyboardKey.keyK,
        modifiers: [LogicalKeyboardKey.controlLeft],
      );
      f.tester.testTextInput.enterText('typed after the shortcut');
      await app.settle();
      expect(app.composerText, 'typed after the shortcut');
    });
  });

  group('model and permission mode', () {
    featureTest(
      "the chip names the session's model, shows the raw id only as a "
      'tooltip, and an empty catalog changes neither model nor mode',
      (f) async {
        final (app, _, _) = await openComposer(
          f,
          setup: (_, desk) {
            desk.sessionExtras = {
              'currentModel': {
                'providerID': 'ollama-chat-local',
                'modelID': 'qwen3:4b',
                'label': 'Qwen3 4B (local chat completions)',
              },
              'currentMode': 'default',
            };
            desk.modes = const [ModeOption(value: 'default', label: 'Default')];
          },
        );
        expect(find.text('Qwen3 4B (local chat completions)'), findsOneWidget);
        expect(app.visibleText, isNot(contains('qwen3:4b')));
        expect(
          find.byTooltip(
            'Permission mode: Default. Applies to prompts and slash '
            'commands sent from this composer.',
          ),
          findsOneWidget,
        );
      },
    );

    featureTest(
      'picking a model and effort sends exactly that with the prompt and is '
      'remembered for the next launch',
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (_, desk) {
            desk.models = const [gpt, opus];
            desk.sessionExtras = {
              'currentModel': {
                'providerID': 'openai',
                'modelID': 'gpt-5.4',
                'reasoningEffort': 'low',
              },
            };
          },
        );
        expect(find.text('GPT-5.4'), findsOneWidget);

        await app.tapKey('session-detail-model-selector');
        await app.tapKey(
          'session-detail-model-option-anthropic/claude-opus-4-6/',
        );
        await app.tapKey('session-detail-effort-option-max');
        expect(find.text('Claude Opus 4.6'), findsOneWidget);

        await app.send('use the pick');
        final model = desk.prompts.single['model'] as Map;
        expect(model['providerID'], 'anthropic');
        expect(model['modelID'], 'claude-opus-4-6');
        expect(model['reasoningEffort'], 'max');

        // A fresh launch restores the pick while the broker still offers it.
        final again = await f.restart();
        await again.openFromRoster('s1', cwd: '/work/studio');
        expect(find.text('Claude Opus 4.6'), findsOneWidget);
        studio.sessions.length;
      },
    );
  });

  group('Stop', () {
    featureTest(
      'Stop appears only while an advertised turn works and the session is '
      'driven; Send stays so a prompt can be steered',
      (f) async {
        final (app, studio, desk) = await openComposer(f);
        const interrupt = Key('session-detail-interrupt-button');
        desk.publishSession(status: 'working');
        await app.settle();
        expect(find.byKey(interrupt), findsNothing, reason: 'not advertised');

        desk.advertise(const [stop]);
        await app.settle();
        expect(find.byKey(interrupt), findsOneWidget);
        expect(find.byKey(const Key('session-detail-send-button')), findsOne);

        // Steering is a prompt, not a Stop.
        await app.send('steer this turn');
        expect(desk.promptTexts, ['steer this turn']);
        expect(desk.others, isEmpty);

        studio.controls['s1'] = controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(supported: false),
        );
        desk.publishSession();
        await app.settle();
        expect(find.byKey(interrupt), findsNothing, reason: 'observing');
      },
    );

    featureTest(
      'Stop sends the advertised stop once however often it is tapped, and '
      'puts the accepted prompt back for revision without replaying it',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.commands = const [stop],
        );
        await app.send('revise this prompt');
        expect(app.composerText, isEmpty);
        desk.publishSession(status: 'working');
        await app.settle();

        final stopButton = find.byKey(
          const Key('session-detail-interrupt-button'),
        );
        await f.tester.tap(stopButton);
        await f.tester.tap(stopButton, warnIfMissed: false);
        await app.settle();

        final commands = desk.others.where((o) => o['kind'] == 'command');
        expect(commands, hasLength(1));
        expect(commands.single['name'], 'stop');
        expect(app.composerText, 'revise this prompt');
        expect(desk.prompts, hasLength(1), reason: 'never replayed');
      },
    );

    featureTest(
      'a turn that finishes by itself leaves nothing to restore when Stop '
      'is pressed on the next one',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.commands = const [stop],
        );
        await app.send('completed prompt');
        desk.publishSession(status: 'working');
        await app.settle();
        desk.publishSession(status: 'idle');
        await app.settle();
        desk.publishSession(status: 'working');
        await app.settle();
        await app.tapKey('session-detail-interrupt-button');
        expect(desk.others.where((o) => o['kind'] == 'command'), hasLength(1));
        expect(app.composerText, isEmpty);
      },
    );
  });

  group('the slash palette', () {
    const goal = SlashCommand(
      name: '/goal',
      description: 'Set the current goal',
    );
    const git = SlashCommand(name: '/git', description: 'Git helpers');
    const review = SlashCommand(name: '/review');
    final palette = find.byKey(const Key('session-detail-slash-palette'));
    Finder item(String name) =>
        find.byKey(ValueKey('session-detail-slash-palette-item-$name'));

    featureTest(
      'a leading slash opens it and narrows as you type; a slash inside a '
      'sentence, or after a command name, never does',
      (f) async {
        final (app, _, _) = await openComposer(
          f,
          setup: (_, desk) => desk.commands = const [goal, git, review],
        );
        expect(palette, findsNothing);
        await app.type('/');
        expect(
          [
            item('goal'),
            item('git'),
            item('review'),
          ].map((i) => i.evaluate().length),
          [1, 1, 1],
        );
        await app.type('/g');
        expect(item('review'), findsNothing);
        expect(item('git'), findsOneWidget);
        await app.type('/zzz');
        expect(palette, findsNothing);

        for (final text in [
          'ship it and/or revert',
          'look at lib/src/goal',
          '/goal set finish the report',
        ]) {
          await app.type(text);
          expect(palette, findsNothing, reason: text);
        }
      },
    );

    featureTest(
      'arrows plus Enter, Tab, or a tap complete a command without sending; '
      'Escape dismisses the palette and keeps the text',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.commands = const [goal, git, review],
        );
        await app.type('/g');
        await app.chord(LogicalKeyboardKey.arrowDown);
        await app.chord(LogicalKeyboardKey.enter);
        expect(app.composerText, '/git ');
        expect(palette, findsNothing);

        await app.type('/rev');
        await app.chord(LogicalKeyboardKey.tab);
        expect(app.composerText, '/review ');

        await app.type('/g');
        await app.tap(item('git'));
        expect(app.composerText, '/git ');

        await app.type('/g');
        expect(palette, findsOneWidget);
        await app.chord(LogicalKeyboardKey.escape);
        expect(palette, findsNothing);
        expect(app.composerText, '/g');
        await app.type('/go');
        expect(
          palette,
          findsOneWidget,
          reason: 'dismissal ends at the next edit',
        );

        expect(desk.prompts, isEmpty);
        expect(desk.others, isEmpty);
      },
    );
  });

  group('the command sheet', () {
    const files = SlashCommand(
      name: '/files',
      description: 'List available files',
      usage: 'Usage: /files',
      args: {'path': '/tmp'},
    );
    const goal = SlashCommand(
      name: '/goal',
      description: 'Set the current goal',
      usage: '/goal set <text>',
    );
    const picker = Key('session-detail-command-picker');
    const argsInput = Key('session-detail-command-args-input');

    Future<void> openSheet(AppDriver app, String command) async {
      await app.tapKey('session-detail-composer-menu');
      await app.tapKey('session-detail-command-picker-button');
      await app.tapKey('session-detail-command-picker');
      await app.tap(find.text(command).last);
    }

    String args(AppDriver app) =>
        app.tester.widget<TextField>(find.byKey(argsInput)).controller!.text;

    featureTest(
      'a command is sent with its default args, with edited JSON args, or '
      'with free text as the one documented arg',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.commands = const [files, goal],
        );
        await openSheet(app, '/files');
        expect(find.text('List available files'), findsOneWidget);
        expect(args(app), contains('"path": "/tmp"'));
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others.last['name'], '/files');
        expect(desk.others.last['path'], '/tmp');

        await openSheet(app, '/files');
        await app.enterText(
          find.byKey(argsInput),
          '{"path": "/home/user", "depth": 2}',
        );
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others.last['path'], '/home/user');
        expect(desk.others.last['depth'], 2);

        await openSheet(app, '/goal');
        await app.enterText(find.byKey(argsInput), 'set finish the report');
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others.last['name'], '/goal');
        expect(desk.others.last['args'], 'set finish the report');
        expect(desk.others.where((o) => o['kind'] == 'command'), hasLength(3));
      },
    );

    featureTest(
      'invalid or non-object JSON blocks the send with a message, and an '
      'empty editor sends the command with no args',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.commands = const [files],
        );
        await openSheet(app, '/files');
        await app.enterText(find.byKey(argsInput), '{"path": ');
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others, isEmpty);
        expect(app.visibleText, contains('JSON'));

        await app.enterText(find.byKey(argsInput), '[1, 2]');
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others, isEmpty);

        await app.enterText(find.byKey(argsInput), '');
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others.single['name'], '/files');
        expect(desk.others.single.containsKey('path'), isFalse);
      },
    );

    featureTest(
      'with no commands advertised, or while the stream is down, the sheet '
      'opens but offers nothing to send',
      (f) async {
        final (app, studio, desk) = await openComposer(f);
        Future<void> expectInert() async {
          await app.tapKey('session-detail-composer-menu');
          await app.tapKey('session-detail-command-picker-button');
          final dropdown = app.tester.widget<DropdownButtonFormField<String>>(
            find.byKey(picker),
          );
          expect(dropdown.onChanged, isNull);
          expect(
            app.tester
                .widget<IconButton>(
                  find.byKey(const Key('session-detail-command-send-button')),
                )
                .onPressed,
            isNull,
          );
          await app.dismissModal();
        }

        await expectInert();

        desk.advertise(const [files]);
        studio.socketsAccepted = false;
        for (final socket in studio.socketsFor('s1')) {
          socket.drop();
        }
        await app.elapse(const Duration(seconds: 2));
        await expectInert();
        expect(desk.others, isEmpty);
      },
    );
  });

  group('permission mode and agent mode', () {
    const modes = [
      ModeOption(value: 'default', label: 'Default'),
      ModeOption(value: 'accept-edits', label: 'Accept edits'),
    ];

    featureTest(
      'the picked mode travels with prompts and commands; with no pick no '
      'mode is claimed',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) {
            desk.modes = modes;
            desk.commands = const [SlashCommand(name: '/files')];
            desk.sessionExtras = {'currentMode': 'default'};
          },
        );
        await app.send('plain');
        expect(desk.prompts.last.containsKey('permissionMode'), isFalse);

        await app.tapKey('session-detail-permission-selector');
        await app.tapKey('session-detail-permission-option-accept-edits');
        await app.send('with a mode');
        expect(desk.prompts.last['permissionMode'], 'accept-edits');

        await app.tapKey('session-detail-composer-menu');
        await app.tapKey('session-detail-command-picker-button');
        await app.tapKey('session-detail-command-picker');
        await app.tap(find.text('/files').last);
        await app.tapKey('session-detail-command-send-button');
        expect(desk.others.last['permissionMode'], 'accept-edits');
      },
    );

    featureTest(
      'an advertised agent mode is switched on the live session; with none '
      'advertised there is no control',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) {
            desk.models = const [];
            desk.agentOptions = const [
              AgentOption(name: 'build'),
              AgentOption(name: 'plan'),
            ];
            desk.sessionExtras = {'currentAgent': 'build'};
          },
        );
        await app.tapKey('session-detail-agent-selector');
        await app.tapKey('session-detail-agent-option-plan');
        final frame = desk.others.singleWhere((o) => o['kind'] == 'set-agent');
        expect(frame['agent'], 'plan');
        expect(desk.prompts, isEmpty);
      },
    );

    featureTest('no agent modes advertised: no agent control', (f) async {
      final (_, _, _) = await openComposer(f);
      expect(
        find.byKey(const Key('session-detail-agent-selector')),
        findsNothing,
      );
    });

    featureTest(
      'an observing session keeps the model chip but cannot change it, while '
      'Status stays reachable',
      (f) async {
        final (app, _, _) = await openComposer(
          f,
          setup: (studio, desk) {
            studio.controls['s1'] = controlBlock(
              drive: driveBlock('observing'),
              terminalSync: syncBlock(supported: false),
            );
            desk.models = const [gpt, opus];
            desk.sessionExtras = {
              'currentModel': {
                'providerID': 'openai',
                'modelID': 'gpt-5.4',
                'reasoningEffort': 'low',
              },
            };
          },
        );
        final model = app.tester.widget<TextButton>(
          find.descendant(
            of: find.byKey(const Key('session-detail-model-selector')),
            matching: find.byType(TextButton),
          ),
        );
        expect(model.onPressed, isNull);
        expect(
          find.byKey(const Key('session-detail-status-chip')),
          findsOneWidget,
        );
      },
    );
  });

  group('delivery across a reconnect', () {
    featureTest(
      'a prompt the broker never answered is replayed with the same id after '
      "a reconnect, and the broker's duplicate answer leaves one bubble",
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('did this arrive');
        final id = desk.prompts.single['clientMessageId'];

        desk.answer = PromptAnswer.accept;
        for (final socket in studio.socketsFor('s1')) {
          socket.drop();
        }
        await app.pumpUntil(
          () => desk.prompts.length == 2,
          reason: 'the unanswered prompt to be replayed',
          every: const Duration(seconds: 1),
        );
        expect(desk.prompts.last['clientMessageId'], id);
        expect(desk.prompts.last['text'], 'did this arrive');
        expect(app.bubbles('did this arrive'), 1);
      },
    );

    featureTest(
      'an ownership change retires the waiting prompt instead of replaying '
      'it into a session the app no longer drives',
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('too late');
        studio.controls['s1'] = controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(supported: false),
        );
        desk.publishSession();
        await app.settle();
        for (final socket in studio.socketsFor('s1')) {
          socket.drop();
        }
        await app.pumpUntil(
          () => desk.attaches >= 2,
          reason: 'the reconnect',
          every: const Duration(seconds: 1),
        );
        await app.elapse(const Duration(seconds: 5));
        expect(desk.prompts, hasLength(1));
      },
    );
  });

  group('dictation', () {
    featureTest(
      'a dictation lands in the draft at the caret, twice in a row inserts '
      'each once, and nothing is ever sent by it',
      (f) async {
        final speech = FakeSpeechInput();
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        final desk = ComposerDesk(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch(overrides: [speech.providerOverride]);
        await app.openFromRoster('s1', cwd: '/work/studio');

        await app.type('draft tail');
        final field = f.tester.widget<TextField>(promptField);
        field.controller!.selection = const TextSelection.collapsed(offset: 5);
        speech.hear('spoken words');
        await app.settle();
        expect(app.composerText, 'draft spoken words tail');

        speech.hear('more');
        await app.settle();
        expect(app.composerText, contains('more'));
        expect(app.composerText.split('more'), hasLength(2));
        expect(desk.prompts, isEmpty);
      },
    );

    featureTest(
      'sending the app to the background cancels listening, and a '
      'recognizer failure is shown to the user',
      (f) async {
        final speech = FakeSpeechInput();
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        ComposerDesk(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch(overrides: [speech.providerOverride]);
        await app.openFromRoster('s1', cwd: '/work/studio');
        speech.listening();
        await app.settle();
        await app.background();
        expect(speech.cancelCalls, isPositive);
        expect(speech.current, isA<SpeechInputIdle>());
        await app.foreground();

        await app.tapKey('session-detail-voice-input-button');
        await app.tapKey('voice-policy-platform-service');
        speech.unavailable('Microphone permission was denied.');
        await app.settle();
        expect(find.text('Microphone permission was denied.'), findsOneWidget);
      },
    );
  });
}
