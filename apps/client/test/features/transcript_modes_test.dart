// F03a — Transcript detail modes, the message menu, and model labels on the
// roster: what the user sees for the same history under each tool-display
// setting, and what a right click offers on a row.
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:flutter/gestures.dart'
    show PointerDeviceKind, kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/settings_driver.dart';
import '../support/feature/transcript_wire.dart';

List<Map<String, Object?>> mixedHistory() => [
  userRow('Make a report', key: 'u1'),
  row('thinking', {'text': 'Reasoning about the report', 'key': 'th1'}),
  toolCallRow(
    'c1',
    extra: {
      'args': {'command': 'flutter test'},
    },
  ),
  toolResultRow('c1', extra: {'output': 'all green'}),
  answerRow('Checking the files first', key: 'a0', final_: false),
  row('permission-request', {
    'requestId': 'p1',
    'tool': 'shell',
    'title': 'Allow rm -rf build',
  }),
  row('permission-resolved', {'requestId': 'p1', 'decision': 'approve'}),
  row('permission-resolved', {'requestId': 'ghost-p', 'decision': 'reject'}),
  answerRow('Report ready', key: 'a1'),
  row('file-artifact', {
    'artifactKey': 'report-file',
    'name': 'report.zip',
    'mimeType': 'application/zip',
    'url': 'data:application/zip;base64,UEs=',
  }),
];

void main() {
  for (final viewport in [
    FeatureViewport.desktopTall,
    FeatureViewport.phoneTall,
  ]) {
    featureTest(
      'tool visibility follows global default until a session '
      'explicitly overrides it (${viewport.name})',
      (f) async {
        var app = await openTranscript(f, mixedHistory(), viewport: viewport);
        final sessionLocation = app.router.routeInformationProvider.value.uri
            .toString();
        if (viewport == FeatureViewport.phoneTall) {
          await app.tapKey('session-detail-view-menu');
          final toggle = find.byKey(
            const Key('session-tool-visibility-toggle'),
          );
          expect(
            app.tester.widget<CheckedPopupMenuItem<dynamic>>(toggle).checked,
            isFalse,
          );
          await app.dismissModal();
        }
        app.router.go(displaySettingsRoute);
        await app.settle();
        await app.toggle('tools-hide-default');
        app.router.go(sessionLocation);
        await app.settle();
        expect(find.byKey(const ValueKey('tool-c1-details')), findsNothing);
        await app.tapKey('session-detail-view-menu');
        if (viewport == FeatureViewport.phoneTall) {
          final toggle = find.byKey(
            const Key('session-tool-visibility-toggle'),
          );
          expect(
            app.tester.widget<CheckedPopupMenuItem<dynamic>>(toggle).checked,
            isTrue,
          );
          await app.tap(toggle);
        } else {
          await app.pick('session-tool-visibility', 'Show tool calls');
        }
        expect(find.byKey(const ValueKey('tool-c1-details')), findsOneWidget);
        app.router.go(displaySettingsRoute);
        await app.settle();
        await app.toggle('tools-hide-default');
        await app.toggle('tools-hide-default');
        app.router.go(sessionLocation);
        await app.settle();
        expect(find.byKey(const ValueKey('tool-c1-details')), findsOneWidget);
        app = await f.restart(initialLocation: sessionLocation);
        expect(find.byKey(const ValueKey('tool-c1-details')), findsOneWidget);
        app.router.go(displaySettingsRoute);
        await app.settle();
        await app.tap(find.text('Reset session overrides'));
        await app.tap(find.text('Undo'));
        app.router.go(sessionLocation);
        await app.settle();
        expect(find.byKey(const ValueKey('tool-c1-details')), findsOneWidget);
        if (viewport == FeatureViewport.phoneTall) {
          app.router.go(displaySettingsRoute);
          await app.settle();
          await app.tap(find.text('Reset session overrides'));
          app.router.go(sessionLocation);
          await app.settle();
          await app.tapKey('session-detail-view-menu');
          final toggle = find.byKey(
            const Key('session-tool-visibility-toggle'),
          );
          expect(
            app.tester.widget<CheckedPopupMenuItem<dynamic>>(toggle).checked,
            isTrue,
          );
          await app.dismissModal();
        } else {
          await app.tapKey('session-detail-view-menu');
          await app.pick('session-tool-visibility', 'Use default (Hidden)');
        }
        expect(find.byKey(const ValueKey('tool-c1-details')), findsNothing);
        expect(find.text('Report ready'), findsOneWidget);
        expect(find.text('report.zip'), findsOneWidget);
        if (viewport == FeatureViewport.phoneTall) {
          app.router.go(displaySettingsRoute);
          await app.settle();
          await app.toggle('tools-hide-default');
          app.router.go(sessionLocation);
          await app.settle();
          expect(find.byKey(const ValueKey('tool-c1-details')), findsOneWidget);
          await app.tapKey('session-detail-view-menu');
          await app.tapKey('session-tool-visibility-toggle');
          expect(find.byKey(const ValueKey('tool-c1-details')), findsNothing);
          await app.tapKey('session-detail-view-menu');
          final toggle = find.byKey(
            const Key('session-tool-visibility-toggle'),
          );
          expect(
            app.tester.widget<CheckedPopupMenuItem<dynamic>>(toggle).checked,
            isTrue,
          );
          await app.dismissModal();
        }
      },
    );
  }

  group('tool display modes', () {
    final cases = <({String mode, bool tool, bool thinking, bool preamble})>[
      (mode: 'responsive', tool: true, thinking: true, preamble: true),
      (mode: 'tier-1-only', tool: true, thinking: true, preamble: true),
      (
        mode: 'final-messages-only',
        tool: false,
        thinking: false,
        preamble: false,
      ),
    ];
    for (final c in cases) {
      featureTest('${c.mode}: what stays and what folds away', (f) async {
        final app = await openTranscript(
          f,
          mixedHistory(),
          toolDisplay: c.mode,
        );
        // Prompts, the final answer and delivered files are in every mode.
        expect(find.text('Make a report'), findsOneWidget);
        expect(find.text('Report ready'), findsOneWidget);
        expect(find.text('report.zip'), findsOneWidget);
        expect(
          find.byKey(
            const Key('session-detail-chat-artifact-download-report-file'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('tool-c1-details')).evaluate().isNotEmpty,
          c.tool,
        );
        expect(find.text('Reasoning about the report'), findsNothing);
        expect(
          find.text('Checking the files first').evaluate().isNotEmpty,
          c.preamble,
        );
        // A resolution is a state change on its request: never its own row,
        // paired or orphaned [REG CR2].
        expect(find.text('Allow rm -rf build'), findsWidgets);
        expect(find.textContaining('ghost-p'), findsNothing);
        expect(app.tester.takeException(), isNull);
      });
    }
  });

  group('streaming rows and long payloads', () {
    String body(String key, int chunk) => [
      'First paragraph of $key.',
      for (var part = 1; part <= chunk; part++) 'Paragraph $part of $key.',
    ].join('\n\n');

    featureTest('a thinking row opened while it streams stays open', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        [
          userRow('Think', key: 'u1'),
          row('thinking', {'key': 't1', 'text': body('t1', 0)}),
        ],
        broker: studio,
      );
      await app.tapKey('conversation-thinking-toggle');
      expect(find.textContaining('First paragraph of t1'), findsOneWidget);

      for (var chunk = 1; chunk <= 3; chunk++) {
        await app.live(
          studio,
          row('thinking', {'key': 't1', 'text': body('t1', chunk)}),
        );
      }
      expect(find.textContaining('First paragraph of t1'), findsOneWidget);
      expect(find.textContaining('Paragraph 3 of t1'), findsOneWidget);
    });

    featureTest('Show all restores the exact tool payload and can return', (
      f,
    ) async {
      final output = List.filled(5000, 'x').join();
      final app = await openTranscript(f, [
        toolCallRow('long-result'),
        toolResultRow('long-result', extra: {'result': output}),
      ]);
      await app.toggleTool('long-result');

      Text detail() => app.tester.widget<Text>(
        find.byKey(const ValueKey('tool-detail-result')),
      );
      expect(detail().data, isNot(contains(output)));
      await app.tap(find.text('Show all'));
      expect(detail().data, 'result: $output');
      await app.tap(find.text('Show preview'));
      expect(detail().data, isNot('result: $output'));
    });
  });

  group('OpenCode retry status', () {
    Map<String, Object?> retrying(String detail) => {
      'type': 'status',
      'status': 'running',
      'detail': detail,
    };

    featureTest('shows the provider detail while retrying and clears when '
        'output resumes', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        [userRow('Go', key: 'u1')],
        tool: 'opencode',
        broker: studio,
        deepLink: true,
      );
      const band = Key('session-opencode-retry-status');
      expect(find.byKey(band), findsNothing);

      await app.live(studio, retrying('rate limited, attempt 2'));
      expect(find.byKey(band), findsOneWidget);
      expect(find.text('OpenCode is retrying.'), findsOneWidget);
      expect(
        find.text('Provider detail: rate limited, attempt 2'),
        findsOneWidget,
      );

      await app.live(studio, answerRow('Back again', key: 'a1'));
      expect(find.byKey(band), findsNothing);
    });

    featureTest('another agent never shows the band', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        [userRow('Go', key: 'u1')],
        broker: studio,
      );
      await app.live(studio, retrying('rate limited'));
      expect(
        find.byKey(const Key('session-opencode-retry-status')),
        findsNothing,
      );
    });
  });

  group('message menu', () {
    Future<void> openMenu(AppDriver app, String id) async {
      await app.tester.tap(
        find.byKey(ValueKey('session-message-context-$id')),
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await app.settle();
    }

    featureTest('Copy text and Details act on the row', (f) async {
      final app = await openTranscript(f, [
        userRow('Fork this point', key: 'u1', extra: {'id': 'message-42'}),
      ], setup: (b) => b.agents = [fakeAgent(canFork: true)]);
      final copied = app.captureClipboard();

      await openMenu(app, 'u1');
      expect(find.text('Copy text'), findsOneWidget);
      expect(find.text('Fork from here'), findsOneWidget);
      await app.tap(find.text('Copy text'));
      expect(copied, ['Fork this point']);

      await openMenu(app, 'u1');
      await app.tap(find.text('Details'));
      expect(
        find.byKey(const Key('session-message-details-dialog')),
        findsOneWidget,
      );
      expect(find.text('Type: user-message'), findsWidgets);
      expect(find.text('Message ID: message-42'), findsWidgets);
    });

    for (final c in <({String name, bool canFork, String? origin, bool fork})>[
      (name: 'a plain session', canFork: true, origin: null, fork: true),
      (
        name: 'an agent without fork',
        canFork: false,
        origin: null,
        fork: false,
      ),
      (
        name: 'an agent-spawned session',
        canFork: true,
        origin: 'subagent',
        fork: false,
      ),
      (
        name: 'an exec-origin session',
        canFork: true,
        origin: 'exec',
        fork: true,
      ),
    ]) {
      featureTest(
        'Fork from here on ${c.name}: ${c.fork ? 'offered' : 'hidden'}',
        (
          f,
        ) async {
          final studio = f.network.add('http://studio.test:7734')
            ..agents = [fakeAgent(canFork: c.canFork)]
            ..addSession(
              's1',
              'Fix login',
              cwd: '/work/studio',
              origin: c.origin,
              parentThreadId: c.origin == 'subagent' ? 'parent' : null,
            );
          final app = await openTranscript(
            f,
            [
              userRow('Hello', key: 'u1', extra: {'id': 'm1'}),
            ],
            broker: studio,
            deepLink: true,
          );
          await openMenu(app, 'u1');
          expect(find.text('Copy text'), findsOneWidget);
          expect(find.text('Details'), findsOneWidget);
          expect(find.text('Fork from here').evaluate().isNotEmpty, c.fork);
        },
      );
    }
  });

  group('layout of boxes and artifacts', () {
    final longToken = 'x' * 90;
    List<Map<String, Object?>> boxes() => [
      userRow('Run it ${'y' * 90}', key: 'u1'),
      row('error', {'code': 'E_WRITE', 'message': 'Write failed $longToken'}),
      row('permission-request', {
        'requestId': 'p1',
        'tool': 'shell',
        'title': 'Allow rm -rf build $longToken',
      }),
      row('question-request', {
        'requestId': 'q1',
        'question': 'Which server should run this? $longToken',
      }),
      row('file-artifact', {
        'artifactKey': 'f1',
        'name': 'a-very-long-report-name-$longToken.zip',
        'mimeType': 'application/zip',
        'url': 'data:application/zip;base64,UEs=',
      }),
      answerRow('Done ${'z' * 90}', key: 'a1'),
    ];

    for (final c in <({FeatureViewport size, String locale, double scale})>[
      (size: FeatureViewport.narrowPhoneTall, locale: 'en', scale: 1),
      (size: FeatureViewport.narrowPhoneTall, locale: 'zh', scale: 2),
      (size: FeatureViewport.phoneTall, locale: 'en', scale: 2),
      (size: FeatureViewport.phoneTall, locale: 'zh', scale: 1),
      (size: FeatureViewport.desktopTall, locale: 'en', scale: 1),
      (size: FeatureViewport.desktopTall, locale: 'zh', scale: 2),
    ]) {
      featureTest(
        'error, permission, question and artifact boxes stay inside '
        '${c.size.size.width.toInt()} dp (${c.locale}, text x${c.scale})',
        (f) async {
          final app = await openTranscript(
            f,
            boxes(),
            viewport: c.size,
            locale: c.locale,
            systemTextScale: c.scale,
            deepLink: true,
          );
          expect(app.tester.takeException(), isNull);
          final width = c.size.size.width;
          for (final text in find.byType(Text).evaluate()) {
            final box = app.tester.getRect(find.byWidget(text.widget));
            expect(
              box.left,
              greaterThanOrEqualTo(-0.5),
              reason: '${text.widget}',
            );
            expect(
              box.right,
              lessThanOrEqualTo(width + 0.5),
              reason: '${text.widget}',
            );
          }
          for (final needle in ['Allow rm -rf build', 'Which server']) {
            expect(find.textContaining(needle), findsWidgets, reason: needle);
          }
        },
      );
    }
  });

  group('model labels on the roster', () {
    final cases = <({String name, Map<String, Object?> extra, String? label})>[
      (
        name: 'an adapter-authored label wins',
        extra: {
          'currentModel': {
            'providerID': 'anthropic',
            'modelID': 'claude-opus-4-8-20260701',
            'label': 'Opus 4.8',
          },
        },
        label: 'Opus 4.8',
      ),
      (
        name: 'a technical id derives a compact family label',
        extra: {
          'currentModel': {'providerID': 'openai', 'modelID': 'gpt-5.4-codex'},
        },
        label: 'GPT-5.4',
      ),
      (
        name: 'release dates are ignored',
        extra: {
          'currentModel': {
            'providerID': 'provider',
            'modelID': 'claude-3-7-sonnet-20250219',
          },
        },
        label: 'Sonnet 3.7',
      ),
      (
        name: 'a legacy model string still derives',
        extra: {'model': 'claude-sonnet-4-6'},
        label: 'Sonnet 4.6',
      ),
      (
        name: 'a provider-qualified id is never printed as a label [REG P2/P8]',
        extra: {'model': 'kimi-code/kimi-for-coding'},
        label: null,
      ),
      (
        name: 'an authored label is shown for a provider-qualified id',
        extra: {
          'currentModel': {
            'providerID': 'managed:kimi-code',
            'modelID': 'kimi-code/k3-256k',
            'label': 'K3-256k',
          },
        },
        label: 'K3-256k',
      ),
    ];
    for (final c in cases) {
      featureTest(c.name, (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession(
            's1',
            'Fix login',
            cwd: '/work/studio',
            extra: c.extra,
          );
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        // The row's tooltip carries the harness and model line.
        final text = app.tester
            .widget<Tooltip>(
              find.ancestor(
                of: find.descendant(
                  of: app.row('s1'),
                  matching: find.text('Fix login'),
                ),
                matching: find.byType(Tooltip),
              ),
            )
            .message!;
        if (c.label case final label?) {
          expect(text, contains(label));
        } else {
          // Only the technical "Model:" line carries the raw id, never the
          // human subtitle.
          final lines = text.split('\n');
          expect(lines[1], isNot(contains('kimi')));
          expect(lines, contains('Model: kimi-code/kimi-for-coding'));
        }
      });
    }
  });
}
