// F03a — Transcript rendering of message content: markdown, code, links,
// notices, injected context, steering rows and attachments.
// Long fixture strings and bidi controls are the data under test.
// ignore_for_file: lines_longer_than_80_chars
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/transcript_wire.dart';

TextStyle rootStyle(AppDriver app, String text) {
  final finder = find.textContaining(text);
  expect(finder, findsOneWidget, reason: text);
  return app.tester.widget<Text>(finder).textSpan!.style!;
}

void main() {
  group('markdown', () {
    featureTest('headings keep body size with hierarchy by weight, hide '
        'their markers and keep block order', (f) async {
      final app = await openTranscript(f, [
        answerRow(
          '# Hxalpha\n\n## Hxbeta\n\n### Hxgamma\n\nBody paragraph.\n\n'
          '- first item\n- second item\n\n> quoted line\n\nline one  \nline two',
          key: 'm1',
        ),
      ]);
      final theme = Theme.of(
        app.tester.element(find.textContaining('Hxalpha')),
      );
      final cap = theme.textTheme.titleSmall!.fontSize!;
      final h1 = rootStyle(app, 'Hxalpha');
      final h2 = rootStyle(app, 'Hxbeta');
      final h3 = rootStyle(app, 'Hxgamma');
      final body = rootStyle(app, 'Body paragraph.');
      // No heading is bigger than body text: H1 sits at titleSmall, the rest
      // at body size, and the hierarchy is carried by weight.
      expect(h1.fontSize, lessThanOrEqualTo(cap));
      expect(h2.fontSize, lessThanOrEqualTo(body.fontSize!));
      expect(h3.fontSize, lessThanOrEqualTo(body.fontSize!));
      expect(body.fontSize, theme.textTheme.bodyMedium!.fontSize);
      expect(h1.fontWeight!.value, greaterThan(h2.fontWeight!.value));
      expect(h2.fontWeight!.value, greaterThan(h3.fontWeight!.value));
      expect(
        h3.fontWeight!.value,
        greaterThan(body.fontWeight?.value ?? FontWeight.normal.value),
      );
      for (final marker in ['# Hx', '- first', '> quoted']) {
        expect(find.textContaining(marker), findsNothing, reason: marker);
      }
      app.expectInOrder([
        'Hxalpha',
        'Hxbeta',
        'Hxgamma',
        'Body paragraph.',
        'first item',
        'second item',
        'quoted line',
        'line one',
      ]);
      expect(find.byType(SelectableText), findsNothing);
    });

    for (final (label, heading, locale) in [
      (
        'English',
        '# A very long plan heading that must wrap onto at least two lines instead of overflowing the compact transcript width',
        'en',
      ),
      ('Chinese', '### ${'这是一个很长的计划标题' * 8}', 'zh'),
    ]) {
      featureTest('a long $label heading wraps at 320 dp', (f) async {
        final app = await openTranscript(
          f,
          [answerRow('# Hxshort\n\n$heading', key: 'm1')],
          viewport: FeatureViewport.narrowPhoneTall,
          locale: locale,
          deepLink: true,
        );
        final short = find.textContaining('Hxshort');
        final long = find.textContaining(
          heading.contains('这是') ? '这是一个很长' : 'very long plan heading',
        );
        expect(app.tester.getSize(long).width, lessThanOrEqualTo(320));
        expect(
          app.tester.getSize(long).height,
          greaterThan(app.tester.getSize(short).height),
        );
        expect(app.tester.takeException(), isNull);
      });
    }

    featureTest('a pipe table scrolls horizontally, its https links open, and '
        'malformed table input stays literal text', (f) async {
      final opened = <Uri>[];
      transcriptLinkOpener = opened.add;
      addTearDown(() => transcriptLinkOpener = null);
      final app = await openTranscript(f, [
        answerRow(
          '| Name | Role |\n|---|---|\n| Ada | Eng |\n| [open](https://example.org) | PM |',
          key: 'm1',
        ),
        answerRow('| Xa | Xb |\n| 1 | 2 |', key: 'm2'),
      ]);
      expect(find.byType(Table), findsOneWidget);
      expect(find.textContaining('Ada'), findsOneWidget);
      final scroller = app.tester.widget<SingleChildScrollView>(
        find
            .ancestor(
              of: find.byType(Table),
              matching: find.byType(SingleChildScrollView),
            )
            .first,
      );
      expect(scroller.scrollDirection, Axis.horizontal);
      await app.tap(find.text('open'));
      expect(opened, [Uri.parse('https://example.org')]);
      // No valid delimiter row: the lines stay prose, no second table.
      expect(find.textContaining('| Xa | Xb |'), findsOneWidget);
    });
  });

  group('code blocks', () {
    const dartFence = '```dart\nfinal answer = "s" + 42; // exact\ntrue\n```';
    const dartSource = 'final answer = "s" + 42; // exact\ntrue';
    const unknownSource = 'alpha < beta && punctuation::stays';
    const unterminated = 'void main() {\n  final value = "unterminated';

    for (final (platform, extent) in [
      (TargetPlatform.linux, 32.0),
      (TargetPlatform.android, 40.0),
    ]) {
      featureTest('a fenced block has a labelled header and a ${extent.toInt()} '
          'dp Copy that returns the exact source on ${platform.name}', (f) async {
        final app = await openTranscript(f, [
          answerRow(
            '$dartFence\n\n```unknown-v9\n$unknownSource\n```\n\n```dart\n$unterminated',
            key: 'm1',
          ),
        ]);
        final clipboard = app.captureClipboard();
        Text code(int i) => app.tester.widget<Text>(
          find.byKey(ValueKey('markdown-code-block-$i-code')),
        );
        expect(code(0).textSpan!.toPlainText(), dartSource);
        expect(code(1).textSpan!.toPlainText(), unknownSource);
        expect(code(2).textSpan!.toPlainText(), unterminated);
        // An unknown language keeps one literal run; a known one is tokenised.
        expect((code(1).textSpan! as TextSpan).children, hasLength(1));
        expect(
          (code(0).textSpan! as TextSpan).children!.length,
          greaterThan(1),
        );
        expect(
          app.tester
              .widget<Text>(
                find.byKey(const ValueKey('markdown-code-block-0-language')),
              )
              .data,
          'dart',
        );
        expect(
          app.tester
              .widget<Text>(
                find.byKey(const ValueKey('markdown-code-block-1-language')),
              )
              .data,
          'unknown-v9',
        );
        final header = find.byKey(
          const ValueKey('markdown-code-block-0-header'),
        );
        final copy = find.byKey(const ValueKey('markdown-code-block-0-copy'));
        expect(app.tester.getSize(header).height, extent);
        expect(app.tester.getSize(copy), Size.square(extent));
        await app.tap(copy);
        expect(clipboard, [dartSource]);
        expect(find.text('Code copied'), findsOneWidget);
        await app.tap(find.byKey(const ValueKey('markdown-code-block-1-copy')));
        expect(clipboard.last, unknownSource);
      }, platform: platform);
    }

    featureTest('a block over 128K characters stays exact and bounded', (
      f,
    ) async {
      final source = 'x' * (maxHighlightedTranscriptCodeUnits + 1);
      final app = await openTranscript(
        f,
        [
          answerRow('```dart\n$source\n```', key: 'm1'),
        ],
        viewport: FeatureViewport.narrowPhoneTall,
        deepLink: true,
      );
      final text = app.tester.widget<Text>(
        find.byKey(const ValueKey('markdown-code-block-0-code')),
      );
      expect((text.textSpan! as TextSpan).toPlainText(), source);
      expect((text.textSpan! as TextSpan).children, hasLength(1));
      expect(app.tester.takeException(), isNull);
    });
  });

  group('links', () {
    featureTest('an https link opens through the opener; paths and file:// '
        'targets are shown exactly and are not web links', (f) async {
      final opened = <Uri>[];
      transcriptLinkOpener = opened.add;
      addTearDown(() => transcriptLinkOpener = null);
      final app = await openTranscript(f, [
        answerRow('see [the site](https://example.com/a) now', key: 'm1'),
        answerRow('open [the file](/var/data/file) here', key: 'm2'),
        answerRow('read [notes](file:///etc/hosts) please', key: 'm3'),
        answerRow('open [/repo/README.md](/repo/README.md) now', key: 'm4'),
        answerRow('I updated src/main.rs:42 and lib/other.dart.', key: 'm5'),
      ]);
      final label = find.text('the site');
      expect(
        app.tester.widget<Text>(label).style?.decoration,
        TextDecoration.underline,
      );
      await app.tap(label);
      expect(opened, [Uri.parse('https://example.com/a')]);
      // A path or file:// target is shown as written, so the reader sees the
      // exact destination, and is not styled as a web link.
      for (final shown in [
        'the file (/var/data/file)',
        'notes (file:///etc/hosts)',
      ]) {
        final mention = find.byKey(ValueKey('transcript-file-mention-$shown'));
        expect(mention, findsOneWidget, reason: shown);
        expect(app.tester.widget<Text>(mention).data, shown);
        expect(
          app.tester.widget<Text>(mention).style?.decoration,
          isNot(TextDecoration.underline),
        );
      }
      // A label equal to its target is shown once.
      expect(find.text('/repo/README.md'), findsOneWidget);
      // A bare path in prose is never a link: it stays plain text.
      expect(
        find.textContaining('I updated src/main.rs:42 and lib/other.dart.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('transcript-file-mention-src/main.rs:42')),
        findsNothing,
      );
      expect(opened, hasLength(1));
    });
  });

  group('notices and error boxes', () {
    for (final mode in ['light', 'dark']) {
      featureTest('an interruption is red, a continuation or unknown notice is '
          'neutral, compaction is inline ($mode)', (f) async {
        final spec = themeSpecById(kDefaultThemeId);
        final tokens = mode == 'dark' ? spec.dark : spec.light;
        final app = await openTranscript(f, [
          userRow('Go', key: 'u1'),
          row('notice', {
            'message': 'Adapter-specific interruption copy',
            'semantic': {'kind': 'interruption', 'reason': 'generic'},
          }),
          row('notice', {
            'message': 'Adapter-specific repeated denial copy',
            'semantic': {
              'kind': 'interruption',
              'reason': 'automatic-approval-denied-repeatedly',
            },
          }),
          row('notice', {
            'message': 'Worker finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'turn-8',
            },
          }),
          row('notice', {
            'message':
                'Conversation interrupted — quoted by a lookup, not a marker.',
          }),
          row('history-reset', {
            'notice': 'Adapter-specific compaction copy',
            'semantic': {'kind': 'compaction'},
          }),
        ], themeMode: mode);
        Color? colorOf(String key) {
          // Every notice of this kind carries the same colour.
          final inlines = find.byKey(Key(key));
          expect(inlines, findsWidgets, reason: key);
          final colors = {
            for (var i = 0; i < inlines.evaluate().length; i++)
              app.tester
                  .widget<Text>(
                    find.descendant(
                      of: inlines.at(i),
                      matching: find.byType(Text),
                    ),
                  )
                  .style
                  ?.color,
          };
          expect(
            find.descendant(of: inlines, matching: find.byType(SelectableText)),
            findsNothing,
          );
          expect(colors, hasLength(1), reason: key);
          return colors.single;
        }

        expect(find.text('Interrupted'), findsOneWidget);
        expect(
          colorOf('session-transcript-interruption-inline'),
          tokens.statusError,
        );
        // The repeated automatic-approval denial is explained, not the adapter's words.
        expect(
          find.text(
            'Interrupted because automatic permission approval was denied repeatedly.',
          ),
          findsOneWidget,
        );
        expect(
          find.textContaining('Adapter-specific interruption copy'),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-transcript-interruption-inline')),
          findsNWidgets(2),
        );
        expect(find.text('Worker finished'), findsOneWidget);
        expect(
          app.tester
              .widget<Text>(
                find.descendant(
                  of: find.byKey(
                    const Key('session-transcript-continuation-inline'),
                  ),
                  matching: find.byType(Text),
                ),
              )
              .style
              ?.color,
          tokens.textSecondary,
        );
        expect(
          colorOf('session-transcript-notice-inline'),
          tokens.textSecondary,
        );
        expect(find.textContaining('quoted by a lookup'), findsOneWidget);
        expect(find.text('Compaction complete'), findsOneWidget);
        expect(
          colorOf('session-transcript-history-reset-inline'),
          tokens.textSecondary,
        );
        expect(
          find.textContaining('Adapter-specific compaction copy'),
          findsNothing,
        );
      });
    }

    for (final (locale, noDetail) in [
      ('en', 'No further detail was provided.'),
      ('zh', '未提供更多细节。'),
    ]) {
      featureTest('an error box shows its payload, or a localized no-detail '
          'fallback ($locale)', (f) async {
        final app = await openTranscript(f, [
          row('error', {'code': 'E_WRITE', 'message': 'Write failed'}),
          row('error'),
        ], locale: locale);
        expect(find.text('code: E_WRITE'), findsOneWidget);
        expect(find.text('message: Write failed'), findsOneWidget);
        expect(find.text(noDetail), findsOneWidget);
        expect(app.visibleText, isNot(contains('RAW-LEAK')));
      });
    }
  });

  group('injected context and steering', () {
    featureTest('injected context is collapsed with a human label, opens to '
        'its origin and material, and says when it was clipped', (f) async {
      final app = await openTranscript(
        f,
        [
          row('event', {
            'name': kContextInjectionEvent,
            'payload': {
              'source': '@deepseek-ai/dsh-system-prompt-with-a-name',
              'body': 'Clipped material of the reminder.',
              'truncated': true,
            },
          }),
          row('event', {
            'name': kContextInjectionEvent,
            'payload': {
              'source': 'system-reminder',
              'body': 'Auto permission mode is active.',
            },
          }),
          // An event that merely resembles it keeps the generic card.
          row('event', {
            'name': 'session.forked',
            'payload': {'from': 's-1'},
          }),
        ],
        viewport: FeatureViewport.phoneTall,
        deepLink: true,
      );
      final toggles = find.byKey(const Key('transcript-context-toggle'));
      expect(toggles, findsNWidgets(2));
      expect(find.text('Context'), findsNWidgets(2));
      // Collapsed: no material, no wrapper tags, no provider identifier.
      for (final hidden in [
        'Clipped material',
        'Auto permission mode',
        'deepseek',
        '<system-reminder>',
      ]) {
        expect(find.textContaining(hidden), findsNothing, reason: hidden);
      }
      expect(
        app.tester.getSize(toggles.first).height,
        greaterThanOrEqualTo(40),
      );
      await app.tester.tap(toggles.first);
      await app.settle();
      expect(find.textContaining('Clipped material'), findsOneWidget);
      expect(find.textContaining('deepseek'), findsOneWidget);
      expect(
        find.byKey(const Key('transcript-context-truncated')),
        findsOneWidget,
      );
      await app.tester.tap(toggles.last);
      await app.settle();
      expect(find.textContaining('Auto permission mode'), findsOneWidget);
      expect(
        find.byKey(const Key('transcript-context-truncated')),
        findsOneWidget,
        reason: 'a whole body claims no clip',
      );
      await app.tester.tap(toggles.first);
      await app.settle();
      expect(find.textContaining('Clipped material'), findsNothing);
      expect(app.tester.takeException(), isNull);
    });

    featureTest('a steering row is labelled, collapsed, opens to its message '
        'and route, and an empty steer is a generic event', (f) async {
      final app = await openTranscript(f, [
        userRow('Deploy it', key: 'u1'),
        row('event', {
          'name': kSteeringMessageEvent,
          'payload': {
            'text': 'use the staging database',
            'source': 'cosyncing-claude',
          },
        }),
        row('event', {
          'name': kSteeringMessageEvent,
          'payload': {'text': '   '},
        }),
      ]);
      expect(find.text('Sent from the app mid-turn'), findsOneWidget);
      expect(find.textContaining('use the staging database'), findsNothing);
      // The empty steer is not a steering row.
      expect(
        find.byKey(const Key('transcript-steering-toggle')),
        findsOneWidget,
      );
      expect(find.text('Event'), findsOneWidget);
      await app.tapKey('transcript-steering-toggle');
      expect(find.textContaining('use the staging database'), findsOneWidget);
      expect(find.text('cosyncing-claude'), findsOneWidget);
      // Left-aligned chrome, not a bubble on the user's side.
      expect(
        app.tester
            .getTopLeft(find.byKey(const Key('transcript-steering-toggle')))
            .dx,
        lessThan(app.tester.getTopLeft(find.textContaining('Deploy it')).dx),
      );
      await app.tapKey('transcript-steering-toggle');
      expect(find.textContaining('use the staging database'), findsNothing);
    });
  });

  group('attachments and shortened bodies', () {
    const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8'
        'BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    featureTest('a sent image previews inside its own bubble, a document is '
        'a chip, and an attachment-only prompt has no empty body', (f) async {
      final app = await openTranscript(f, [
        userRow('Look at this', key: 'u1'),
        row('file-artifact', {
          'artifactKey': 'artifact-screenshot.png',
          'name': 'screenshot.png',
          'mimeType': 'image/png',
          'url': png,
          'userMessageKey': 'u1',
        }),
        userRow('Here is the spec', key: 'u2'),
        row('file-artifact', {
          'artifactKey': 'artifact-spec.pdf',
          'name': 'spec.pdf',
          'mimeType': 'application/pdf',
          'url': 'https://broker.example/artifacts/spec.pdf',
          'size': 2048,
          'userMessageKey': 'u2',
        }),
        userRow('', key: 'u3'),
        row('file-artifact', {
          'artifactKey': 'artifact-only.pdf',
          'name': 'only.pdf',
          'mimeType': 'application/pdf',
          'userMessageKey': 'u3',
        }),
      ]);
      expect(find.byKey(const Key('user-attachment-image')), findsOneWidget);
      final width = app.tester.getSize(find.byType(Scaffold).first).width;
      expect(
        app.tester
            .getCenter(find.byKey(const Key('user-attachment-0')).first)
            .dx,
        greaterThan(width / 2),
      );
      expect(find.text('spec.pdf'), findsOneWidget);
      expect(find.text('2 KB'), findsOneWidget);
      expect(find.text('only.pdf'), findsOneWidget);
      expect(inside(app.transcriptView, find.text('')), findsNothing);
    });

    featureTest('an agent artifact is its own row, badged "Sent to you" only '
        'when flagged', (f) async {
      await openTranscript(f, [
        row('file-artifact', {
          'artifactKey': 'a1',
          'name': 'sent.pdf',
          'mimeType': 'application/pdf',
          'size': 1240,
          'proactive': true,
        }),
        row('file-artifact', {
          'artifactKey': 'a2',
          'name': 'written.pdf',
          'mimeType': 'application/pdf',
          'size': 1240,
        }),
        row('file-artifact', {
          'artifactKey': 'a3',
          'name': 'notsent.pdf',
          'mimeType': 'application/pdf',
          'proactive': false,
        }),
      ]);
      expect(find.text('sent.pdf'), findsOneWidget);
      expect(find.text('written.pdf'), findsOneWidget);
      expect(find.text('Sent to you'), findsOneWidget);
    });

    featureTest("a broker-shortened body states it in the app's own words; an "
        'untruncated body states nothing', (f) async {
      final app = await openTranscript(f, [
        userRow('First', key: 'u1'),
        answerRow(
          'Beginning of a very large answer',
          key: 'a1',
          extra: {'bodyTruncated': true},
        ),
        userRow(
          'Beginning of a very large prompt',
          key: 'u2',
          extra: {'bodyTruncated': true},
        ),
        row('thinking', {
          'key': 'r1',
          'text': 'Beginning of a very long reasoning trace',
          'bodyTruncated': true,
        }),
        answerRow('Complete answer', key: 'a2'),
      ]);
      expect(
        find.byKey(const Key('model-output-body-truncated')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('user-message-body-truncated')),
        findsOneWidget,
      );
      expect(
        find.text('Shortened to fit the history window.'),
        findsNWidgets(2),
      );
      expect(find.textContaining('truncated by cosyncing'), findsNothing);
      // The thinking row's note sits behind its expander.
      expect(find.byKey(const Key('thinking-body-truncated')), findsNothing);
      await app.tapKey('conversation-thinking-toggle');
      expect(find.byKey(const Key('thinking-body-truncated')), findsOneWidget);
      expect(
        find.text('Shortened to fit the history window.'),
        findsNWidgets(3),
      );
    });
  });
}
