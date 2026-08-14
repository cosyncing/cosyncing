// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
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
  group('SessionDetailPage transfer and terminal surfaces', () {
    testWidgets('renders transfer retry and cancel controls', (tester) async {
      final artifactFileService = FakeSessionArtifactFileService()
        ..mockCachedFile = const SessionArtifactCachedFile(
          cachedFilePath: '/tmp/failed.html',
          fileName: 'failed.html',
          contentType: 'text/html',
          byteLength: 18,
        )
        ..exportedPath = '/workspace/failed.html';

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactFileService: artifactFileService,
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'failed-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'failed.html',
              fileName: 'failed.html',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.failed,
              artifactKey: 'failed.html',
              contentHash:
                  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              sourceUrl:
                  'http://127.0.0.1:7734/api/sessions/claude/session-1/'
                  'artifact/failed.html?expires=9999999999999&sig=test',
              contentType: 'text/html',
              message: 'Network failed',
              createdAt: DateTime(2026, 6, 30),
              updatedAt: DateTime(2026, 6, 30),
            ),
            SessionArtifactTransfer(
              id: 'running-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'running.html',
              fileName: 'running.html',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.running,
              message: 'Downloading...',
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
        find.byKey(const Key('session-detail-transfer-retry-failed-transfer')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-transfer-cancel-running-transfer'),
        ),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const Key('session-detail-transfer-retry-failed-transfer')),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('Complete — 18/18 bytes'),
        findsOneWidget,
      );
      expect(artifactFileService.cacheCallCount, 1);
      expect(artifactFileService.exportCallCount, 1);

      await tester.tap(
        find.byKey(
          const Key('session-detail-transfer-cancel-running-transfer'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Canceled'), findsOneWidget);
    });

    testWidgets('renders upload transfers without worker actions', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'failed-upload',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'failed-upload',
              fileName: 'failed.txt',
              direction: SessionArtifactTransferDirection.upload,
              status: SessionArtifactTransferStatus.failed,
              message: 'file failed',
              bytesTransferred: 0,
              totalBytes: 5,
              createdAt: DateTime(2026, 6, 30),
              updatedAt: DateTime(2026, 6, 30),
            ),
            SessionArtifactTransfer(
              id: 'running-upload',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'running-upload',
              fileName: 'running.txt',
              direction: SessionArtifactTransferDirection.upload,
              status: SessionArtifactTransferStatus.running,
              message: 'Uploading running.txt',
              bytesTransferred: 0,
              totalBytes: 8,
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

      expect(find.text('Upload: failed.txt'), findsOneWidget);
      expect(find.text('Upload: running.txt'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-transfer-retry-failed-upload')),
        findsNothing,
      );
      expect(
        find.byKey(
          const Key('session-detail-transfer-cancel-running-upload'),
        ),
        findsNothing,
      );
    });

    testWidgets('shows local transfer actions when a local path exists', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'cached-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'cached-transfer',
              fileName: 'cached.txt',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.cached,
              cachedFilePath: '/tmp/cache/cached.txt',
              message: 'Cached artifact',
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
        find.byKey(const Key('session-detail-transfer-copy-cached-transfer')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-transfer-open-cached-transfer')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-transfer-reveal-cached-transfer'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-transfer-preview-cached-transfer'),
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'copies exported path to clipboard when both cached and exported paths '
      'exist',
      (tester) async {
        String? copiedText;
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );

        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (MethodCall methodCall) async {
            if (methodCall.method == 'Clipboard.setData') {
              final arguments = methodCall.arguments;
              if (arguments is Map<Object?, Object?>) {
                copiedText = arguments['text'] as String?;
              }
            }
            return null;
          },
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            artifactTransfers: [
              SessionArtifactTransfer(
                id: 'both-paths-transfer',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'both-paths-transfer',
                fileName: 'both.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cache/both.txt',
                exportedPath: '/tmp/exported/both.txt',
                message: 'Downloaded both paths',
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
            const Key('session-detail-transfer-copy-both-paths-transfer'),
          ),
        );
        await tester.pumpAndSettle();

        expect(copiedText, '/tmp/exported/both.txt');
        expect(find.text('Path copied to clipboard'), findsOneWidget);
      },
    );

    testWidgets(
      'local transfer actions call opener with exported path preference',
      (tester) async {
        final fileOpener = RecordingSessionDetailTransferFileOpener();

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            localTransferFileOpener: fileOpener,
            artifactTransfers: [
              SessionArtifactTransfer(
                id: 'path-preference',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'path-preference',
                fileName: 'path-pref.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cache/path-pref.txt',
                exportedPath: '/tmp/exported/path-pref.txt',
                message: 'Downloaded with both paths',
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
          find.byKey(const Key('session-detail-transfer-open-path-preference')),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(
            const Key('session-detail-transfer-reveal-path-preference'),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(
            const Key('session-detail-transfer-preview-path-preference'),
          ),
        );
        await tester.pumpAndSettle();

        expect(fileOpener.openedPaths, ['/tmp/exported/path-pref.txt']);
        expect(fileOpener.revealedPaths, ['/tmp/exported/path-pref.txt']);
        expect(fileOpener.previewedPaths, ['/tmp/exported/path-pref.txt']);
      },
    );

    testWidgets('does not show local actions when no local path exists', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'no-path-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'no-path-transfer',
              fileName: 'no-path.txt',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.completed,
              message: 'No local file',
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
        find.byKey(const Key('session-detail-transfer-copy-no-path-transfer')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-transfer-open-no-path-transfer')),
        findsNothing,
      );
      expect(
        find.byKey(
          const Key('session-detail-transfer-reveal-no-path-transfer'),
        ),
        findsNothing,
      );
      expect(
        find.byKey(
          const Key('session-detail-transfer-preview-no-path-transfer'),
        ),
        findsNothing,
      );
    });

    testWidgets(
      'preview action shows local text preview and truncation notice',
      (tester) async {
        const transferId = 'preview-truncated-transfer';
        const previewKey = 'session-detail-transfer-preview-$transferId';
        const titleKey = 'session-detail-transfer-preview-title-$transferId';
        const filenameKey =
            'session-detail-transfer-preview-filename-$transferId';
        const contentKey =
            'session-detail-transfer-preview-content-$transferId';
        const truncatedKey =
            'session-detail-transfer-preview-truncated-$transferId';

        final fileOpener = RecordingSessionDetailTransferFileOpener(
          previewResult: const LocalTransferTextPreviewResult.success(
            'hello\nworld',
            isTruncated: true,
          ),
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            localTransferFileOpener: fileOpener,
            artifactTransfers: [
              SessionArtifactTransfer(
                id: transferId,
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: transferId,
                fileName: 'preview.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                exportedPath: '/tmp/exported/preview.txt',
                message: 'Downloaded preview file',
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
            const Key(previewKey),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const Key(titleKey),
          ),
          findsOneWidget,
        );
        expect(find.text('Text preview: preview.txt'), findsOneWidget);
        expect(
          find.byKey(
            const Key(filenameKey),
          ),
          findsOneWidget,
        );
        expect(find.text('Path: /tmp/exported/preview.txt'), findsOneWidget);
        expect(
          find.byKey(
            const Key(contentKey),
          ),
          findsOneWidget,
        );
        final previewText = tester.widget<Text>(
          find.byKey(
            const Key(contentKey),
          ),
        );
        expect(previewText.data, 'hello\nworld');
        expect(
          find.byKey(
            const Key(truncatedKey),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('preview action surfaces binary result as a user message', (
      tester,
    ) async {
      const binaryMessage =
          'File appears to contain binary data and cannot '
          'be previewed as text.';
      final fileOpener = RecordingSessionDetailTransferFileOpener(
        previewResult: const LocalTransferTextPreviewResult.binary(
          binaryMessage,
        ),
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          localTransferFileOpener: fileOpener,
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'preview-binary-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'preview-binary-transfer',
              fileName: 'binary.txt',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/binary.txt',
              message: 'Downloaded binary file',
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
            'session-detail-transfer-preview-preview-binary-transfer',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text(
          "This file contains binary data and can't be previewed as text.",
        ),
        findsOneWidget,
      );
      expect(find.text(binaryMessage), findsNothing);
    });

    testWidgets(
      'preview action surfaces unsupported result as a user message',
      (
        tester,
      ) async {
        final fileOpener = RecordingSessionDetailTransferFileOpener(
          previewResult: const LocalTransferTextPreviewResult.unsupported(
            'Preview unavailable on this platform.',
          ),
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            localTransferFileOpener: fileOpener,
            artifactTransfers: [
              SessionArtifactTransfer(
                id: 'preview-unsupported-transfer',
                brokerProfileId: testBrokerScope(),
                sessionKey: const SessionDetailKey(
                  tool: 'claude',
                  sessionId: 'session-1',
                ),
                actionKey: 'preview-unsupported-transfer',
                fileName: 'unsupported.txt',
                direction: SessionArtifactTransferDirection.download,
                status: SessionArtifactTransferStatus.completed,
                exportedPath: '/tmp/exported/unsupported.txt',
                message: 'Downloaded unsupported file',
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
              'session-detail-transfer-preview-preview-unsupported-transfer',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text("Text preview isn't supported on this device."),
          findsOneWidget,
        );
        expect(
          find.text('Preview unavailable on this platform.'),
          findsNothing,
        );
        expect(
          fileOpener.previewedPaths,
          ['/tmp/exported/unsupported.txt'],
        );
      },
    );

    testWidgets('open action surfaces local file opener failure', (
      tester,
    ) async {
      final fileOpener = RecordingSessionDetailTransferFileOpener(
        openResult: const LocalTransferFileActionResult.failed(
          'Open operation failed',
        ),
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          localTransferFileOpener: fileOpener,
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'open-failure-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'open-failure-transfer',
              fileName: 'open.txt',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/open-failed.txt',
              message: 'Downloaded file',
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
          const Key('session-detail-transfer-open-open-failure-transfer'),
        ),
      );
      await tester.pumpAndSettle();

      expect(fileOpener.openedPaths, ['/tmp/exported/open-failed.txt']);
      expect(
        find.text("Couldn't open the file. Try again."),
        findsOneWidget,
      );
      expect(find.textContaining('Open operation failed'), findsNothing);
    });

    testWidgets('Escape cancels a focused running transfer row', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          artifactTransfers: [
            SessionArtifactTransfer(
              id: 'running-transfer',
              brokerProfileId: testBrokerScope(),
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              actionKey: 'running.html',
              fileName: 'running.html',
              direction: SessionArtifactTransferDirection.download,
              status: SessionArtifactTransferStatus.running,
              message: 'Downloading...',
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
          const Key('session-detail-artifact-transfer-running-transfer'),
        ),
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();

      expect(find.text('Canceled'), findsOneWidget);
    });

    testWidgets(
      'terminal surface defaults to latest entries and exposes show-all',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              for (var index = 0; index < 4; index++)
                MessageWireEvent(
                  seq: index + 1,
                  message: AgentMessage(
                    type: AgentMessageType.terminalOutput,
                    id: 'term-$index',
                    raw: {
                      'type': 'terminal-output',
                      'command': 'printf $index',
                      'output': 'term result $index',
                    },
                  ),
                ),
              for (var index = 0; index < 6; index++)
                MessageWireEvent(
                  seq: index + 10,
                  message: AgentMessage(
                    type: AgentMessageType.fileArtifact,
                    id: 'artifact-$index',
                    raw: {
                      'type': 'file-artifact',
                      'name': 'artifact-$index.txt',
                      'path': '/tmp/artifact-$index.txt',
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
        expect(find.text('Terminal output (4)'), findsOneWidget);
        expect(find.text('Showing latest 3 of 4'), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-terminal-show-all')),
          findsOneWidget,
        );
        expect(find.textContaining('printf 0'), findsNothing);
        expect(find.textContaining('printf 3'), findsOneWidget);

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );
        final artifactSurface = find.widgetWithText(
          Card,
          'File artifacts (6)',
        );
        expect(artifactSurface, findsOneWidget);
        expect(
          find.descendant(
            of: artifactSurface,
            matching: find.text('Showing latest 5; 1 earlier'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: artifactSurface,
            matching: find.text('artifact-0.txt'),
          ),
          findsNothing,
        );
        expect(
          find.descendant(
            of: artifactSurface,
            matching: find.text('artifact-5.txt'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('Show all reveals older terminal output and toggles back', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            for (var index = 0; index < 4; index++)
              MessageWireEvent(
                seq: index + 1,
                message: AgentMessage(
                  type: AgentMessageType.terminalOutput,
                  id: 'term-$index',
                  raw: {
                    'type': 'terminal-output',
                    'command': 'printf $index',
                    'output': 'term result $index',
                  },
                ),
              ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-terminal');
      await tester.tap(
        find.byKey(const Key('session-detail-terminal-show-all')),
      );
      await tester.pump();

      expect(find.text('Showing all 4'), findsOneWidget);
      expect(find.textContaining('printf 0'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-terminal-show-latest')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const Key('session-detail-terminal-show-latest')),
      );
      await tester.pump();
      expect(find.text('Showing latest 3 of 4'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-terminal-show-all')),
        findsOneWidget,
      );
    });

    testWidgets('copy visible terminal output copies default bounded entries', (
      tester,
    ) async {
      String? copiedText;
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (MethodCall methodCall) async {
          if (methodCall.method == 'Clipboard.setData') {
            final arguments = methodCall.arguments;
            if (arguments is Map<Object?, Object?>) {
              copiedText = arguments['text'] as String?;
            }
          }
          return null;
        },
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            for (var index = 0; index < 4; index++)
              MessageWireEvent(
                seq: index + 1,
                message: AgentMessage(
                  type: AgentMessageType.terminalOutput,
                  id: 'term-$index',
                  raw: {
                    'type': 'terminal-output',
                    'command': 'printf $index',
                    'output': 'term result $index',
                  },
                ),
              ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-terminal');
      await tester.tap(
        find.byKey(const Key('session-detail-terminal-copy-visible')),
      );
      await tester.pumpAndSettle();

      expect(copiedText, 'term result 1\nterm result 2\nterm result 3');
      expect(find.text('Visible terminal output copied.'), findsOneWidget);
    });

    testWidgets(
      'copy visible terminal output includes all entries when '
      'Show all is active',
      (tester) async {
        String? copiedText;
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (MethodCall methodCall) async {
            if (methodCall.method == 'Clipboard.setData') {
              final arguments = methodCall.arguments;
              if (arguments is Map<Object?, Object?>) {
                copiedText = arguments['text'] as String?;
              }
            }
            return null;
          },
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              for (var index = 0; index < 4; index++)
                MessageWireEvent(
                  seq: index + 1,
                  message: AgentMessage(
                    type: AgentMessageType.terminalOutput,
                    id: 'term-$index',
                    raw: {
                      'type': 'terminal-output',
                      'command': 'printf $index',
                      'output': 'term result $index',
                    },
                  ),
                ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(tester, 'session-detail-tab-terminal');
        await tester.tap(
          find.byKey(const Key('session-detail-terminal-show-all')),
        );
        await tester.pump();
        await tester.tap(
          find.byKey(const Key('session-detail-terminal-copy-visible')),
        );
        await tester.pumpAndSettle();

        expect(
          copiedText,
          'term result 0\nterm result 1\nterm result 2\nterm result 3',
        );
        expect(find.text('Visible terminal output copied.'), findsOneWidget);
      },
    );

    testWidgets('terminal tab remains read-only', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.terminalOutput,
                id: 'term-1',
                raw: {
                  'type': 'terminal-output',
                  'command': 'printf',
                  'output': 'line',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-terminal');
      final terminalPanel = find.byKey(
        const Key('session-detail-tab-panel-terminal'),
      );
      expect(
        find.descendant(
          of: terminalPanel,
          matching: find.byType(TextField),
        ),
        findsNothing,
      );
      expect(find.text('Copy visible'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-terminal-copy-visible')),
        findsOneWidget,
      );
    });
  });
}
