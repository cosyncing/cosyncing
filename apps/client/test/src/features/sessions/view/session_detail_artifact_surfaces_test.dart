// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage artifact surfaces', () {
    for (final themeCase in <({String name, ThemeData theme})>[
      (
        name: 'light',
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
      ),
      (
        name: 'dark',
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).dark,
          Brightness.dark,
        ),
      ),
    ]) {
      testWidgets('Chat Download action lays out in ${themeCase.name} theme', (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            theme: themeCase.theme,
            events: const [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-theme',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'theme.txt',
                    'artifactKey': 'theme-artifact',
                    'fetchUrl':
                        'http://127.0.0.1:7734/api/sessions/claude/session-1/'
                        'artifact/theme-artifact?expires=1&sig=exact',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        final download = find.byKey(
          const Key(
            'session-detail-chat-artifact-download-theme-artifact',
          ),
        );
        expect(download, findsOneWidget);
        expect(
          find.ancestor(of: download, matching: find.byType(Card)),
          findsOneWidget,
          reason: 'Download belongs to the file-artifact card action region',
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets(
      'disables fork/clone actions when broker capabilities are unavailable',
      (tester) async {
        final brokerClient = FakeBrokerClient(
          agents: [
            fakeAgentInfo(
              canFork: false,
              canClone: false,
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        final forkButton = find.byKey(
          const Key('session-detail-fork-button'),
        );
        final cloneButton = find.byKey(
          const Key('session-detail-clone-button'),
        );
        expect(
          tester.widget<ListTile>(forkButton).enabled,
          isFalse,
        );
        expect(
          tester.widget<ListTile>(cloneButton).enabled,
          isFalse,
        );
      },
    );

    testWidgets(
      'fork action sets success status and records broker call when pressed',
      (tester) async {
        final brokerClient = FakeBrokerClient(
          agents: [fakeAgentInfo(canClone: false)],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-fork-button'),
        );
        final forkButton = find.byKey(const Key('session-detail-fork-button'));
        await tester.tap(forkButton);
        await tester.pumpAndSettle();

        expect(brokerClient.forkSessionCount, 1);
        expect(
          find.textContaining('Forked session: Forked Session'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'clone action shows error status when broker clone fails',
      (tester) async {
        final brokerClient =
            FakeBrokerClient(
                agents: [fakeAgentInfo(canFork: false)],
              )
              ..cloneError = const BrokerException(
                message: 'Clone blocked',
                statusCode: 500,
              );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-clone-button'),
        );
        final cloneButton = find.byKey(
          const Key('session-detail-clone-button'),
        );
        await tester.tap(cloneButton);
        await tester.pumpAndSettle();

        expect(brokerClient.cloneSessionCount, 1);
        final cloneStatusText = tester.widget<SelectableText>(
          find.byKey(const Key('session-detail-clone-session-status')),
        );
        expect(
          cloneStatusText.data,
          contains("Couldn't duplicate this session."),
        );
        expect(cloneStatusText.data, isNot(contains('Clone blocked')));
      },
    );

    testWidgets(
      'disables fork and clone when no active broker profile is selected',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            withActiveBrokerClient: false,
          ),
        );
        await tester.pumpAndSettle();

        // Session actions sit near the bottom of a lazy ListView, so they are
        // only built once scrolled into view. Reaching them by tab-open alone
        // worked until the "Usage & context" section was added above them.
        final forkButton = find.byKey(const Key('session-detail-fork-button'));
        final cloneButton = find.byKey(
          const Key('session-detail-clone-button'),
        );
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-fork-button'),
        );
        expect(tester.widget<ListTile>(forkButton).enabled, isFalse);
        expect(tester.widget<ListTile>(cloneButton).enabled, isFalse);
      },
    );

    testWidgets(
      'shows terminal and artifact summary surfaces from live/replayed events',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.terminalOutput,
                  id: 'term-live',
                  raw: {
                    'type': 'terminal-output',
                    'command': 'printf live',
                    'output': 'live result',
                  },
                ),
              ),
              const MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-live',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'live.txt',
                    'path': '/tmp/live.txt',
                    'size': 12,
                  },
                ),
              ),
              const HistoryWireEvent(
                messages: [
                  AgentMessage(
                    type: AgentMessageType.terminalOutput,
                    id: 'term-history',
                    raw: {
                      'type': 'terminal-output',
                      'command': 'cat history.log',
                      'output': 'history result',
                    },
                  ),
                  AgentMessage(
                    type: AgentMessageType.fileArtifact,
                    id: 'artifact-history',
                    raw: {
                      'type': 'file-artifact',
                      'name': 'history.md',
                      'filePath': '/tmp/history.md',
                      'size': 40,
                    },
                  ),
                ],
                cursor: 'cursor-1',
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-terminal',
        );
        expect(
          find.widgetWithText(Card, 'Terminal output (2)'),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const Key('session-detail-tab-panel-terminal')),
            matching: find.byType(SelectableText),
          ),
          findsWidgets,
        );
        expect(find.textContaining('printf live'), findsOneWidget);
        expect(find.textContaining('cat history.log'), findsOneWidget);
        expect(find.text('live result'), findsOneWidget);

        final terminalSummaryOutput = tester
            .widgetList<SelectableText>(find.byType(SelectableText))
            .firstWhere((widget) => widget.data == 'live result');
        expect(terminalSummaryOutput.style?.fontFamily, 'monospace');

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );
        expect(
          find.widgetWithText(Card, 'File artifacts (2)'),
          findsOneWidget,
        );
        expect(find.text('live.txt'), findsOneWidget);
        expect(find.text('/tmp/live.txt'), findsOneWidget);
        expect(find.text('history.md'), findsOneWidget);
        expect(find.text('/tmp/history.md'), findsOneWidget);
      },
    );

    testWidgets(
      'shows empty terminal and artifact states when no corresponding '
      'messages exist',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.status,
                  raw: {'type': 'status', 'status': 'idle'},
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        // Status is always a destination; Terminal only appears once the
        // session has produced output.
        await withSessionDetailViewMenu(tester, () async {
          expect(
            find.byKey(const Key('session-detail-view-item-status')),
            findsOneWidget,
          );
          expect(
            find.byKey(const Key('session-detail-view-item-terminal')),
            findsNothing,
          );
        });

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );
        expect(find.text('Produced by agent'), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-artifact-surface')),
          findsNothing,
        );
      },
    );

    testWidgets('shows the typed cursor gap without legacy recovery chrome', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            HistoryWireEvent(
              reset: true,
              messages: [],
              gap: HistoryGap(
                code: 'HISTORY_CURSOR_DIVERGED',
                message: 'The cursor prefix changed.',
              ),
              truncated: HistoryTruncation(shown: 500, total: 1600),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-history-recovery-notice')),
        findsOneWidget,
      );
      expect(find.text('History resynced'), findsNothing);
      expect(find.textContaining('HISTORY_CURSOR_DIVERGED'), findsOneWidget);
      expect(find.textContaining('newest 500 of 1600 messages'), findsNothing);
    });

    testWidgets(
      'adds terminal and artifact summary rows with no input/action controls',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.terminalOutput,
                  id: 'term-live',
                  raw: {
                    'type': 'terminal-output',
                    'command': 'printf check',
                    'output': 'line',
                  },
                ),
              ),
              const MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-live',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'check.txt',
                    'path': '/tmp/check.txt',
                    'size': 12,
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-terminal',
        );
        final terminalSurface = find.widgetWithText(
          Card,
          'Terminal output (1)',
        );
        expect(terminalSurface, findsOneWidget);
        expect(
          find.descendant(
            of: terminalSurface,
            matching: find.byType(TextField),
          ),
          findsNothing,
        );
        expect(
          find.descendant(
            of: terminalSurface,
            matching: find.byType(IconButton),
          ),
          findsNothing,
        );

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );
        final artifactSurface = find.widgetWithText(
          Card,
          'File artifacts (1)',
        );
        expect(artifactSurface, findsOneWidget);
        expect(
          find.descendant(
            of: artifactSurface,
            matching: find.byType(TextField),
          ),
          findsNothing,
        );
        expect(
          find.descendant(
            of: artifactSurface,
            matching: find.byType(IconButton),
          ),
          findsNothing,
        );
      },
    );

    testWidgets(
      'shows artifact action buttons only for downloadable and'
      ' previewable items',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-fetch-preview',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'artifact-preview.html',
                    'path': '/tmp/artifact-preview.html',
                    'mimeType': 'text/html',
                    'size': 64,
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/ref-1',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        final artifactSurface = find.widgetWithText(
          Card,
          'File artifacts (1)',
        );
        const downloadButtonKey = Key(
          'session-detail-artifact-action-download-0-artifact-preview.html',
        );
        const previewButtonKey = Key(
          'session-detail-artifact-action-preview-0-artifact-preview.html',
        );

        final downloadButton = tester.widget<OutlinedButton>(
          find.byKey(downloadButtonKey),
        );
        final previewButton = tester.widget<OutlinedButton>(
          find.byKey(previewButtonKey),
        );

        expect(downloadButton.onPressed, isNotNull);
        expect(previewButton.onPressed, isNotNull);
        expect(
          find.descendant(
            of: find.byKey(downloadButtonKey),
            matching: find.text('Download'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(previewButtonKey),
            matching: find.text('Preview'),
          ),
          findsOneWidget,
        );
        expect(artifactSurface, findsOneWidget);
      },
    );

    testWidgets(
      'Chat artifact card exposes Download and saves exact reference',
      (
        tester,
      ) async {
        final fileService = FakeSessionArtifactFileService()
          ..mockCachedFile = const SessionArtifactCachedFile(
            cachedFilePath: '/tmp/cache/chat-report.txt',
            fileName: 'chat-report.txt',
            contentType: 'text/plain',
            byteLength: 11,
            artifactKey: 'chat-artifact-key',
            contentHash: 'chat-version',
          )
          ..exportedPath = '/tmp/exported/chat-report.txt';

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            artifactFileService: fileService,
            events: const [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-chat-download',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'chat-report.txt',
                    'mimeType': 'text/plain',
                    'artifactKey': 'chat-artifact-key',
                    'contentHash': 'chat-version',
                    'fetchUrl':
                        'http://127.0.0.1:7734/api/sessions/claude/session-1/'
                        'artifact/chat-artifact-key?expires=1&sig=exact',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        const actionKey = Key(
          'session-detail-chat-artifact-download-chat-artifact-key',
        );
        final action = tester.widget<TextButton>(find.byKey(actionKey));
        expect(action.onPressed, isNotNull);
        expect(
          find.descendant(
            of: find.byKey(actionKey),
            matching: find.text('Download'),
          ),
          findsOneWidget,
        );

        await tester.tap(find.byKey(actionKey));
        await tester.pumpAndSettle();
        expect(fileService.cacheCallCount, 1);
        expect(fileService.exportCallCount, 1);
        expect(find.text('Saved'), findsOneWidget);
      },
    );

    testWidgets(
      'inline Chat artifact stays downloadable without network fetch',
      (
        tester,
      ) async {
        final fileService = FakeSessionArtifactFileService()
          ..exportedPath = '/tmp/exported/inline.txt';
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            artifactFileService: fileService,
            events: const [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-chat-inline',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'inline.txt',
                    'url': 'data:text/plain;base64,aW5saW5l',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        const actionKey = Key(
          'session-detail-chat-artifact-download-inline.txt',
        );
        expect(
          tester.widget<TextButton>(find.byKey(actionKey)).onPressed,
          isNotNull,
        );
        await tester.tap(find.byKey(actionKey));
        await tester.pumpAndSettle();
        expect(fileService.cacheCallCount, 1);
        expect(fileService.exportCallCount, 1);
      },
    );

    testWidgets(
      'workspace browser failure leaves Chat download enabled and retryable',
      (tester) async {
        final brokerClient = FakeBrokerClient()
          ..fsListError = const BrokerException(
            message: 'Workspace listing failed',
            statusCode: 503,
          );
        final fileService = FakeSessionArtifactFileService()
          ..remainingCacheFailures = 1
          ..exportedPath = '/tmp/exported/retry.txt';
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            brokerClient: brokerClient,
            artifactFileService: fileService,
            events: const [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-chat-retry',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'retry.txt',
                    'artifactKey': 'retry-artifact',
                    'contentHash': 'retry-version',
                    'fetchUrl':
                        'http://127.0.0.1:7734/api/sessions/claude/session-1/'
                        'artifact/retry-artifact?expires=1&sig=exact',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(tester, 'session-detail-tab-files');
        expect(
          find.byKey(const Key('session-detail-files-error-state')),
          findsOneWidget,
        );
        await openSessionDetailTestTab(tester, 'session-detail-tab-chat');

        const actionKey = Key(
          'session-detail-chat-artifact-download-retry-artifact',
        );
        expect(
          tester.widget<TextButton>(find.byKey(actionKey)).onPressed,
          isNotNull,
        );
        await tester.tap(find.byKey(actionKey));
        await tester.pumpAndSettle();
        expect(find.text('The file action failed. Try again.'), findsOneWidget);
        expect(
          find.text(
            "The session couldn't update. "
            'Check the Broker connection and try again.',
          ),
          findsNothing,
        );

        // The same exact action is the retry surface. The transient backend
        // failure is gone, so it completes without changing broker/session.
        await tester.tap(find.byKey(actionKey));
        await tester.pumpAndSettle();
        expect(fileService.cacheCallCount, 2);
        expect(fileService.exportCallCount, 1);
        expect(find.text('Saved'), findsOneWidget);
      },
    );

    testWidgets('Chat artifact action and error are localized in Chinese', (
      tester,
    ) async {
      final fileService = FakeSessionArtifactFileService()
        ..remainingCacheFailures = 1;
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          locale: const Locale('zh'),
          artifactFileService: fileService,
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.fileArtifact,
                id: 'artifact-chat-zh',
                raw: {
                  'type': 'file-artifact',
                  'name': 'zh.txt',
                  'url': 'data:text/plain;base64,emg=',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      const actionKey = Key('session-detail-chat-artifact-download-zh.txt');
      expect(
        find.descendant(of: find.byKey(actionKey), matching: find.text('下载')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(actionKey));
      await tester.pumpAndSettle();
      expect(find.text('文件操作失败。请重试。'), findsOneWidget);
      expect(find.text('技术详情'), findsOneWidget);
    });

    testWidgets(
      'shows export-attachment metadata and keeps download-only behavior',
      (tester) async {
        const descriptorExpiresAt = 1719000000000;
        final expiryLabel = DateTime.fromMillisecondsSinceEpoch(
          descriptorExpiresAt,
          isUtc: true,
        ).toIso8601String();

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-export',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'transcript.html',
                    'mimeType': 'text/html',
                    'deliveryClass': 'export-attachment',
                    'format': 'html',
                    'redactionSummary': 'Redacted user identifiers',
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/transcript',
                    'expiresAt': descriptorExpiresAt,
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        const downloadButtonKey = Key(
          'session-detail-artifact-action-download-0-transcript.html',
        );
        const previewButtonKey = Key(
          'session-detail-artifact-action-preview-0-transcript.html',
        );

        final downloadButton = tester.widget<OutlinedButton>(
          find.byKey(downloadButtonKey),
        );

        expect(find.text('Download-only export'), findsOneWidget);
        expect(find.text('Format: html'), findsOneWidget);
        expect(
          find.text('Redaction: Redacted user identifiers'),
          findsOneWidget,
        );
        expect(find.text('Expires: $expiryLabel'), findsOneWidget);
        expect(downloadButton.onPressed, isNotNull);
        expect(find.byKey(previewButtonKey), findsNothing);
      },
    );

    testWidgets(
      'shows Preview for HTML artifact when deliveryClass is missing',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-missing-delivery',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'browser-preview.html',
                    'mimeType': 'text/html',
                    'path': '/tmp/browser-preview.html',
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/browser-preview',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        const previewButtonKey = Key(
          'session-detail-artifact-action-preview-0-browser-preview.html',
        );

        final previewButton = tester.widget<OutlinedButton>(
          find.byKey(previewButtonKey),
        );

        expect(find.text('Download'), findsOneWidget);
        expect(previewButton.onPressed, isNotNull);
      },
    );

    testWidgets(
      'shows inline data URL action with fetch action label',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-inline',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'inline-snippet.txt',
                    'url': 'data:text/plain;base64,SGVsbG8=',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        const downloadButtonKey = Key(
          'session-detail-artifact-action-download-0-inline-snippet.txt',
        );
        final downloadButton = tester.widget<OutlinedButton>(
          find.byKey(downloadButtonKey),
        );

        expect(downloadButton.onPressed, isNotNull);
        expect(
          find.descendant(
            of: find.byKey(downloadButtonKey),
            matching: find.text('Fetch embedded data'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'shows local artifact actions when a matching download transfer has '
      'a local path',
      (tester) async {
        final fileOpener = RecordingSessionDetailTransferFileOpener();

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-local-match',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'artifact-local-match.html',
                    'path': '/tmp/artifact-local-match.html',
                    'size': 16,
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/local-match',
                  },
                ),
              ),
            ],
            localTransferFileOpener: fileOpener,
            artifactTransfers: [
              SessionArtifactTransfer(
                id: 'download-transfer-match',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'artifact-local-match.html',
                fileName: 'artifact-local-match.html',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cache/artifact-local-match.html',
                exportedPath: '/tmp/exported/artifact-local-match.html',
                message: 'Saved artifact-local-match.html',
                createdAt: DateTime(2026, 6, 30),
                updatedAt: DateTime(2026, 6, 30),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-copy-'
              '0-artifact-local-match.html',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-open-'
              '0-artifact-local-match.html',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-reveal-'
              '0-artifact-local-match.html',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-preview-'
              '0-artifact-local-match.html',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(
              const Key(
                'session-detail-artifact-summary-item-0-'
                'artifact-local-match.html',
              ),
            ),
            matching: find.text(
              'Saved: /tmp/exported/artifact-local-match.html',
            ),
          ),
          findsOneWidget,
        );

        expect(
          find.byKey(
            const Key('session-detail-transfer-copy-download-transfer-match'),
          ),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-artifact-local-open-'
              '0-artifact-local-match.html',
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(fileOpener.openedPaths, [
          '/tmp/exported/artifact-local-match.html',
        ]);
      },
    );

    testWidgets(
      'prefers exported path over cached path for artifact local actions',
      (tester) async {
        final fileOpener = RecordingSessionDetailTransferFileOpener();

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-path-preference',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'artifact-path-preference.txt',
                    'path': '/tmp/artifact-path-preference.txt',
                    'size': 16,
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/path-preference',
                  },
                ),
              ),
            ],
            localTransferFileOpener: fileOpener,
            artifactTransfers: [
              SessionArtifactTransfer(
                id: 'path-preference-transfer',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'artifact-path-preference.txt',
                fileName: 'artifact-path-preference.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cache/artifact-path-preference.txt',
                exportedPath: '/tmp/exported/artifact-path-preference.txt',
                message: 'Saved artifact-path-preference.txt',
                createdAt: DateTime(2026, 6, 30),
                updatedAt: DateTime(2026, 6, 30),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-artifact-local-open-'
              '0-artifact-path-preference.txt',
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-artifact-local-reveal-'
              '0-artifact-path-preference.txt',
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-artifact-local-preview-'
              '0-artifact-path-preference.txt',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.descendant(
            of: find.byKey(
              const Key(
                'session-detail-artifact-summary-item-0-'
                'artifact-path-preference.txt',
              ),
            ),
            matching: find.text(
              'Saved: /tmp/exported/artifact-path-preference.txt',
            ),
          ),
          findsOneWidget,
        );
        expect(fileOpener.openedPaths, [
          '/tmp/exported/artifact-path-preference.txt',
        ]);
        expect(
          fileOpener.revealedPaths,
          ['/tmp/exported/artifact-path-preference.txt'],
        );
        expect(
          fileOpener.previewedPaths,
          ['/tmp/exported/artifact-path-preference.txt'],
        );
      },
    );

    testWidgets(
      'does not show artifact local actions without matching local transfer',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-no-actions',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'artifact-no-actions.txt',
                    'size': 16,
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/no-actions',
                  },
                ),
              ),
            ],
            artifactTransfers: [
              SessionArtifactTransfer(
                id: 'remote-transfer',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'artifact-no-actions-mismatch',
                fileName: 'artifact-no-actions.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                message: 'Saved artifact-no-actions.txt',
                createdAt: DateTime(2026, 6, 30),
                updatedAt: DateTime(2026, 6, 30),
              ),
              SessionArtifactTransfer(
                id: 'cached-transfer-no-path',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'artifact-no-actions.txt',
                fileName: 'artifact-no-actions.txt',
                direction: SessionArtifactTransferDirection.preview,
                status: SessionArtifactTransferStatus.completed,
                message: 'No local path',
                createdAt: DateTime(2026, 6, 30),
                updatedAt: DateTime(2026, 6, 30),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-copy-0-artifact-no-actions.txt',
            ),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-open-0-artifact-no-actions.txt',
            ),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-reveal-0-artifact-no-actions.txt',
            ),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-artifact-local-preview-0-artifact-no-actions.txt',
            ),
          ),
          findsNothing,
        );
      },
    );

    testWidgets(
      'artifact local preview shows in-app content with expected path',
      (tester) async {
        const transferId = 'artifact-preview-transfer';
        const previewContent = 'artifact text preview';
        final fileOpener = RecordingSessionDetailTransferFileOpener(
          previewResult: const LocalTransferTextPreviewResult.success(
            previewContent,
            isTruncated: false,
          ),
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.fileArtifact,
                  id: 'artifact-preview-for-local',
                  raw: {
                    'type': 'file-artifact',
                    'name': 'artifact-preview.txt',
                    'size': 16,
                    'fetchUrl':
                        'https://cdn.example.net/api/sessions/opencode/session-1'
                        '/artifact/local-preview',
                  },
                ),
              ),
            ],
            localTransferFileOpener: fileOpener,
            artifactTransfers: [
              SessionArtifactTransfer(
                id: transferId,
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'artifact-preview.txt',
                fileName: 'artifact-preview.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                exportedPath: '/tmp/exported/artifact-preview.txt',
                message: 'Saved artifact-preview.txt',
                createdAt: DateTime(2026, 6, 30),
                updatedAt: DateTime(2026, 6, 30),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-artifact-local-preview-0-artifact-preview.txt',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text('Text preview: artifact-preview.txt'),
          findsOneWidget,
        );
        expect(
          find.text('Path: /tmp/exported/artifact-preview.txt'),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key('session-detail-transfer-preview-content-$transferId'),
          ),
          findsOneWidget,
        );
        final previewText = tester.widget<Text>(
          find.byKey(
            const Key('session-detail-transfer-preview-content-$transferId'),
          ),
        );
        expect(previewText.data, previewContent);

        expect(
          find.byKey(
            const Key('session-detail-transfer-preview-title-$transferId'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'shows explicit blocked-preview status after preview attempt',
      (tester) async {
        const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
        const descriptor = SessionArtifactDescriptor(
          name: 'report.html',
          path: '/tmp/report.html',
          mimeType: 'text/html',
          size: 64,
          fetchUrl:
              'https://cdn.example.net/api/sessions/opencode/session-1'
              '/artifact/report',
        );
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.fileArtifact,
                id: 'artifact-report',
                raw: {
                  'type': 'file-artifact',
                  'name': 'report.html',
                  'path': '/tmp/report.html',
                  'size': 64,
                  'mimeType': 'text/html',
                  'fetchUrl':
                      'https://cdn.example.net/api/sessions/opencode/session-1'
                      '/artifact/report',
                },
              ),
            ),
          ],
        );
        final container = ProviderContainer(
          overrides: [
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) =>
                  connection,
            ),
            activeBrokerProfileProvider.overrideWith(
              (ref) => createTestBrokerProfile(),
            ),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              InMemorySessionOutboxRepository(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              InMemorySessionTranscriptRepository(),
            ),
            sessionNotificationSettingsStoreProvider.overrideWithValue(
              InMemorySessionNotificationSettingsStore(),
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(
              InMemorySessionDriveIntentStore(),
            ),
            openSessionsStoreProvider.overrideWithValue(
              InMemoryOpenSessionsStore(),
            ),
          ],
        );
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              theme: ThemeData(
                splashFactory: InkRipple.splashFactory,
                extensions: [themeSpecById(kDefaultThemeId).light],
              ),
              home: const SessionDetailPage(
                tool: 'claude',
                sessionId: 'session-1',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final blocked =
            SessionArtifactPreviewPresentationResult.blockedNavigation(
              Uri.parse('https://example.com/report.zip'),
              blockReason:
                  SessionArtifactPreviewNavigationBlockReason.downloadLike,
            );
        container
            .read(sessionDetailControllerProvider(key).notifier)
            .recordArtifactPreviewResult(
              descriptor,
              opened: false,
              message: blocked.message,
            );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );
        expect(
          find.descendant(
            of: find.byKey(
              const Key('session-detail-artifact-summary-item-0-report.html'),
            ),
            matching: find.text('The file action failed. Try again.'),
          ),
          findsOneWidget,
        );
        await tester.tap(
          find.descendant(
            of: find.byKey(
              const Key('session-detail-artifact-summary-item-0-report.html'),
            ),
            matching: find.text('Technical details'),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(blocked.message), findsOneWidget);
      },
    );

    testWidgets('renders artifact transfer status rows', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'transfer-1',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'report.html',
              fileName: 'report.html',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.completed,
              cachedFilePath: '/tmp/report.html',
              exportedPath: '/srv/exports/report.html',
              bytesTransferred: 6,
              totalBytes: 12,
              byteLength: 12,
              message: 'Saved report.html',
              createdAt: DateTime(2026, 6, 30),
              updatedAt: DateTime(2026, 6, 30),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(
        tester,
        'session-detail-tab-artifacts',
      );

      expect(
        find.byKey(const Key('session-detail-artifact-transfer-surface')),
        findsOneWidget,
      );
      expect(find.text('Transfers (1)'), findsOneWidget);
      expect(find.text('Download: report.html'), findsOneWidget);
      expect(
        find.text('Complete — 6/12 bytes'),
        findsOneWidget,
      );
    });

    testWidgets('hides transfers owned by another broker profile', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'other-profile-transfer',
              brokerProfileId: 'peer-profile',
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'private-report.html',
              fileName: 'private-report.html',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.completed,
              cachedFilePath: '/tmp/private-report.html',
              message: 'Saved private-report.html',
              createdAt: DateTime(2026, 6, 30),
              updatedAt: DateTime(2026, 6, 30),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(
        tester,
        'session-detail-tab-artifacts',
      );

      expect(find.text('Transfers (1)'), findsNothing);
      expect(find.textContaining('private-report.html'), findsNothing);
    });
  });
}
