import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:cosyncing_client/src/features/transfers/view/transfer_manager_page.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/in_memory_ui_preferences_store.dart';
import '../../../../support/session_detail_page_test_harness.dart'
    show
        InMemoryOpenSessionsStore,
        InMemorySessionControlPreferencesStore,
        InMemorySessionDriveIntentStore,
        InMemorySessionModelPreferenceStore,
        InMemorySessionOutboxRepository,
        InMemorySessionTranscriptRepository;

void main() {
  group('TransferManagerPage', () {
    testWidgets('renders transfers grouped by session', (tester) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'transfer-1',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'transfer-2',
              tool: 'opencode',
              sessionId: 'session-b',
              fileName: 'preview.html',
              direction: SessionArtifactTransferDirection.preview,
              status: SessionArtifactTransferStatus.cached,
            ),
            _transfer(
              id: 'transfer-3',
              fileName: 'notes.txt',
              status: SessionArtifactTransferStatus.failed,
              message: 'Network failed',
            ),
          ],
        ),
      );

      await tester.scrollUntilVisible(
        find.text('opencode / session-b'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();

      expect(find.text('claude / session-a'), findsOneWidget);
      expect(find.text('opencode / session-b'), findsOneWidget);
      expect(find.text('Download: report.html'), findsOneWidget);
      expect(find.text('Preview: preview.html'), findsOneWidget);
      expect(find.text('Download: notes.txt'), findsOneWidget);
    });

    testWidgets(
      'broker-bound retry and session navigation disable on profile mismatch',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'other-profile',
                status: SessionArtifactTransferStatus.failed,
              ),
            ],
            activeBrokerProfileId: 'profile-b',
            hasActiveBrokerClient: true,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('transfer-manager-retry-other-profile')),
          findsNothing,
        );
        final openSession = tester.widget<IconButton>(
          find.byKey(
            const Key('transfer-manager-open-session-other-profile'),
          ),
        );
        expect(openSession.onPressed, isNull);

        await tester.tap(
          find.byKey(const Key('transfer-manager-details-other-profile')),
        );
        await tester.pumpAndSettle();
        expect(find.text(_scopeFor('profile-a')), findsOneWidget);
        final detailsOpenSession = tester.widget<IconButton>(
          find.byKey(
            const Key(
              'transfer-manager-details-open-session-other-profile',
            ),
          ),
        );
        expect(detailsOpenSession.onPressed, isNull);
      },
    );

    testWidgets(
      'legacy unscoped rows never match a missing active profile',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'legacy-unscoped',
                brokerProfileId: null,
                status: SessionArtifactTransferStatus.failed,
              ),
            ],
            activeBrokerProfileId: null,
            hasActiveBrokerClient: true,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('transfer-manager-retry-legacy-unscoped')),
          findsNothing,
        );
        final openSession = tester.widget<IconButton>(
          find.byKey(
            const Key('transfer-manager-open-session-legacy-unscoped'),
          ),
        );
        expect(openSession.onPressed, isNull);
      },
    );

    testWidgets('renders upload transfer labels in transfer rows', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'upload-transfer',
              fileName: 'notes.txt',
              direction: SessionArtifactTransferDirection.upload,
              status: SessionArtifactTransferStatus.completed,
              bytesTransferred: 12,
              totalBytes: 12,
              message: 'Uploaded 12 bytes',
            ),
          ],
        ),
      );

      expect(find.text('Upload: notes.txt'), findsOneWidget);
      expect(
        find.text('Complete - Uploaded 12 bytes - 12/12 bytes'),
        findsOneWidget,
      );
    });

    testWidgets('does not show worker retry or cancel actions for uploads', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'failed-upload',
              fileName: 'failed.txt',
              direction: SessionArtifactTransferDirection.upload,
              status: SessionArtifactTransferStatus.failed,
              message: 'file failed',
            ),
            _transfer(
              id: 'running-upload',
              fileName: 'running.txt',
              direction: SessionArtifactTransferDirection.upload,
              status: SessionArtifactTransferStatus.running,
              message: 'Uploading running.txt',
            ),
          ],
        ),
      );

      expect(find.text('Upload: failed.txt'), findsOneWidget);
      expect(find.text('Upload: running.txt'), findsOneWidget);
      expect(
        find.byKey(const Key('transfer-manager-retry-failed-upload')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('transfer-manager-cancel-running-upload')),
        findsNothing,
      );
    });

    testWidgets(
      'shows resume action only for eligible upload rows with complete '
      'metadata',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'eligible-upload-queued',
                fileName: 'queued.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.queued,
                uploadId: 'upload-queued-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
              _transfer(
                id: 'eligible-upload-failed',
                fileName: 'failed.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.failed,
                uploadId: 'upload-failed-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
              _transfer(
                id: 'eligible-upload-canceled',
                fileName: 'canceled.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.canceled,
                uploadId: 'upload-canceled-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
              _transfer(
                id: 'running-upload',
                fileName: 'running.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.running,
                uploadId: 'upload-running-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
              _transfer(
                id: 'ineligible-upload-incomplete',
                fileName: 'incomplete-upload.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.failed,
                uploadId: 'incomplete-upload',
              ),
              _transfer(
                id: 'download-failed',
                fileName: 'download-failed.txt',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'download-running',
                fileName: 'download-running.txt',
                status: SessionArtifactTransferStatus.running,
              ),
            ],
          ),
        );

        expect(
          find.byKey(
            const Key(
              'transfer-manager-select-file-to-resume-'
              'eligible-upload-queued',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key(
              'transfer-manager-select-file-to-resume-'
              'eligible-upload-failed',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key(
              'transfer-manager-select-file-to-resume-eligible-upload-canceled',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-select-file-to-resume-running-upload'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key(
              'transfer-manager-select-file-to-resume-'
              'ineligible-upload-incomplete',
            ),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-select-file-to-resume-download-failed'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key(
              'transfer-manager-select-file-to-resume-'
              'download-running',
            ),
          ),
          findsNothing,
        );
        expect(find.text('Select file to resume'), findsNWidgets(3));
      },
    );

    testWidgets(
      'offline upload resume action is disabled, explains why, and does not '
      'dispatch worker',
      (tester) async {
        final worker = _RecordingTransferWorker(
          selectFileToResumeUploadResult:
              const SessionArtifactTransferWorkerResult(
                transferId: 'queued-offline',
                outcome: SessionArtifactTransferWorkerOutcome.canceled,
                message: 'Upload resume selection was canceled.',
              ),
        );
        await tester.pumpWidget(
          _buildSubject(
            worker: worker,
            transfers: [
              _transfer(
                id: 'queued-offline',
                fileName: 'queued.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.queued,
                uploadId: 'upload-offline-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
            ],
          ),
        );

        final button = find.byKey(
          const Key('transfer-manager-select-file-to-resume-queued-offline'),
        );
        expect(button, findsOneWidget);
        expect(
          find.byTooltip(
            'Connect before resuming uploads.',
          ),
          findsOneWidget,
        );
        expect(
          tester.widget<TextButton>(button).onPressed,
          isNull,
        );

        await tester.tap(button);
        await tester.pumpAndSettle();

        expect(worker.selectedFileToResumeTransferIds, isEmpty);
      },
    );

    testWidgets(
      'online upload resume action dispatches worker once and shows result',
      (tester) async {
        final worker = _RecordingTransferWorker(
          selectFileToResumeUploadResult:
              const SessionArtifactTransferWorkerResult(
                transferId: 'queued-online',
                outcome: SessionArtifactTransferWorkerOutcome.completed,
                message: 'Upload resume started.',
              ),
        );
        await tester.pumpWidget(
          _buildSubject(
            hasActiveBrokerClient: true,
            worker: worker,
            transfers: [
              _transfer(
                id: 'queued-online',
                fileName: 'queued.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.queued,
                uploadId: 'upload-online-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        final button = find.byKey(
          const Key('transfer-manager-select-file-to-resume-queued-online'),
        );
        expect(button, findsOneWidget);
        final buttonWidget = tester.widget<TextButton>(button);
        expect(buttonWidget.onPressed, isNotNull);

        await tester.tap(button);
        await tester.pumpAndSettle();

        expect(worker.selectedFileToResumeTransferIds, ['queued-online']);
        expect(find.text('Upload resumed.'), findsOneWidget);
        expect(find.text('Upload resume started.'), findsNothing);
      },
    );

    testWidgets(
      'bulk retry/cancel actions do not invoke upload resume picker action',
      (tester) async {
        final worker = _RecordingTransferWorker();
        await tester.pumpWidget(
          _buildSubject(
            hasActiveBrokerClient: true,
            worker: worker,
            transfers: [
              _transfer(
                id: 'upload-failed-resumable',
                fileName: 'resumable-upload.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.failed,
                uploadId: 'upload-resumable-1',
                byteLength: 64,
                contentHash: _canonicalSha256Hash,
              ),
              _transfer(
                id: 'failed-download',
                fileName: 'failed.txt',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'running-download',
                fileName: 'running.txt',
                status: SessionArtifactTransferStatus.running,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'upload-failed-resumable');
        await _tapTransferSelection(tester, 'failed-download');
        await _tapTransferSelection(tester, 'running-download');

        await tester.tap(
          find.byKey(const Key('transfer-manager-retry-selected')),
        );
        await tester.pumpAndSettle();
        expect(worker.retriedIds, ['failed-download']);
        expect(worker.selectedFileToResumeTransferIds, isEmpty);
        expect(
          find.text('Retrying 1 transfer(s)'),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-cancel-selected')),
        );
        await tester.pumpAndSettle();
        expect(worker.canceledIds, ['running-download']);
        expect(worker.selectedFileToResumeTransferIds, isEmpty);
        expect(
          find.text('Canceling 1 transfer(s)'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'row open session action navigates to encoded owning session route',
      (
        tester,
      ) async {
        late GoRouter router;

        await tester.pumpWidget(
          _buildSubjectWithRouter(
            transfers: [
              _transfer(
                id: 'special-session-row',
                tool: 'claude code/pro?%',
                sessionId: 'session / # ? % 你好',
                fileName: 'artifact.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
            onRouterCreated: (createdRouter) {
              router = createdRouter;
            },
          ),
        );

        await tester.tap(
          find.byKey(
            const Key('transfer-manager-open-session-special-session-row'),
          ),
        );
        final expectedLocation = sessionDetailLocation(
          tool: 'claude code/pro?%',
          sessionId: 'session / # ? % 你好',
        );
        await _pumpUntilRoute(
          tester,
          router,
          expectedLocation,
          content: find.byKey(const Key('session-detail-tab-panel-chat')),
        );

        expect(
          router.routeInformationProvider.value.uri.toString(),
          expectedLocation,
        );
        expect(
          find.byKey(const Key('session-detail-tab-panel-chat')),
          findsOneWidget,
        );
        // The id round-trips through the route intact — that is what this test
        // is about. U3 stops it being what the page is *titled*: a transfer row
        // deep-links with no known title, so Session Detail names the page
        // neutrally until the broker's session frame arrives.
        expect(_textWidget('session / # ? % 你好'), findsNothing);
        expect(_textWidget('Opening session'), findsOneWidget);
      },
    );

    testWidgets(
      'details open session action navigates to encoded owning session route',
      (
        tester,
      ) async {
        late GoRouter router;

        await tester.pumpWidget(
          _buildSubjectWithRouter(
            transfers: [
              _transfer(
                id: 'special-session-details',
                tool: 'opencode/probe',
                sessionId: 'weird / path # 1',
                fileName: 'artifact.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
            onRouterCreated: (createdRouter) {
              router = createdRouter;
            },
          ),
        );

        await tester.tap(
          find.byKey(
            const Key('transfer-manager-details-special-session-details'),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(
            const Key(
              'transfer-manager-details-open-session-special-session-details',
            ),
          ),
        );
        final expectedLocation = sessionDetailLocation(
          tool: 'opencode/probe',
          sessionId: 'weird / path # 1',
        );
        await _pumpUntilRoute(
          tester,
          router,
          expectedLocation,
          content: find.byKey(const Key('session-detail-tab-panel-chat')),
          absent: find.byKey(
            const Key(
              'transfer-manager-details-title-special-session-details',
            ),
          ),
        );

        expect(
          router.routeInformationProvider.value.uri.toString(),
          expectedLocation,
        );
        expect(
          find.byKey(const Key('session-detail-tab-panel-chat')),
          findsOneWidget,
        );
        expect(_textWidget('weird / path # 1'), findsNothing);
        expect(_textWidget('Opening session'), findsOneWidget);
        expect(
          find.byKey(
            const Key('transfer-manager-details-title-special-session-details'),
          ),
          findsNothing,
        );
      },
    );

    testWidgets('upload transfer rows also include open session action', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'upload-row-open-session',
              fileName: 'upload.bin',
              direction: SessionArtifactTransferDirection.upload,
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      expect(
        find.byKey(
          const Key('transfer-manager-open-session-upload-row-open-session'),
        ),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(
          const Key('transfer-manager-details-upload-row-open-session'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(
          const Key(
            'transfer-manager-details-open-session-upload-row-open-session',
          ),
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'row checkbox toggles selection state and updates bulk selection summary',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'selection-row-1',
                fileName: 'report-1.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'selection-row-2',
                fileName: 'report-2.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        expect(
          find.byKey(const Key('transfer-manager-selection-summary')),
          findsNothing,
        );
        await _tapTransferSelection(tester, 'selection-row-1');
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 1);
        expect(
          find.byKey(const Key('transfer-manager-copy-selected-paths')),
          findsOneWidget,
        );

        await _tapTransferSelection(tester, 'selection-row-2');
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 2);

        await _tapTransferSelection(tester, 'selection-row-1');
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 1);
      },
    );

    testWidgets(
      'select all visible selects every current visible row and updates '
      'visible '
      'count',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'select-all-row-1',
                fileName: 'row-1.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'select-all-row-2',
                fileName: 'row-2.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'select-all-row-3',
                fileName: 'row-3.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-select-all-visible')),
        );
        await tester.pumpAndSettle();

        _expectVisibleSelectionSummary(tester, 3);
        expect(find.text('Selected 3 visible transfer(s)'), findsNWidgets(2));
      },
    );

    testWidgets(
      'select all visible respects current filter/search and preserves hidden '
      'selection across filter changes',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'select-all-filtered-shared-1',
                fileName: 'alpha-shared.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'select-all-filtered-shared-2',
                fileName: 'beta-shared.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'select-all-filtered-hidden',
                fileName: 'gamma-hidden.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'select-all-filtered-hidden');
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 1);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'shared',
        );
        await tester.pump();

        await tester.tap(
          find.byKey(const Key('transfer-manager-select-all-visible')),
        );
        await tester.pumpAndSettle();

        _expectVisibleSelectionSummary(tester, 2);
        expect(find.text('Selected 2 visible transfer(s)'), findsNWidgets(2));

        await tester.tap(
          find.byKey(const Key('transfer-manager-search-clear')),
        );
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 3);
      },
    );

    testWidgets(
      'invert visible selection toggles only visible rows and preserves hidden '
      'selection',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'invert-visible-1',
                fileName: 'visible-shared-a.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'invert-visible-2',
                fileName: 'visible-shared-b.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'invert-hidden',
                fileName: 'non-matching.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'invert-visible-1');
        await _tapTransferSelection(tester, 'invert-visible-2');
        await _tapTransferSelection(tester, 'invert-hidden');
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 3);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'shared',
        );
        await tester.pump();

        await tester.tap(
          find.byKey(const Key('transfer-manager-invert-visible-selection')),
        );
        await tester.pump();
        await tester.pumpAndSettle();
        _expectNoVisibleTransferSelectionSummary(tester);

        await tester.tap(
          find.byKey(const Key('transfer-manager-search-clear')),
        );
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 1);
      },
    );

    testWidgets('Ctrl+A selects all currently visible transfers', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'shortcuts-select-all-row-1',
              fileName: 'row-1.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-select-all-row-2',
              fileName: 'row-2.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-select-all-row-3',
              fileName: 'row-3.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await _sendShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        key: LogicalKeyboardKey.keyA,
      );
      await tester.pumpAndSettle();

      _expectVisibleSelectionSummary(tester, 3);
    });

    testWidgets('Meta+A selects all currently visible transfers', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'shortcuts-select-all-meta-row-1',
              fileName: 'row-1.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-select-all-meta-row-2',
              fileName: 'row-2.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await _sendShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.metaLeft,
        key: LogicalKeyboardKey.keyA,
      );
      await tester.pumpAndSettle();

      _expectVisibleSelectionSummary(tester, 2);
    });

    testWidgets('Ctrl+I inverts only visible transfers', (tester) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'shortcuts-invert-filtered-shared-1',
              fileName: 'visible-invert-a.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-invert-filtered-shared-2',
              fileName: 'visible-invert-b.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-invert-hidden',
              fileName: 'other-hidden.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await _tapTransferSelection(
        tester,
        'shortcuts-invert-filtered-shared-1',
      );
      await _tapTransferSelection(tester, 'shortcuts-invert-hidden');
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'visible-invert',
      );
      await tester.pump();
      await _focusTransferManagerControls(tester);

      await _sendShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        key: LogicalKeyboardKey.keyI,
      );
      await tester.pumpAndSettle();

      _expectVisibleSelectionSummary(tester, 1);
      expect(find.text('Inverted 2 visible transfer(s)'), findsOneWidget);
      await tester.tap(find.byKey(const Key('transfer-manager-search-clear')));
      await tester.pumpAndSettle();
      _expectVisibleSelectionSummary(tester, 2);
    });

    testWidgets('Meta+I inverts only visible transfers', (tester) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'shortcuts-invert-meta-filtered-shared-1',
              fileName: 'visible-meta-a.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-invert-meta-filtered-shared-2',
              fileName: 'visible-meta-b.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-invert-meta-hidden',
              fileName: 'other-hidden.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await _tapTransferSelection(
        tester,
        'shortcuts-invert-meta-filtered-shared-1',
      );
      await _tapTransferSelection(tester, 'shortcuts-invert-meta-hidden');
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'visible-meta',
      );
      await tester.pump();
      await _focusTransferManagerControls(tester);

      await _sendShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.metaLeft,
        key: LogicalKeyboardKey.keyI,
      );
      await tester.pumpAndSettle();

      _expectVisibleSelectionSummary(tester, 1);
      expect(find.text('Inverted 2 visible transfer(s)'), findsOneWidget);
      await tester.tap(find.byKey(const Key('transfer-manager-search-clear')));
      await tester.pumpAndSettle();
      _expectVisibleSelectionSummary(tester, 2);
    });

    testWidgets(
      'Ctrl+A and Ctrl+I do not fire when the transfer search field is focused',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'shortcuts-focus-row-1',
                fileName: 'row-1.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'shortcuts-focus-row-2',
                fileName: 'row-2.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-search-field')),
        );
        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'row',
        );
        await tester.pump();

        await _sendShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          key: LogicalKeyboardKey.keyA,
        );
        await tester.pumpAndSettle();
        _expectNoVisibleTransferSelectionSummary(tester);

        await _sendShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          key: LogicalKeyboardKey.keyI,
        );
        await tester.pumpAndSettle();
        _expectNoVisibleTransferSelectionSummary(tester);
      },
    );

    testWidgets(
      'Meta+A and Meta+I do not fire when the transfer search field is focused',
      (tester) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'shortcuts-meta-focus-row-1',
                fileName: 'row-1.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'shortcuts-meta-focus-row-2',
                fileName: 'row-2.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-search-field')),
        );
        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'row',
        );
        await tester.pump();

        await _sendShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.metaLeft,
          key: LogicalKeyboardKey.keyA,
        );
        await tester.pumpAndSettle();
        _expectNoVisibleTransferSelectionSummary(tester);

        await _sendShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.metaLeft,
          key: LogicalKeyboardKey.keyI,
        );
        await tester.pumpAndSettle();
        _expectNoVisibleTransferSelectionSummary(tester);
      },
    );

    testWidgets('Escape clears non-empty transfer search query', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'escape-search',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'abc',
      );
      await tester.pump();

      expect(
        find.byKey(const Key('transfer-manager-search-clear')),
        findsOneWidget,
      );

      await _sendShortcut(
        tester: tester,
        key: LogicalKeyboardKey.escape,
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('transfer-manager-search-clear')),
        findsNothing,
      );
    });

    testWidgets('Escape clears transfer selection when search is empty', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'escape-selection',
              fileName: 'row.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await _tapTransferSelection(tester, 'escape-selection');
      await tester.pumpAndSettle();
      _expectVisibleSelectionSummary(tester, 1);

      await _sendShortcut(
        tester: tester,
        key: LogicalKeyboardKey.escape,
      );
      await tester.pumpAndSettle();

      _expectNoVisibleTransferSelectionSummary(tester);
    });

    testWidgets('Ctrl+A / Ctrl+I are no-ops when no visible transfers', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'shortcuts-no-visible-row-1',
              fileName: 'row-1.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'shortcuts-no-visible-row-2',
              fileName: 'row-2.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'does-not-match-anything',
      );
      await tester.pump();
      await _focusTransferManagerControls(tester);

      await _sendShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        key: LogicalKeyboardKey.keyA,
      );
      await tester.pumpAndSettle();
      _expectNoVisibleTransferSelectionSummary(tester);
      expect(find.text('Selected 0 visible transfer(s)'), findsNothing);

      await _sendShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        key: LogicalKeyboardKey.keyI,
      );
      await tester.pumpAndSettle();
      _expectNoVisibleTransferSelectionSummary(tester);
      expect(find.text('Inverted 0 visible transfer(s)'), findsNothing);
    });

    testWidgets('clear selection hides the bulk action bar', (tester) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'selection-clear-row-1',
              fileName: 'report-1.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'selection-clear-row-2',
              fileName: 'report-2.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'selection-clear-row-3',
              fileName: 'hidden-row.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await _tapTransferSelection(tester, 'selection-clear-row-3');
      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'report',
      );
      await tester.pump();
      await tester.tap(
        find.byKey(const Key('transfer-manager-select-all-visible')),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('transfer-manager-selection-summary')),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('transfer-manager-selection-clear')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('transfer-manager-selection-summary')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('transfer-manager-copy-selected-paths')),
        findsNothing,
      );

      await tester.tap(find.byKey(const Key('transfer-manager-search-clear')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('transfer-manager-selection-summary')),
        findsNothing,
      );
    });

    testWidgets(
      'bulk copy-selected copies local paths with exported-path precedence and '
      'newline-separated output',
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
          _buildSubject(
            transfers: [
              _transfer(
                id: 'copy-selected-exported',
                fileName: 'first.txt',
                status: SessionArtifactTransferStatus.completed,
                exportedPath: '/tmp/exported/first.txt',
                cachedFilePath: '/tmp/cached/first.txt',
                updatedAt: DateTime.utc(2026, 7, 3, 13),
              ),
              _transfer(
                id: 'copy-selected-cached',
                fileName: 'second.txt',
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cached/second.txt',
                updatedAt: DateTime.utc(2026, 7, 3, 12),
              ),
              _transfer(
                id: 'copy-selected-missing',
                fileName: 'third.txt',
                status: SessionArtifactTransferStatus.completed,
                updatedAt: DateTime.utc(2026, 7, 3, 11),
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'copy-selected-exported');
        await _tapTransferSelection(tester, 'copy-selected-cached');
        await _tapTransferSelection(tester, 'copy-selected-missing');
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 3);

        await tester.tap(
          find.byKey(const Key('transfer-manager-copy-selected-paths')),
        );
        await tester.pumpAndSettle();

        expect(
          copiedText,
          '/tmp/exported/first.txt\n/tmp/cached/second.txt',
        );
        expect(find.text('Copied 2 path(s)'), findsOneWidget);
      },
    );

    testWidgets(
      'bulk copy-selected ignores missing local paths and does '
      'not overwrite clipboard',
      (tester) async {
        var copyCalls = 0;
        String? copiedText = 'seed';
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
              copyCalls++;
              final arguments = methodCall.arguments;
              if (arguments is Map<Object?, Object?>) {
                copiedText = arguments['text'] as String?;
              }
            }
            return null;
          },
        );

        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'copy-missing-selected-1',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'copy-missing-selected-2',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'copy-missing-selected-1');
        await _tapTransferSelection(tester, 'copy-missing-selected-2');
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('transfer-manager-copy-selected-paths')),
        );
        await tester.pumpAndSettle();

        expect(copyCalls, 0);
        expect(copiedText, 'seed');
        expect(
          find.text('No selected transfers have local paths'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'search/filter/sort composition keeps visible selected count and copies '
      'only visible-selected local paths',
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
          _buildSubject(
            transfers: [
              _transfer(
                id: 'selection-comp-active-b',
                fileName: 'beta-shared.txt',
                status: SessionArtifactTransferStatus.running,
                updatedAt: DateTime.utc(2026, 7, 3, 12),
                exportedPath: '/tmp/beta.txt',
              ),
              _transfer(
                id: 'selection-comp-active-a',
                fileName: 'alpha-shared.txt',
                status: SessionArtifactTransferStatus.queued,
                updatedAt: DateTime.utc(2026, 7, 3, 13),
                exportedPath: '/tmp/alpha.txt',
              ),
              _transfer(
                id: 'selection-comp-failed',
                fileName: 'failure-shared.txt',
                status: SessionArtifactTransferStatus.failed,
                updatedAt: DateTime.utc(2026, 7, 3, 11),
                exportedPath: '/tmp/failed.txt',
              ),
              _transfer(
                id: 'selection-comp-complete',
                fileName: 'completed.txt',
                status: SessionArtifactTransferStatus.completed,
                updatedAt: DateTime.utc(2026, 7, 3, 10),
                exportedPath: '/tmp/completed.txt',
              ),
            ],
          ),
        );

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'shared',
        );
        await tester.pump();
        _expectNoVisibleTransferSelectionSummary(tester);

        await _tapTransferSelection(tester, 'selection-comp-active-a');
        await _tapTransferSelection(tester, 'selection-comp-active-b');
        await _tapTransferSelection(tester, 'selection-comp-failed');
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('transfer-filter-active')));
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('transfer-manager-sort-control')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('transfer-manager-sort-file')).first,
        );
        await tester.pumpAndSettle();

        _expectVisibleSelectionSummary(tester, 2);

        await tester.tap(
          find.byKey(const Key('transfer-manager-copy-selected-paths')),
        );
        await tester.pumpAndSettle();

        expect(copiedText, '/tmp/alpha.txt\n/tmp/beta.txt');
        expect(find.text('Copied 2 path(s)'), findsOneWidget);
      },
    );

    testWidgets(
      'row actions stay usable when a row is selected',
      (tester) async {
        late GoRouter router;
        await tester.pumpWidget(
          _buildSubjectWithRouter(
            transfers: [
              _transfer(
                id: 'selected-open-session',
                fileName: 'open-selected.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
            onRouterCreated: (createdRouter) {
              router = createdRouter;
            },
          ),
        );

        await _tapTransferSelection(tester, 'selected-open-session');
        await tester.pumpAndSettle();

        _expectVisibleSelectionSummary(tester, 1);

        await tester.tap(
          find.byKey(
            const Key('transfer-manager-open-session-selected-open-session'),
          ),
        );
        final expectedLocation = sessionDetailLocation(
          tool: 'claude',
          sessionId: 'session-a',
        );
        await _pumpUntilRoute(tester, router, expectedLocation);
        expect(
          router.routeInformationProvider.value.uri.toString(),
          expectedLocation,
        );
      },
    );

    testWidgets('shows progress and status detail labels', (tester) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'running-transfer',
              fileName: 'large.zip',
              status: SessionArtifactTransferStatus.running,
              message: 'Downloading...',
              bytesTransferred: 12,
              totalBytes: 42,
            ),
          ],
        ),
      );

      expect(find.text('Download: large.zip'), findsOneWidget);
      expect(
        find.text('Running - Downloading... - 12/42 bytes'),
        findsOneWidget,
      );
    });

    testWidgets('renders filter count labels for mixed lifecycle states', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'queued-transfer',
              fileName: 'queued.txt',
              status: SessionArtifactTransferStatus.queued,
            ),
            _transfer(
              id: 'running-transfer',
              fileName: 'running.txt',
              status: SessionArtifactTransferStatus.running,
            ),
            _transfer(
              id: 'cached-transfer',
              fileName: 'cached.txt',
              status: SessionArtifactTransferStatus.cached,
            ),
            _transfer(
              id: 'completed-transfer',
              fileName: 'completed.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'failed-transfer',
              fileName: 'failed.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
            _transfer(
              id: 'canceled-transfer',
              fileName: 'canceled.txt',
              status: SessionArtifactTransferStatus.canceled,
            ),
          ],
        ),
      );

      expect(find.text('All (6)'), findsOneWidget);
      expect(find.text('Active (3)'), findsOneWidget);
      expect(find.text('Finished (3)'), findsOneWidget);
      expect(find.text('Failed (1)'), findsOneWidget);
    });

    testWidgets('active filter shows queued/running/cached rows only', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'queued-transfer',
              fileName: 'queued.txt',
              status: SessionArtifactTransferStatus.queued,
            ),
            _transfer(
              id: 'running-transfer',
              fileName: 'running.txt',
              status: SessionArtifactTransferStatus.running,
            ),
            _transfer(
              id: 'cached-transfer',
              fileName: 'cached.txt',
              status: SessionArtifactTransferStatus.cached,
            ),
            _transfer(
              id: 'completed-transfer',
              fileName: 'completed.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'failed-transfer',
              fileName: 'failed.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
            _transfer(
              id: 'canceled-transfer',
              fileName: 'canceled.txt',
              status: SessionArtifactTransferStatus.canceled,
            ),
          ],
        ),
      );

      await tester.tap(find.byKey(const Key('transfer-filter-active')));
      await tester.pumpAndSettle();

      expect(find.text('Download: queued.txt'), findsOneWidget);
      expect(find.text('Download: running.txt'), findsOneWidget);
      expect(find.text('Download: cached.txt'), findsOneWidget);
      expect(find.text('Download: completed.txt'), findsNothing);
      expect(find.text('Download: failed.txt'), findsNothing);
      expect(find.text('Download: canceled.txt'), findsNothing);
    });

    testWidgets('finished filter shows completed/canceled/failed rows only', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'queued-transfer',
              fileName: 'queued.txt',
              status: SessionArtifactTransferStatus.queued,
            ),
            _transfer(
              id: 'running-transfer',
              fileName: 'running.txt',
              status: SessionArtifactTransferStatus.running,
            ),
            _transfer(
              id: 'cached-transfer',
              fileName: 'cached.txt',
              status: SessionArtifactTransferStatus.cached,
            ),
            _transfer(
              id: 'completed-transfer',
              fileName: 'completed.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'failed-transfer',
              fileName: 'failed.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
            _transfer(
              id: 'canceled-transfer',
              fileName: 'canceled.txt',
              status: SessionArtifactTransferStatus.canceled,
            ),
          ],
        ),
      );

      await tester.tap(find.byKey(const Key('transfer-filter-finished')));
      await tester.pumpAndSettle();

      expect(find.text('Download: completed.txt'), findsOneWidget);
      expect(find.text('Download: failed.txt'), findsOneWidget);
      expect(find.text('Download: canceled.txt'), findsOneWidget);
      expect(find.text('Download: queued.txt'), findsNothing);
      expect(find.text('Download: running.txt'), findsNothing);
      expect(find.text('Download: cached.txt'), findsNothing);
    });

    testWidgets('failed filter shows failed rows only', (tester) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'queued-transfer',
              fileName: 'queued.txt',
              status: SessionArtifactTransferStatus.queued,
            ),
            _transfer(
              id: 'failed-transfer',
              fileName: 'failed.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
            _transfer(
              id: 'another-failed-transfer',
              fileName: 'another-failed.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
          ],
        ),
      );

      await tester.tap(find.byKey(const Key('transfer-filter-failed')));
      await tester.pumpAndSettle();

      expect(find.text('Download: failed.txt'), findsOneWidget);
      expect(find.text('Download: another-failed.txt'), findsOneWidget);
      expect(find.text('Download: queued.txt'), findsNothing);
    });

    testWidgets('shows filter-specific empty state when filter has no rows', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'queued-transfer',
              fileName: 'queued.txt',
              status: SessionArtifactTransferStatus.queued,
            ),
          ],
        ),
      );

      expect(find.text('Download: queued.txt'), findsOneWidget);

      await tester.tap(find.byKey(const Key('transfer-filter-finished')));
      await tester.pumpAndSettle();

      expect(find.text('No finished transfers'), findsOneWidget);
      expect(find.text('Download: queued.txt'), findsNothing);
    });

    testWidgets(
      'search filters by file name, session id, tool, and transfer metadata',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'file-name-match',
                fileName: 'quarterly-report.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'tool-session-match',
                fileName: 'notes.txt',
                status: SessionArtifactTransferStatus.completed,
                tool: 'special-tool',
                sessionId: 'session-search',
              ),
              _transfer(
                id: 'metadata-match',
                fileName: 'artifact.bin',
                status: SessionArtifactTransferStatus.completed,
                sourceUrl: '/artifact/local-metadata',
                cachedFilePath: '/tmp/cache/local-metadata.bin',
              ),
              _transfer(
                id: 'identity-match',
                fileName: 'identity.txt',
                status: SessionArtifactTransferStatus.completed,
                artifactKey: 'artifact-key-123',
                contentHash: 'content-hash-456',
                actionKey: 'custom-action-key-789',
              ),
            ],
          ),
        );

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'quarterly',
        );
        await tester.pump();
        expect(find.text('Download: quarterly-report.txt'), findsOneWidget);
        expect(find.text('Download: notes.txt'), findsNothing);
        expect(find.text('Download: artifact.bin'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'special-tool',
        );
        await tester.pump();
        expect(find.text('special-tool / session-search'), findsOneWidget);
        expect(find.text('Download: quarterly-report.txt'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'session-search',
        );
        await tester.pump();
        expect(find.text('Download: notes.txt'), findsOneWidget);
        expect(find.text('Download: artifact.bin'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          '/tmp/cache/local-metadata.bin',
        );
        await tester.pump();
        expect(find.text('Download: artifact.bin'), findsOneWidget);
        expect(find.text('Download: notes.txt'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'content-hash-456',
        );
        await tester.pump();
        expect(find.text('Download: identity.txt'), findsOneWidget);
        expect(find.text('Download: artifact.bin'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'custom-action-key-789',
        );
        await tester.pump();
        expect(find.text('Download: identity.txt'), findsOneWidget);
        expect(find.text('Download: quarterly-report.txt'), findsNothing);
      },
    );

    testWidgets('search updates lifecycle counts for the current result set', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'running-share',
              fileName: 'shared-running.txt',
              status: SessionArtifactTransferStatus.running,
            ),
            _transfer(
              id: 'completed-share',
              fileName: 'shared-completed.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'failed-share',
              fileName: 'shared-failed.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
            _transfer(
              id: 'queued-ignore',
              fileName: 'non-shared.txt',
              status: SessionArtifactTransferStatus.queued,
            ),
          ],
        ),
      );

      expect(find.text('All (4)'), findsOneWidget);
      expect(find.text('Active (2)'), findsOneWidget);
      expect(find.text('Finished (2)'), findsOneWidget);
      expect(find.text('Failed (1)'), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'shared-',
      );
      await tester.pump();

      expect(find.text('All (3)'), findsOneWidget);
      expect(find.text('Active (1)'), findsOneWidget);
      expect(find.text('Finished (2)'), findsOneWidget);
      expect(find.text('Failed (1)'), findsOneWidget);
      expect(find.text('No transfers matching search'), findsNothing);
    });

    testWidgets(
      'search and lifecycle filters compose to narrow displayed rows',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'running-shared',
                fileName: 'shared-download.zip',
                status: SessionArtifactTransferStatus.running,
              ),
              _transfer(
                id: 'completed-shared',
                fileName: 'shared-report.zip',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'failed-shared',
                fileName: 'shared-error.zip',
                status: SessionArtifactTransferStatus.failed,
              ),
            ],
          ),
        );

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'shared',
        );
        await tester.pump();

        await tester.tap(find.byKey(const Key('transfer-filter-active')));
        await tester.pumpAndSettle();
        expect(find.text('Download: shared-download.zip'), findsOneWidget);
        expect(find.text('Download: shared-report.zip'), findsNothing);
        expect(find.text('Download: shared-error.zip'), findsNothing);
        expect(find.text('No active transfers matching search'), findsNothing);

        await tester.tap(find.byKey(const Key('transfer-filter-finished')));
        await tester.pumpAndSettle();
        expect(find.text('Download: shared-report.zip'), findsOneWidget);
        expect(find.text('Download: shared-error.zip'), findsOneWidget);
        expect(find.text('Download: shared-download.zip'), findsNothing);

        await tester.tap(find.byKey(const Key('transfer-filter-failed')));
        await tester.pumpAndSettle();
        expect(find.text('Download: shared-error.zip'), findsOneWidget);
        expect(find.text('Download: shared-download.zip'), findsNothing);
        expect(find.text('Download: shared-report.zip'), findsNothing);
      },
    );

    testWidgets('search clear action restores full transfer list and counts', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'search-clear-1',
              fileName: 'match-me.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'search-clear-2',
              fileName: 'stay.txt',
              status: SessionArtifactTransferStatus.failed,
            ),
            _transfer(
              id: 'search-clear-3',
              fileName: 'ignore-me.txt',
              status: SessionArtifactTransferStatus.running,
            ),
          ],
        ),
      );

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'match',
      );
      await tester.pump();
      expect(
        find.byKey(const Key('transfer-manager-search-clear')),
        findsOneWidget,
      );
      expect(find.text('All (1)'), findsOneWidget);
      expect(find.text('Download: match-me.txt'), findsOneWidget);
      expect(find.text('Download: stay.txt'), findsNothing);

      await tester.tap(find.byKey(const Key('transfer-manager-search-clear')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('transfer-manager-search-clear')),
        findsNothing,
      );
      expect(find.text('All (3)'), findsOneWidget);
      expect(find.text('Download: match-me.txt'), findsOneWidget);
      expect(find.text('Download: stay.txt'), findsOneWidget);
      expect(find.text('Download: ignore-me.txt'), findsOneWidget);
    });

    testWidgets(
      'search-specific empty state is shown when filter has no matches',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'failed-empty',
                fileName: 'failure.log',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'finished-empty',
                fileName: 'ok.log',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        await tester.tap(find.byKey(const Key('transfer-filter-failed')));
        await tester.pumpAndSettle();

        expect(find.text('Download: failure.log'), findsOneWidget);
        expect(find.text('No failed transfers matching search'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'not-present',
        );
        await tester.pump();

        expect(
          find.text('No failed transfers matching search'),
          findsOneWidget,
        );
        expect(find.text('Download: failure.log'), findsNothing);
        expect(find.text('Download: ok.log'), findsNothing);
      },
    );

    testWidgets('default sort is newest across updatedAt/createdAt desc', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'newest-1',
              fileName: 'newest-1.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 12, 30),
              createdAt: DateTime.utc(2026, 7, 3, 11, 30),
            ),
            _transfer(
              id: 'newest-2',
              fileName: 'newest-2.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 12, 30),
              createdAt: DateTime.utc(2026, 7, 3, 11),
            ),
            _transfer(
              id: 'newest-3',
              fileName: 'newest-3.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 11),
              createdAt: DateTime.utc(2026, 7, 3, 10),
            ),
          ],
        ),
      );

      expect(
        _transferOrder(tester, [
          'newest-1',
          'newest-2',
          'newest-3',
        ]),
        isTrue,
      );
    });

    testWidgets('oldest sort reverses time ordering by updatedAt/createdAt', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'oldest-1',
              fileName: 'oldest-1.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 12, 30),
              createdAt: DateTime.utc(2026, 7, 3, 11, 30),
            ),
            _transfer(
              id: 'oldest-2',
              fileName: 'oldest-2.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 12, 30),
              createdAt: DateTime.utc(2026, 7, 3, 11),
            ),
            _transfer(
              id: 'oldest-3',
              fileName: 'oldest-3.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 11),
              createdAt: DateTime.utc(2026, 7, 3, 10),
            ),
          ],
        ),
      );

      await tester.tap(find.byKey(const Key('transfer-manager-sort-control')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('transfer-manager-sort-oldest')).first,
      );
      await tester.pumpAndSettle();

      expect(
        _transferOrder(tester, [
          'oldest-3',
          'oldest-2',
          'oldest-1',
        ]),
        isTrue,
      );
    });

    testWidgets(
      'file sort is case-insensitive and tie-breaks newest for matching names',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'file-lower',
                fileName: 'alpha.txt',
                status: SessionArtifactTransferStatus.completed,
                updatedAt: DateTime.utc(2026, 7, 3, 8),
                createdAt: DateTime.utc(2026, 7, 3, 8),
              ),
              _transfer(
                id: 'file-upper-new',
                fileName: 'Alpha.txt',
                status: SessionArtifactTransferStatus.completed,
                updatedAt: DateTime.utc(2026, 7, 3, 12),
                createdAt: DateTime.utc(2026, 7, 3, 12),
              ),
              _transfer(
                id: 'file-upper-old',
                fileName: 'Alpha.txt',
                status: SessionArtifactTransferStatus.completed,
                updatedAt: DateTime.utc(2026, 7, 3, 10),
                createdAt: DateTime.utc(2026, 7, 3, 10),
              ),
            ],
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-sort-control')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('transfer-manager-sort-file')).first,
        );
        await tester.pumpAndSettle();

        expect(
          _transferOrder(tester, [
            'file-upper-new',
            'file-upper-old',
            'file-lower',
          ]),
          isTrue,
        );
      },
    );

    testWidgets('status sort groups active, failed, then terminal rows', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'status-cached',
              fileName: 'cached.txt',
              status: SessionArtifactTransferStatus.cached,
              updatedAt: DateTime.utc(2026, 7, 3, 14),
              createdAt: DateTime.utc(2026, 7, 3, 14),
            ),
            _transfer(
              id: 'status-running',
              fileName: 'running.txt',
              status: SessionArtifactTransferStatus.running,
              updatedAt: DateTime.utc(2026, 7, 3, 15),
              createdAt: DateTime.utc(2026, 7, 3, 15),
            ),
            _transfer(
              id: 'status-failed',
              fileName: 'failed.txt',
              status: SessionArtifactTransferStatus.failed,
              updatedAt: DateTime.utc(2026, 7, 3, 13),
              createdAt: DateTime.utc(2026, 7, 3, 13),
            ),
            _transfer(
              id: 'status-queued',
              fileName: 'queued.txt',
              status: SessionArtifactTransferStatus.queued,
              updatedAt: DateTime.utc(2026, 7, 3, 14, 30),
              createdAt: DateTime.utc(2026, 7, 3, 14, 30),
            ),
            _transfer(
              id: 'status-completed',
              fileName: 'completed.txt',
              status: SessionArtifactTransferStatus.completed,
              updatedAt: DateTime.utc(2026, 7, 3, 12),
              createdAt: DateTime.utc(2026, 7, 3, 12),
            ),
            _transfer(
              id: 'status-canceled',
              fileName: 'canceled.txt',
              status: SessionArtifactTransferStatus.canceled,
              updatedAt: DateTime.utc(2026, 7, 3, 11),
              createdAt: DateTime.utc(2026, 7, 3, 11),
            ),
          ],
        ),
      );

      await tester.tap(find.byKey(const Key('transfer-manager-sort-control')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('transfer-manager-sort-status')).first,
      );
      await tester.pumpAndSettle();

      expect(
        _transferOrder(tester, [
          'status-running',
          'status-queued',
          'status-cached',
          'status-failed',
          'status-completed',
          'status-canceled',
        ]),
        isTrue,
      );
    });

    testWidgets(
      'search/filter composition works with sort and sorted row actions remain clickable',
      (
        tester,
      ) async {
        late GoRouter router;

        await tester.pumpWidget(
          _buildSubjectWithRouter(
            transfers: [
              _transfer(
                id: 'sfs-active-a',
                fileName: 'zeta-shared.txt',
                status: SessionArtifactTransferStatus.queued,
                sessionId: 'session-active',
                updatedAt: DateTime.utc(2026, 7, 3, 12),
                createdAt: DateTime.utc(2026, 7, 3, 12),
              ),
              _transfer(
                id: 'sfs-active-b',
                fileName: 'alpha-shared.txt',
                status: SessionArtifactTransferStatus.running,
                sessionId: 'session-active',
                updatedAt: DateTime.utc(2026, 7, 3, 13),
                createdAt: DateTime.utc(2026, 7, 3, 13),
              ),
              _transfer(
                id: 'sfs-failed',
                fileName: 'failure-shared.txt',
                status: SessionArtifactTransferStatus.failed,
                updatedAt: DateTime.utc(2026, 7, 3, 11),
                createdAt: DateTime.utc(2026, 7, 3, 11),
              ),
            ],
            onRouterCreated: (createdRouter) {
              router = createdRouter;
            },
          ),
        );

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'shared',
        );
        await tester.pump();

        await tester.tap(find.byKey(const Key('transfer-filter-active')));
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('transfer-manager-sort-control')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('transfer-manager-sort-file')).first,
        );
        await tester.pumpAndSettle();

        expect(
          _transferOrder(tester, [
            'sfs-active-b',
            'sfs-active-a',
          ]),
          isTrue,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-open-session-sfs-active-b'),
          ),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(
            const Key('transfer-manager-open-session-sfs-active-b'),
          ),
        );
        final expectedLocation = sessionDetailLocation(
          tool: 'claude',
          sessionId: 'session-active',
        );
        await _pumpUntilRoute(tester, router, expectedLocation);

        expect(
          router.routeInformationProvider.value.uri.toString(),
          expectedLocation,
        );
      },
    );

    testWidgets('open-session action stays available after filtering', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'open-session-filtered',
              fileName: 'visible.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
            _transfer(
              id: 'open-session-hidden',
              fileName: 'hidden.txt',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      await tester.enterText(
        find.byKey(const Key('transfer-manager-search-field')),
        'visible',
      );
      await tester.pump();

      expect(
        find.byKey(
          const Key('transfer-manager-open-session-open-session-filtered'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('dispatches retry and cancel through transfer worker', (
      tester,
    ) async {
      final worker = _RecordingTransferWorker();
      await tester.pumpWidget(
        _buildSubject(
          worker: worker,
          transfers: [
            _transfer(
              id: 'failed-transfer',
              fileName: 'failed.html',
              status: SessionArtifactTransferStatus.failed,
              message: 'Network failed',
            ),
            _transfer(
              id: 'running-transfer',
              fileName: 'running.html',
              status: SessionArtifactTransferStatus.running,
              message: 'Downloading...',
            ),
          ],
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-retry-failed-transfer')),
      );
      await tester.tap(
        find.byKey(const Key('transfer-manager-cancel-running-transfer')),
      );

      expect(worker.retriedIds, ['failed-transfer']);
      expect(worker.canceledIds, ['running-transfer']);
    });

    testWidgets(
      'bulk retry dispatches only visible selected retryable rows and ignores '
      'other selected rows',
      (tester) async {
        final worker = _RecordingTransferWorker();
        await tester.pumpWidget(
          _buildSubject(
            worker: worker,
            transfers: [
              _transfer(
                id: 'failed-download',
                fileName: 'failed-download.txt',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'canceled-download',
                fileName: 'canceled-download.txt',
                status: SessionArtifactTransferStatus.canceled,
              ),
              _transfer(
                id: 'upload-failed-download',
                fileName: 'upload-failed.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'running-download',
                fileName: 'running-download.txt',
                status: SessionArtifactTransferStatus.running,
              ),
              _transfer(
                id: 'completed-download',
                fileName: 'completed-download.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'queued-download',
                fileName: 'queued-download.txt',
                status: SessionArtifactTransferStatus.queued,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'failed-download');
        await _tapTransferSelection(tester, 'canceled-download');
        await _tapTransferSelection(tester, 'upload-failed-download');
        await _tapTransferSelection(tester, 'running-download');
        await _tapTransferSelection(tester, 'completed-download');
        await _tapTransferSelection(tester, 'queued-download');
        await tester.tap(
          find.byKey(const Key('transfer-manager-retry-selected')),
        );
        await tester.pumpAndSettle();

        expect(worker.retriedIds, [
          'failed-download',
          'canceled-download',
          'queued-download',
        ]);
        expect(worker.canceledIds, isEmpty);
        expect(find.text('Retrying 3 transfer(s)'), findsOneWidget);
      },
    );

    testWidgets(
      'bulk cancel dispatches only visible selected cancelable rows and '
      'ignores other selected rows',
      (tester) async {
        final worker = _RecordingTransferWorker();
        await tester.pumpWidget(
          _buildSubject(
            worker: worker,
            transfers: [
              _transfer(
                id: 'queued-download',
                fileName: 'queued-download.txt',
                status: SessionArtifactTransferStatus.queued,
              ),
              _transfer(
                id: 'running-download',
                fileName: 'running-download.txt',
                status: SessionArtifactTransferStatus.running,
              ),
              _transfer(
                id: 'cached-download',
                fileName: 'cached-download.txt',
                status: SessionArtifactTransferStatus.cached,
              ),
              _transfer(
                id: 'failed-download',
                fileName: 'failed-download.txt',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'completed-download',
                fileName: 'completed-download.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'upload-running',
                fileName: 'upload-running.txt',
                direction: SessionArtifactTransferDirection.upload,
                status: SessionArtifactTransferStatus.running,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'queued-download');
        await _tapTransferSelection(tester, 'running-download');
        await _tapTransferSelection(tester, 'cached-download');
        await _tapTransferSelection(tester, 'failed-download');
        await _tapTransferSelection(tester, 'completed-download');
        await _tapTransferSelection(tester, 'upload-running');
        await tester.tap(
          find.byKey(const Key('transfer-manager-cancel-selected')),
        );
        await tester.pumpAndSettle();

        expect(worker.canceledIds, [
          'queued-download',
          'running-download',
          'cached-download',
        ]);
        expect(worker.retriedIds, isEmpty);
        expect(find.text('Canceling 3 transfer(s)'), findsOneWidget);
      },
    );

    testWidgets(
      'hidden selected rows are ignored by bulk actions after search changes',
      (tester) async {
        final worker = _RecordingTransferWorker();
        await tester.pumpWidget(
          _buildSubject(
            worker: worker,
            transfers: [
              _transfer(
                id: 'retry-visible',
                fileName: 'visible-retry.txt',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'retry-hidden',
                fileName: 'hidden-retry.txt',
                status: SessionArtifactTransferStatus.failed,
              ),
              _transfer(
                id: 'queue-visible',
                fileName: 'visible-queue.txt',
                status: SessionArtifactTransferStatus.queued,
              ),
              _transfer(
                id: 'queue-hidden',
                fileName: 'hidden-queue.txt',
                status: SessionArtifactTransferStatus.queued,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'retry-visible');
        await _tapTransferSelection(tester, 'retry-hidden');
        await _tapTransferSelection(tester, 'queue-visible');
        await _tapTransferSelection(tester, 'queue-hidden');

        await tester.enterText(
          find.byKey(const Key('transfer-manager-search-field')),
          'visible',
        );
        await tester.pumpAndSettle();
        _expectVisibleSelectionSummary(tester, 2);

        await tester.tap(
          find.byKey(const Key('transfer-manager-retry-selected')),
        );
        await tester.pumpAndSettle();

        expect(worker.retriedIds, [
          'retry-visible',
          'queue-visible',
        ]);
        expect(worker.canceledIds, isEmpty);
        expect(find.text('Retrying 2 transfer(s)'), findsOneWidget);

        await tester.tap(
          find.byKey(const Key('transfer-manager-cancel-selected')),
        );
        await tester.pumpAndSettle();

        expect(worker.canceledIds, [
          'queue-visible',
        ]);
        expect(find.text('Canceling 1 transfer(s)'), findsOneWidget);
      },
    );

    testWidgets(
      'no eligible visible selected rows show no-op snackbar and dispatch '
      'nothing for bulk retry/cancel',
      (tester) async {
        final worker = _RecordingTransferWorker();
        await tester.pumpWidget(
          _buildSubject(
            worker: worker,
            transfers: [
              _transfer(
                id: 'completed-transfer',
                fileName: 'completed.txt',
                status: SessionArtifactTransferStatus.completed,
              ),
              _transfer(
                id: 'upload-active',
                fileName: 'upload-running.txt',
                status: SessionArtifactTransferStatus.running,
                direction: SessionArtifactTransferDirection.upload,
              ),
            ],
          ),
        );

        await _tapTransferSelection(tester, 'completed-transfer');
        await _tapTransferSelection(tester, 'upload-active');

        await tester.tap(
          find.byKey(const Key('transfer-manager-retry-selected')),
        );
        await tester.pumpAndSettle();
        expect(worker.retriedIds, isEmpty);
        expect(
          find.text('No selected transfers can be retried'),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-cancel-selected')),
        );
        await tester.pumpAndSettle();
        expect(worker.canceledIds, isEmpty);
        expect(
          find.text('No selected transfers can be canceled'),
          findsOneWidget,
        );
      },
    );

    testWidgets('shows exported path and copy button when path exists', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'completed-download',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/report.html',
            ),
          ],
        ),
      );

      expect(find.text('Saved: /tmp/exported/report.html'), findsOneWidget);
      expect(
        find.byKey(const Key('transfer-manager-copy-completed-download')),
        findsOneWidget,
      );
    });

    testWidgets('shows cached path and copy button for cached previews', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'cached-preview',
              fileName: 'preview.html',
              direction: SessionArtifactTransferDirection.preview,
              status: SessionArtifactTransferStatus.cached,
              cachedFilePath: '/tmp/cache/preview.html',
            ),
          ],
        ),
      );

      expect(find.text('Cached: /tmp/cache/preview.html'), findsOneWidget);
      expect(
        find.byKey(const Key('transfer-manager-copy-cached-preview')),
        findsOneWidget,
      );
    });

    testWidgets('prefers exported path over cached path for local path line', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'both-paths',
              fileName: 'dual-path.txt',
              status: SessionArtifactTransferStatus.completed,
              cachedFilePath: '/tmp/cache/dual-path.txt',
              exportedPath: '/tmp/exported/dual-path.txt',
            ),
          ],
        ),
      );

      expect(find.text('Saved: /tmp/exported/dual-path.txt'), findsOneWidget);
      expect(find.text('Cached: /tmp/cache/dual-path.txt'), findsNothing);
    });

    testWidgets('copy button writes path to clipboard and shows snackbar', (
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
        _buildSubject(
          transfers: [
            _transfer(
              id: 'completed-copy-snackbar',
              fileName: 'report.txt',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/report.txt',
            ),
          ],
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-copy-completed-copy-snackbar')),
      );
      await tester.pumpAndSettle();

      expect(copiedText, '/tmp/exported/report.txt');
      expect(find.text('Path copied to clipboard'), findsOneWidget);
    });

    testWidgets('shows open and reveal actions for local path rows', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'completed-copy-snackbar',
              fileName: 'report.txt',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/report.txt',
            ),
          ],
        ),
      );

      expect(
        find.byKey(const Key('transfer-manager-open-completed-copy-snackbar')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('transfer-manager-reveal-completed-copy-snackbar'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('transfer-manager-preview-completed-copy-snackbar'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('does not show open/reveal actions when no local path exists', (
      tester,
    ) async {
      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'missing-path',
              status: SessionArtifactTransferStatus.completed,
            ),
          ],
        ),
      );

      expect(
        find.byKey(const Key('transfer-manager-open-missing-path')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('transfer-manager-reveal-missing-path')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('transfer-manager-preview-missing-path')),
        findsNothing,
      );
    });

    testWidgets(
      'details action opens metadata surface with full metadata and both '
      'local paths',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'details-both-paths',
                fileName: 'artifact.txt',
                status: SessionArtifactTransferStatus.completed,
                bytesTransferred: 7,
                totalBytes: 13,
                createdAt: DateTime.utc(2026, 7, 2, 9),
                updatedAt: DateTime.utc(2026, 7, 2, 10),
                cachedFilePath: '/tmp/cache/artifact.txt',
                exportedPath: '/tmp/exported/artifact.txt',
              ),
            ],
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-details-details-both-paths')),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const Key('transfer-manager-details-title-details-both-paths'),
          ),
          findsOneWidget,
        );
        expect(find.text('Transfer details: artifact.txt'), findsOneWidget);
        expect(find.text('Direction:'), findsOneWidget);
        expect(find.text('Download'), findsOneWidget);
        expect(find.text('Status:'), findsOneWidget);
        expect(find.text('Complete'), findsOneWidget);
        expect(find.text('Message:'), findsNothing);
        expect(find.text('7/13 bytes'), findsOneWidget);
        expect(find.text('Progress:'), findsOneWidget);
        expect(find.text('Tool:'), findsOneWidget);
        expect(find.text('claude'), findsOneWidget);
        expect(find.text('Session ID:'), findsOneWidget);
        expect(find.text('session-a'), findsOneWidget);
        expect(find.text('Transfer ID:'), findsOneWidget);
        expect(find.text('details-both-paths'), findsAtLeastNWidgets(2));
        expect(find.text('Action key:'), findsOneWidget);
        expect(
          find.text('Source URL:'),
          findsOneWidget,
        );
        expect(find.text('/artifact/details-both-paths'), findsOneWidget);
        expect(
          find.text('Exported path:'),
          findsOneWidget,
        );
        expect(find.text('/tmp/exported/artifact.txt'), findsOneWidget);
        expect(
          find.text('Cached path:'),
          findsOneWidget,
        );
        expect(find.text('/tmp/cache/artifact.txt'), findsOneWidget);
        expect(
          find.text('Created:'),
          findsOneWidget,
        );
        expect(find.text('2026-07-02T09:00:00.000Z'), findsOneWidget);
        expect(
          find.text('Updated:'),
          findsOneWidget,
        );
        expect(find.text('2026-07-02T10:00:00.000Z'), findsOneWidget);
      },
    );

    testWidgets(
      'details local action buttons are absent when no local path exists',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'details-no-path',
                status: SessionArtifactTransferStatus.completed,
              ),
            ],
          ),
        );

        expect(
          find.byKey(const Key('transfer-manager-details-details-no-path')),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const Key('transfer-manager-details-details-no-path')),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const Key('transfer-manager-details-title-details-no-path'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-details-copy-details-no-path'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-details-open-details-no-path'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-details-reveal-details-no-path'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key('transfer-manager-details-preview-details-no-path'),
          ),
          findsNothing,
        );
      },
    );

    testWidgets(
      'details local actions use exported path over cached path for '
      'boundary calls',
      (
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

        final fileOpener = _RecordingTransferFileOpener(
          previewResult: const LocalTransferTextPreviewResult.success(
            'from exported path',
            isTruncated: false,
          ),
        );

        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'details-path-preference',
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cache/file.txt',
                exportedPath: '/tmp/exported/file.txt',
              ),
            ],
            fileOpener: fileOpener,
          ),
        );

        await tester.tap(
          find.byKey(
            const Key('transfer-manager-details-details-path-preference'),
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(
            const Key('transfer-manager-details-copy-details-path-preference'),
          ),
        );
        await tester.tap(
          find.byKey(
            const Key('transfer-manager-details-copy-details-path-preference'),
          ),
        );
        await tester.pump();

        await tester.ensureVisible(
          find.byKey(
            const Key('transfer-manager-details-open-details-path-preference'),
          ),
        );
        await tester.tap(
          find.byKey(
            const Key('transfer-manager-details-open-details-path-preference'),
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(
            const Key(
              'transfer-manager-details-reveal-details-path-preference',
            ),
          ),
        );
        await tester.tap(
          find.byKey(
            const Key(
              'transfer-manager-details-reveal-details-path-preference',
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(
            const Key(
              'transfer-manager-details-preview-details-path-preference',
            ),
          ),
        );
        await tester.tap(
          find.byKey(
            const Key(
              'transfer-manager-details-preview-details-path-preference',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(copiedText, '/tmp/exported/file.txt');
        expect(fileOpener.openedPaths, ['/tmp/exported/file.txt']);
        expect(fileOpener.revealedPaths, ['/tmp/exported/file.txt']);
        expect(fileOpener.previewedPaths, ['/tmp/exported/file.txt']);
      },
    );

    testWidgets('preview action shows text preview dialog', (tester) async {
      final fileOpener = _RecordingTransferFileOpener(
        previewResult: const LocalTransferTextPreviewResult.success(
          'hello\nworld',
          isTruncated: false,
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'preview-success',
              fileName: 'note.txt',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/note.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-preview-preview-success')),
      );
      await tester.pumpAndSettle();

      expect(fileOpener.previewedPaths, ['/tmp/exported/note.txt']);
      expect(
        find.byKey(
          const Key('transfer-manager-preview-title-preview-success'),
        ),
        findsOneWidget,
      );
      expect(find.text('Text preview: note.txt'), findsOneWidget);
      expect(
        find.byKey(
          const Key('transfer-manager-preview-filename-preview-success'),
        ),
        findsOneWidget,
      );
      expect(find.text('Path: /tmp/exported/note.txt'), findsOneWidget);
      expect(
        find.byKey(
          const Key('transfer-manager-preview-content-preview-success'),
        ),
        findsOneWidget,
      );
      final previewText = tester.widget<SelectableText>(
        find.byKey(
          const Key('transfer-manager-preview-content-preview-success'),
        ),
      );
      expect(previewText.data, 'hello\nworld');
      expect(
        find.byKey(
          const Key('transfer-manager-preview-truncated-preview-success'),
        ),
        findsNothing,
      );
    });

    testWidgets('preview action prefers exported path over cached path', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener(
        previewResult: const LocalTransferTextPreviewResult.success(
          'content',
          isTruncated: false,
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'preview-path-preference',
              status: SessionArtifactTransferStatus.completed,
              cachedFilePath: '/tmp/cache/file.txt',
              exportedPath: '/tmp/exported/file.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(
          const Key('transfer-manager-preview-preview-path-preference'),
        ),
      );
      await tester.pumpAndSettle();

      expect(fileOpener.previewedPaths, ['/tmp/exported/file.txt']);
    });

    testWidgets('preview action notes truncation when truncated', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener(
        previewResult: const LocalTransferTextPreviewResult.success(
          'truncated content',
          isTruncated: true,
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'preview-truncated',
              fileName: 'large.txt',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/large.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-preview-preview-truncated')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Preview truncated to 64 KiB.'), findsOneWidget);
    });

    testWidgets('preview action shows binary message for non-text content', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener(
        previewResult: const LocalTransferTextPreviewResult.binary(
          'binary content',
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'preview-binary',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/binary.bin',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-preview-preview-binary')),
      );
      await tester.pumpAndSettle();

      expect(
        find.text(
          "This file contains binary data and can't be previewed as text.",
        ),
        findsOneWidget,
      );
      expect(find.text('binary content'), findsNothing);
    });

    testWidgets(
      'preview action shows unsupported message on unsupported platform',
      (
        tester,
      ) async {
        final fileOpener = _RecordingTransferFileOpener(
          previewResult: const LocalTransferTextPreviewResult.unsupported(
            'Preview text is not supported on this platform.',
          ),
        );

        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'preview-unsupported',
                status: SessionArtifactTransferStatus.completed,
                exportedPath: '/tmp/exported/unsupported.txt',
              ),
            ],
            fileOpener: fileOpener,
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-preview-preview-unsupported')),
        );
        await tester.pumpAndSettle();

        expect(
          find.text("Text preview isn't supported on this device."),
          findsOneWidget,
        );
        expect(
          find.text('Preview text is not supported on this platform.'),
          findsNothing,
        );
      },
    );

    testWidgets('preview action shows failure snackbar on error result', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener(
        previewResult: const LocalTransferTextPreviewResult.failed(
          'Could not read file',
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'preview-failure',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/failed.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-preview-preview-failure')),
      );
      await tester.pumpAndSettle();

      expect(
        find.text("Couldn't preview this file. Try again."),
        findsOneWidget,
      );
      expect(find.textContaining('Could not read file'), findsNothing);
    });

    testWidgets(
      'open action uses exported path over cached path and shows success',
      (
        tester,
      ) async {
        final fileOpener = _RecordingTransferFileOpener();

        await tester.pumpWidget(
          _buildSubject(
            transfers: [
              _transfer(
                id: 'both-paths-open',
                status: SessionArtifactTransferStatus.completed,
                cachedFilePath: '/tmp/cache/file.txt',
                exportedPath: '/tmp/exported/file.txt',
              ),
            ],
            fileOpener: fileOpener,
          ),
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-open-both-paths-open')),
        );
        await tester.pumpAndSettle();

        expect(fileOpener.openedPaths, ['/tmp/exported/file.txt']);
        expect(find.text('Opened file'), findsOneWidget);
      },
    );

    testWidgets('open action shows failure snackbar on error result', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener(
        openResult: const LocalTransferFileActionResult.failed(
          'Cannot launch application',
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'open-failure',
              status: SessionArtifactTransferStatus.completed,
              exportedPath: '/tmp/exported/file.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-open-open-failure')),
      );
      await tester.pumpAndSettle();

      expect(fileOpener.openedPaths, ['/tmp/exported/file.txt']);
      expect(
        find.text("Couldn't open the file. Try again."),
        findsOneWidget,
      );
      expect(find.textContaining('Cannot launch application'), findsNothing);
    });

    testWidgets('reveal action shows success snackbar on success result', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener();

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'reveal-success',
              status: SessionArtifactTransferStatus.completed,
              cachedFilePath: '/tmp/cache/file.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-reveal-reveal-success')),
      );
      await tester.pumpAndSettle();

      expect(fileOpener.revealedPaths, ['/tmp/cache/file.txt']);
      expect(find.text('Revealed in folder'), findsOneWidget);
    });

    testWidgets('reveal action shows failure snackbar on error result', (
      tester,
    ) async {
      final fileOpener = _RecordingTransferFileOpener(
        revealResult: const LocalTransferFileActionResult.failed(
          'Could not open folder',
        ),
      );

      await tester.pumpWidget(
        _buildSubject(
          transfers: [
            _transfer(
              id: 'reveal-failure',
              status: SessionArtifactTransferStatus.completed,
              cachedFilePath: '/tmp/cache/file.txt',
            ),
          ],
          fileOpener: fileOpener,
        ),
      );

      await tester.tap(
        find.byKey(const Key('transfer-manager-reveal-reveal-failure')),
      );
      await tester.pumpAndSettle();

      expect(fileOpener.revealedPaths, ['/tmp/cache/file.txt']);
      expect(
        find.text("Couldn't show the file in its folder. Try again."),
        findsOneWidget,
      );
      expect(find.textContaining('Could not open folder'), findsNothing);
    });

    testWidgets(
      'clear terminal records action removes completed/canceled/failed rows while preserving active',
      (tester) async {
        final controller = _TrackingTransferController([
          _transfer(
            id: 'queued-transfer',
            fileName: 'queued.txt',
            status: SessionArtifactTransferStatus.queued,
          ),
          _transfer(
            id: 'running-transfer',
            fileName: 'running.txt',
            status: SessionArtifactTransferStatus.running,
          ),
          _transfer(
            id: 'cached-transfer',
            fileName: 'cached.txt',
            status: SessionArtifactTransferStatus.cached,
          ),
          _transfer(
            id: 'completed-transfer',
            fileName: 'completed.txt',
            status: SessionArtifactTransferStatus.completed,
            exportedPath: '/tmp/exported/completed.txt',
          ),
          _transfer(
            id: 'failed-transfer',
            fileName: 'failed.txt',
            status: SessionArtifactTransferStatus.failed,
            message: 'network',
          ),
          _transfer(
            id: 'canceled-transfer',
            fileName: 'canceled.txt',
            status: SessionArtifactTransferStatus.canceled,
          ),
        ]);

        await tester.pumpWidget(
          _buildSubject(
            transfers: [],
            controller: controller,
          ),
        );

        await tester.tap(find.byKey(const Key('transfer-filter-active')));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('transfer-manager-clear-terminal-transfers')),
          findsOneWidget,
        );
        expect(find.text('Download: queued.txt'), findsOneWidget);
        expect(find.text('Download: running.txt'), findsOneWidget);
        expect(find.text('Download: cached.txt'), findsOneWidget);
        expect(find.text('No active transfers'), findsNothing);

        expect(
          find.byKey(const Key('transfer-filter-active')),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const Key('transfer-manager-clear-terminal-transfers')),
        );
        await tester.pumpAndSettle();

        expect(controller.clearTerminalTransferCalls, 1);
        await tester.tap(find.byKey(const Key('transfer-filter-all')));
        await tester.pumpAndSettle();
        expect(find.text('Download: completed.txt'), findsNothing);
        expect(find.text('Download: failed.txt'), findsNothing);
        expect(find.text('Download: canceled.txt'), findsNothing);
        expect(find.text('Download: queued.txt'), findsOneWidget);
        expect(find.text('Download: running.txt'), findsOneWidget);
        expect(find.text('Download: cached.txt'), findsOneWidget);
      },
    );
  });
}

bool _transferOrder(WidgetTester tester, List<String> transferIds) {
  if (transferIds.isEmpty || transferIds.length == 1) {
    return true;
  }

  final positions = <double>[];
  for (final id in transferIds) {
    final rowFinder = find.byKey(ValueKey('transfer-manager-open-session-$id'));
    if (rowFinder.evaluate().isEmpty) {
      return false;
    }
    positions.add(tester.getTopLeft(rowFinder).dy);
  }

  for (var i = 0; i < positions.length - 1; i++) {
    if (positions[i] >= positions[i + 1]) {
      return false;
    }
  }
  return true;
}

void _expectVisibleSelectionSummary(WidgetTester tester, int count) {
  expect(
    find.descendant(
      of: find.byKey(const Key('transfer-manager-selection-summary')),
      matching: find.text('Selected $count visible transfer(s)'),
    ),
    findsOneWidget,
  );
}

void _expectNoVisibleTransferSelectionSummary(WidgetTester tester) {
  expect(
    find.byKey(const Key('transfer-manager-selection-summary')),
    findsNothing,
  );
}

Future<void> _tapTransferSelection(
  WidgetTester tester,
  String transferId,
) async {
  final finder = find.byKey(ValueKey('transfer-manager-select-$transferId'));
  if (finder.hitTestable().evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      120,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
  }
  await tester.tap(finder.hitTestable());
  await tester.pumpAndSettle();
}

Future<void> _pumpUntilRoute(
  WidgetTester tester,
  GoRouter router,
  String expectedLocation, {
  Finder? content,
  Finder? absent,
}) async {
  for (var attempt = 0; attempt < 20; attempt++) {
    await tester.pump(const Duration(milliseconds: 16));
    final routeReady =
        router.routeInformationProvider.value.uri.toString() ==
        expectedLocation;
    final contentReady = content == null || content.evaluate().isNotEmpty;
    final absentReady = absent == null || absent.evaluate().isEmpty;
    if (routeReady && contentReady && absentReady) return;
  }
  throw TestFailure('Route did not render within 20 frames: $expectedLocation');
}

Future<void> _sendShortcut({
  required LogicalKeyboardKey key,
  required WidgetTester tester,
  LogicalKeyboardKey? modifier,
}) async {
  if (modifier != null) {
    await tester.sendKeyDownEvent(modifier);
  }
  await tester.sendKeyDownEvent(key);
  await tester.sendKeyUpEvent(key);
  if (modifier != null) {
    await tester.sendKeyUpEvent(modifier);
  }
  await tester.pump();
}

Future<void> _focusTransferManagerControls(WidgetTester tester) async {
  Focus.of(tester.element(find.byType(Scaffold))).requestFocus();
  await tester.pump();
}

Widget _buildSubject({
  required List<SessionArtifactTransfer> transfers,
  bool hasActiveBrokerClient = false,
  String? activeBrokerProfileId = 'profile-a',
  _RecordingTransferWorker? worker,
  _TrackingTransferController? controller,
  LocalTransferFileOpener? fileOpener,
}) {
  return ProviderScope(
    overrides: [
      sessionArtifactTransferRepositoryProvider.overrideWithValue(
        InMemorySessionArtifactTransferRepository(),
      ),
      sessionArtifactTransferControllerProvider.overrideWith(
        () => controller ?? _SeededTransferController(transfers),
      ),
      if (activeBrokerProfileId != null)
        activeBrokerProfileProvider.overrideWith(
          (ref) => BrokerProfile(
            id: activeBrokerProfileId,
            displayName: activeBrokerProfileId,
            baseUri: Uri.parse('http://$activeBrokerProfileId.test'),
            createdAt: DateTime(2026, 7, 17),
          ),
        ),
      if (hasActiveBrokerClient)
        brokerClientProvider.overrideWith(
          (ref) async => BrokerClient(baseUrl: 'http://127.0.0.1:7734'),
        )
      else
        brokerClientProvider.overrideWith(
          (ref) async => null,
        ),
      if (worker != null)
        sessionArtifactTransferWorkerProvider.overrideWithValue(worker),
      if (fileOpener != null)
        localTransferFileOpenerProvider.overrideWithValue(fileOpener),
    ],
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ThemeData(
        splashFactory: InkRipple.splashFactory,
        extensions: [themeSpecById(kDefaultThemeId).light],
      ),
      home: const TransferManagerPage(),
    ),
  );
}

Widget _buildSubjectWithRouter({
  required List<SessionArtifactTransfer> transfers,
  required void Function(GoRouter router) onRouterCreated,
  bool hasActiveBrokerClient = false,
  _RecordingTransferWorker? worker,
  _TrackingTransferController? controller,
  LocalTransferFileOpener? fileOpener,
}) {
  final router = createGoRouter(initialLocation: '/transfers');
  onRouterCreated(router);

  return _wrapTransferProviders(
    transfers: transfers,
    hasActiveBrokerClient: hasActiveBrokerClient,
    worker: worker,
    controller: controller,
    fileOpener: fileOpener,
    child: MaterialApp.router(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ThemeData(
        splashFactory: InkRipple.splashFactory,
        extensions: [themeSpecById(kDefaultThemeId).light],
      ),
      routerConfig: router,
    ),
  );
}

Widget _wrapTransferProviders({
  required List<SessionArtifactTransfer> transfers,
  required Widget child,
  bool hasActiveBrokerClient = false,
  _RecordingTransferWorker? worker,
  _TrackingTransferController? controller,
  LocalTransferFileOpener? fileOpener,
}) {
  return ProviderScope(
    overrides: [
      sessionArtifactTransferRepositoryProvider.overrideWithValue(
        InMemorySessionArtifactTransferRepository(),
      ),
      sessionNotificationSettingsStoreProvider.overrideWithValue(
        _InMemorySessionNotificationSettingsStore(),
      ),
      sessionLiveStateViewStoreProvider.overrideWithValue(
        InMemorySessionLiveStateViewStore(),
      ),
      // DR1: the routed SessionDetailPage flushes its durable draft through
      // the app database on dispose; keep it on an in-memory database here.
      appDatabaseProvider.overrideWithValue(
        () {
          final database = AppDatabase(NativeDatabase.memory());
          addTearDown(database.close);
          return database;
        }(),
      ),
      activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
      sessionListRepositoryProvider.overrideWith(
        (_) async => InMemorySessionListRepository(),
      ),
      sessionOutboxRepositoryProvider.overrideWithValue(
        InMemorySessionOutboxRepository(),
      ),
      sessionTranscriptRepositoryProvider.overrideWithValue(
        InMemorySessionTranscriptRepository(),
      ),
      sessionDisplayPreferencesStoreProvider.overrideWithValue(
        InMemorySessionDisplayPreferencesStore(),
      ),
      sessionControlPreferencesStoreProvider.overrideWithValue(
        InMemorySessionControlPreferencesStore(),
      ),
      sessionDriveIntentStoreProvider.overrideWithValue(
        InMemorySessionDriveIntentStore(),
      ),
      sessionModelPreferenceStoreProvider.overrideWithValue(
        InMemorySessionModelPreferenceStore(),
      ),
      // The routed SessionDetailPage reads the D1 debug-view preference; keep
      // it off a real Drift database in this shell test.
      uiPreferencesStoreProvider.overrideWithValue(
        InMemoryUiPreferencesStore(),
      ),
      openSessionsStoreProvider.overrideWithValue(InMemoryOpenSessionsStore()),
      sessionArtifactTransferControllerProvider.overrideWith(
        () => controller ?? _SeededTransferController(transfers),
      ),
      activeBrokerProfileProvider.overrideWith(
        (ref) => BrokerProfile(
          id: 'profile-a',
          displayName: 'profile-a',
          baseUri: Uri.parse('http://profile-a.test'),
          createdAt: DateTime(2026, 7, 17),
        ),
      ),
      if (hasActiveBrokerClient)
        brokerClientProvider.overrideWith(
          (ref) async => BrokerClient(baseUrl: 'http://127.0.0.1:7734'),
        )
      else
        brokerClientProvider.overrideWith(
          (ref) async => null,
        ),
      if (worker != null)
        sessionArtifactTransferWorkerProvider.overrideWithValue(worker),
      if (fileOpener != null)
        localTransferFileOpenerProvider.overrideWithValue(fileOpener),
    ],
    child: child,
  );
}

/// Scope key (`RosterSource.storageKey`) of the fixture profile [profileId]
/// as [_buildSubject] derives it — the value the provider-built worker stamps
/// rows with and action gating compares against.
String _scopeFor(String profileId) => RosterSource.ofProfile(
  BrokerProfile(
    id: profileId,
    displayName: profileId,
    baseUri: Uri.parse('http://$profileId.test'),
    createdAt: DateTime(2026, 7, 17),
  ),
).storageKey;

SessionArtifactTransfer _transfer({
  required String id,
  required SessionArtifactTransferStatus status,
  String? brokerProfileId = 'profile-a',
  String tool = 'claude',
  String sessionId = 'session-a',
  String fileName = 'report.html',
  SessionArtifactTransferDirection direction =
      SessionArtifactTransferDirection.download,
  String message = '',
  int? bytesTransferred,
  int? byteLength,
  int? totalBytes,
  String? cachedFilePath,
  String? exportedPath,
  String? sourceUrl,
  String? artifactKey,
  String? contentHash,
  String? uploadId,
  String? actionKey,
  String? error,
  DateTime? createdAt,
  DateTime? updatedAt,
}) {
  return SessionArtifactTransfer(
    id: id,
    // A profile-id argument names the OWNING profile; rows are stamped with
    // that profile's exact scope key, as production stamping does. Null stays
    // null: a legacy unscoped row.
    brokerProfileId: brokerProfileId == null
        ? null
        : _scopeFor(brokerProfileId),
    sessionKey: SessionDetailKey(tool: tool, sessionId: sessionId),
    actionKey: actionKey ?? id,
    fileName: fileName,
    direction: direction,
    status: status,
    sourceUrl: sourceUrl ?? '/artifact/$id',
    uploadId: uploadId,
    message: message,
    error: error,
    cachedFilePath: cachedFilePath,
    exportedPath: exportedPath,
    artifactKey: artifactKey,
    contentHash: contentHash,
    bytesTransferred: bytesTransferred,
    byteLength: byteLength,
    totalBytes: totalBytes,
    createdAt: createdAt ?? DateTime(2026, 7, 2, 9),
    updatedAt: updatedAt ?? DateTime(2026, 7, 2, 10),
  );
}

final class _SeededTransferController
    extends SessionArtifactTransferController {
  _SeededTransferController(this._transfers);

  final List<SessionArtifactTransfer> _transfers;

  @override
  List<SessionArtifactTransfer> build() => _transfers;
}

final class _TrackingTransferController
    extends SessionArtifactTransferController {
  _TrackingTransferController(this._transfers);

  final List<SessionArtifactTransfer> _transfers;
  int clearTerminalTransferCalls = 0;

  @override
  List<SessionArtifactTransfer> build() => _transfers;

  @override
  void clearTerminalTransfers() {
    clearTerminalTransferCalls++;
    super.clearTerminalTransfers();
  }
}

final class _RecordingTransferWorker extends SessionArtifactTransferWorker {
  _RecordingTransferWorker({
    this.selectFileToResumeUploadResult =
        const SessionArtifactTransferWorkerResult(
          transferId: '',
          outcome: SessionArtifactTransferWorkerOutcome.canceled,
          message: 'Upload resume selection was canceled.',
        ),
  }) : super(
         fileService: const _NoopFileService(),
         transferController: _UnusedTransferController(),
       );

  final retriedIds = <String>[];
  final canceledIds = <String>[];
  final selectedFileToResumeTransferIds = <String>[];
  final SessionArtifactTransferWorkerResult selectFileToResumeUploadResult;

  @override
  Future<SessionArtifactTransferWorkerResult> selectFileToResumeUpload({
    required String transferId,
  }) async {
    selectedFileToResumeTransferIds.add(transferId);
    return selectFileToResumeUploadResult;
  }

  @override
  Future<SessionArtifactTransferWorkerResult> retryTransfer(
    String transferId, {
    required bool hasActiveBrokerClient,
  }) async {
    retriedIds.add(transferId);
    return SessionArtifactTransferWorkerResult(
      transferId: transferId,
      outcome: SessionArtifactTransferWorkerOutcome.failed,
    );
  }

  @override
  void cancelTransfer(String transferId) {
    canceledIds.add(transferId);
  }
}

const String _canonicalSha256Hash =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';

final class _RecordingTransferFileOpener implements LocalTransferFileOpener {
  _RecordingTransferFileOpener({
    this.openResult = const LocalTransferFileActionResult.success(),
    this.revealResult = const LocalTransferFileActionResult.success(),
    this.previewResult = const LocalTransferTextPreviewResult.success(
      'preview content',
      isTruncated: false,
    ),
  });

  final LocalTransferFileActionResult openResult;
  final LocalTransferFileActionResult revealResult;
  final LocalTransferTextPreviewResult previewResult;
  final openedPaths = <String>[];
  final revealedPaths = <String>[];
  final previewedPaths = <String>[];

  @override
  Future<LocalTransferFileActionResult> openFile(String localPath) async {
    openedPaths.add(localPath);
    return openResult;
  }

  @override
  Future<LocalTransferFileActionResult> revealInFolder(String localPath) async {
    revealedPaths.add(localPath);
    return revealResult;
  }

  @override
  Future<LocalTransferTextPreviewResult> previewTextFile(
    String localPath, {
    int maxBytes = 64 * 1024,
  }) async {
    previewedPaths.add(localPath);
    return previewResult;
  }
}

final class _UnusedTransferController
    extends SessionArtifactTransferController {}

final class _NoopFileService implements SessionArtifactFileService {
  const _NoopFileService();

  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  }) {
    throw UnimplementedError();
  }
}

final class _InMemorySessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  bool value = false;

  @override
  Future<bool> getLocalNotificationEnabled() async => value;

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    value = enabled;
  }
}

Finder _textWidget(String text) {
  return find.byWidgetPredicate(
    (widget) => widget is Text && widget.data == text,
  );
}
