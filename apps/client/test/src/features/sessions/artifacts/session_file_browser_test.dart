import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionFileBrowserController', () {
    const sessionKey = SessionDetailKey(
      tool: 'claude',
      sessionId: 'session-1',
    );

    late _FakeSessionFileBrowserRepository repository;
    late ProviderContainer container;

    setUp(() {
      repository = _FakeSessionFileBrowserRepository();
      container = ProviderContainer(
        overrides: [
          sessionFileBrowserRepositoryProvider.overrideWith(
            (ref) async => repository,
          ),
        ],
      );
    });

    tearDown(() {
      container.dispose();
    });

    test(
      'loads entries grouped directories first and builds breadcrumbs',
      () async {
        repository.listing = const FsDirectoryResult(
          path: 'src/lib',
          stat: FsNodeInfo(
            path: 'src/lib',
            type: 'directory',
            size: 0,
            mtimeMs: 0,
            isDirectory: true,
            isRegularFile: false,
            isSymbolicLink: false,
          ),
          entries: [
            FsDirEntry(
              name: 'zeta.txt',
              path: 'src/lib/zeta.txt',
              type: 'file',
              size: 1,
              mtimeMs: 0,
            ),
            FsDirEntry(
              name: 'alpha',
              path: 'src/lib/alpha',
              type: 'directory',
              size: 0,
              mtimeMs: 0,
            ),
            FsDirEntry(
              name: 'link',
              path: 'src/lib/link',
              type: 'symlink',
              size: 0,
              mtimeMs: 0,
            ),
          ],
        );

        await container
            .read(sessionFileBrowserControllerProvider(sessionKey).notifier)
            .load(path: r'.\src/lib');

        final state = container.read(
          sessionFileBrowserControllerProvider(sessionKey),
        );
        expect(state.phase, SessionFileBrowserPhase.ready);
        expect(repository.lastListedPath, 'src/lib');
        expect(state.groupedEntries.map((entry) => entry.name), [
          'alpha',
          'zeta.txt',
          'link',
        ]);
        expect(state.breadcrumbs.map((crumb) => crumb.label), [
          'Workspace',
          'src',
          'lib',
        ]);
      },
    );

    test('remote disabled maps to first-class state', () async {
      repository.listError = const BrokerException(
        message: 'Request failed',
        statusCode: 403,
        error: BrokerError(
          error: 'Remote file access is disabled',
          code: 'FS_REMOTE_DISABLED',
        ),
      );

      await container
          .read(sessionFileBrowserControllerProvider(sessionKey).notifier)
          .load();

      final state = container.read(
        sessionFileBrowserControllerProvider(sessionKey),
      );
      expect(state.phase, SessionFileBrowserPhase.remoteDisabled);
      expect(state.errorCode, 'FS_REMOTE_DISABLED');
      expect(state.notice, SessionFileBrowserNotice.remoteDisabled);
      expect(state.technicalDetail, isNotEmpty);
    });

    test('bounds an oversized broker body in file-browser state', () async {
      repository.listError = BrokerException(
        message: 'file-body:${'x' * 5000}:unbounded-tail',
        statusCode: 500,
      );

      await container
          .read(sessionFileBrowserControllerProvider(sessionKey).notifier)
          .load();

      final detail = container
          .read(sessionFileBrowserControllerProvider(sessionKey))
          .technicalDetail;
      expect(detail, isNotNull);
      expect(detail!.length, maxTechnicalDetailLength);
      expect(detail, endsWith('…'));
      expect(detail, isNot(contains('unbounded-tail')));
    });

    test('preview decodes base64 text only after MIME check', () async {
      repository.readResult = FsReadResult(
        path: 'notes.txt',
        size: 12,
        limit: 8,
        truncated: true,
        encoding: 'base64',
        data: base64.encode(utf8.encode('hello')),
        mimeType: 'text/plain',
      );

      final preview = await container
          .read(sessionFileBrowserControllerProvider(sessionKey).notifier)
          .previewFile(
            const FsDirEntry(
              name: 'notes.txt',
              path: 'notes.txt',
              type: 'file',
              size: 12,
              mtimeMs: 0,
            ),
          );

      expect(preview?.text, 'hello');
      expect(preview?.truncated, isTrue);
      expect(repository.lastReadPath, 'notes.txt');
      expect(repository.lastReadMaxBytes, sessionFilePreviewDefaultMaxBytes);
    });
  });
}

class _FakeSessionFileBrowserRepository
    implements SessionFileBrowserRepository {
  FsDirectoryResult listing = const FsDirectoryResult(
    path: '',
    stat: FsNodeInfo(
      path: '',
      type: 'directory',
      size: 0,
      mtimeMs: 0,
      isDirectory: true,
      isRegularFile: false,
      isSymbolicLink: false,
    ),
    entries: [],
  );
  FsReadResult readResult = const FsReadResult(
    path: '',
    size: 0,
    limit: sessionFilePreviewDefaultMaxBytes,
    truncated: false,
    encoding: 'utf8',
    data: '',
    mimeType: 'text/plain',
  );
  BrokerException? listError;
  String? lastListedPath;
  String? lastReadPath;
  int? lastReadMaxBytes;

  @override
  Future<FsDirectoryResult> listPath(
    SessionDetailKey sessionKey, {
    String path = '',
  }) async {
    lastListedPath = path;
    final error = listError;
    if (error != null) {
      throw error;
    }
    return listing;
  }

  @override
  Future<FsReadResult> readFile(
    SessionDetailKey sessionKey, {
    required String path,
    int maxBytes = sessionFilePreviewDefaultMaxBytes,
  }) async {
    lastReadPath = path;
    lastReadMaxBytes = maxBytes;
    return readResult;
  }
}
