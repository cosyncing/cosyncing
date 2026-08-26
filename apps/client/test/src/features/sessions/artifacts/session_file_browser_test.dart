import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionFileBrowserController', () {
    const sessionKey = SessionDetailKey(
      tool: 'claude',
      sessionId: 'session-1',
    );
    const browserKey = SessionFileBrowserKey(
      brokerScopeKey: 'profile-a@http%3A%2F%2F127.0.0.1%3A7734#gen-1',
      session: sessionKey,
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
            .read(sessionFileBrowserControllerProvider(browserKey).notifier)
            .load(path: r'.\src/lib');

        final state = container.read(
          sessionFileBrowserControllerProvider(browserKey),
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
          .read(sessionFileBrowserControllerProvider(browserKey).notifier)
          .load();

      final state = container.read(
        sessionFileBrowserControllerProvider(browserKey),
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
          .read(sessionFileBrowserControllerProvider(browserKey).notifier)
          .load();

      final detail = container
          .read(sessionFileBrowserControllerProvider(browserKey))
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
          .read(sessionFileBrowserControllerProvider(browserKey).notifier)
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

    group('gate probe', () {
      test('a workspace-root answer opens the gate', () async {
        await container
            .read(sessionFileBrowserControllerProvider(browserKey).notifier)
            .probeGate();

        expect(
          container.read(sessionFileBrowserControllerProvider(browserKey)).gate,
          SessionFileLinkGate.open,
        );
        expect(repository.listedPaths, ['']);
      });

      test('403 closes the gate as remote-disabled', () async {
        repository.listError = const BrokerException(
          message: 'Request failed',
          statusCode: 403,
          error: BrokerError(
            error: 'Remote file access is disabled',
            code: 'FS_REMOTE_DISABLED',
          ),
        );

        await container
            .read(sessionFileBrowserControllerProvider(browserKey).notifier)
            .probeGate();

        final state = container.read(
          sessionFileBrowserControllerProvider(browserKey),
        );
        expect(state.gate, SessionFileLinkGate.remoteDisabled);
        expect(state.gate.allowsLinks, isFalse);
      });

      test('a 404 on the ROOT means no workspace, not a gone file', () async {
        // The fs routes short-circuit NO_CWD to 404 ahead of the error mapper,
        // so the two codes arrive identically and only the requested path
        // distinguishes them.
        repository.listError = const BrokerException(
          message: 'Request failed',
          statusCode: 404,
          error: BrokerError(error: 'not found', code: 'NOT_FOUND'),
        );

        await container
            .read(sessionFileBrowserControllerProvider(browserKey).notifier)
            .probeGate();

        expect(
          container.read(sessionFileBrowserControllerProvider(browserKey)).gate,
          SessionFileLinkGate.noWorkspace,
        );
      });

      test('a 404 on a NESTED path leaves an open gate open', () async {
        final notifier = container.read(
          sessionFileBrowserControllerProvider(browserKey).notifier,
        );
        await notifier.probeGate();
        repository.listError = const BrokerException(
          message: 'Request failed',
          statusCode: 404,
          error: BrokerError(error: 'not found', code: 'NOT_FOUND'),
        );

        await notifier.load(path: 'lib/gone.dart');

        final state = container.read(
          sessionFileBrowserControllerProvider(browserKey),
        );
        expect(state.notice, SessionFileBrowserNotice.pathNotFound);
        expect(state.gate, SessionFileLinkGate.open);
      });

      test('the probe asks once per attach, never again', () async {
        final notifier = container.read(
          sessionFileBrowserControllerProvider(browserKey).notifier,
        );
        await notifier.probeGate();
        await notifier.probeGate();
        await notifier.probeGate();

        expect(repository.listedPaths, ['']);
      });
    });

    group('openReference', () {
      test('a directory becomes the current listing', () async {
        repository.listingsByPath['lib'] = _directory(
          'lib',
          entries: const [
            FsDirEntry(
              name: 'a.dart',
              path: 'lib/a.dart',
              type: 'file',
              size: 4,
              mtimeMs: 0,
            ),
          ],
        );

        final preview = await container
            .read(sessionFileBrowserControllerProvider(browserKey).notifier)
            .openReference(
              const SessionFileReference(
                rawPath: 'lib',
                kind: SessionFileReferenceKind.directory,
              ),
            );

        final state = container.read(
          sessionFileBrowserControllerProvider(browserKey),
        );
        expect(preview, isNull);
        expect(state.phase, SessionFileBrowserPhase.ready);
        expect(state.currentPath, 'lib');
        expect(state.groupedEntries.single.name, 'a.dart');
      });

      test(
        'an absolute path is sent verbatim for the broker to relativize',
        () async {
          // Since the broker's toWorkspaceRelative pre-step, only the session's
          // host can decide what an absolute path means. A client-side prefix
          // strip would fail on a workspace reached through a symlink.
          repository.listingsByPath['/repo/lib/a.dart'] = _file(
            '/repo/lib/a.dart',
          );
          repository.readResult = const FsReadResult(
            path: 'lib/a.dart',
            size: 5,
            limit: sessionFilePreviewDefaultMaxBytes,
            truncated: false,
            encoding: 'utf8',
            data: 'one\ntwo',
            mimeType: 'text/plain',
          );

          await container
              .read(sessionFileBrowserControllerProvider(browserKey).notifier)
              .openReference(
                const SessionFileReference(rawPath: '/repo/lib/a.dart'),
              );

          expect(repository.listedPaths.first, '/repo/lib/a.dart');
        },
      );

      test(
        'a previewable file returns a preview carrying the line anchor',
        () async {
          repository.listingsByPath['lib/a.dart'] = _file('lib/a.dart');
          repository.readResult = const FsReadResult(
            path: 'lib/a.dart',
            size: 20,
            limit: sessionFilePreviewDefaultMaxBytes,
            truncated: false,
            encoding: 'utf8',
            data: 'one\ntwo\nthree\nfour',
            mimeType: 'text/plain',
          );

          final preview = await container
              .read(sessionFileBrowserControllerProvider(browserKey).notifier)
              .openReference(
                const SessionFileReference(
                  rawPath: 'lib/a.dart',
                  line: 3,
                  column: 2,
                ),
              );

          expect(preview, isNotNull);
          expect(preview!.anchorLine, 3);
          expect(preview.anchorColumn, 2);
          expect(preview.previewedLineCount, 4);
          expect(preview.anchorBeyondPreview, isFalse);
          // The file's own directory is listed so "look, then come back" lands
          // somewhere useful behind the preview.
          expect(repository.listedPaths.last, 'lib');
        },
      );

      test(
        'an anchor past a truncated body says so instead of landing on line 1',
        () async {
          repository.listingsByPath['lib/big.dart'] = _file('lib/big.dart');
          repository.readResult = const FsReadResult(
            path: 'lib/big.dart',
            size: 4000000,
            limit: 8,
            truncated: true,
            encoding: 'utf8',
            data: 'one\ntwo',
            mimeType: 'text/plain',
          );

          final preview = await container
              .read(sessionFileBrowserControllerProvider(browserKey).notifier)
              .openReference(
                const SessionFileReference(rawPath: 'lib/big.dart', line: 4120),
              );

          expect(preview!.truncated, isTrue);
          expect(preview.previewedLineCount, 2);
          expect(preview.anchorBeyondPreview, isTrue);
        },
      );

      test('a non-regular target is refused without a read', () async {
        repository.listingsByPath['lib/sock'] = const FsDirectoryResult(
          path: 'lib/sock',
          stat: FsNodeInfo(
            path: 'lib/sock',
            type: 'other',
            size: 0,
            mtimeMs: 0,
            isDirectory: false,
            isRegularFile: false,
            isSymbolicLink: false,
          ),
          entries: [],
        );

        final preview = await container
            .read(sessionFileBrowserControllerProvider(browserKey).notifier)
            .openReference(const SessionFileReference(rawPath: 'lib/sock'));

        expect(preview, isNull);
        expect(repository.lastReadPath, isNull);
        expect(
          container
              .read(sessionFileBrowserControllerProvider(browserKey))
              .notice,
          SessionFileBrowserNotice.notRegularFile,
        );
      });

      for (final (code, notice) in const [
        ('NOT_FOUND', SessionFileBrowserNotice.pathNotFound),
        ('PATH_ESCAPE', SessionFileBrowserNotice.pathOutsideWorkspace),
        ('PATH_SYMLINK', SessionFileBrowserNotice.symlinkNotReadable),
        ('NO_CWD', SessionFileBrowserNotice.noWorkingDirectory),
      ]) {
        test('$code keeps its existing localized notice, in place', () async {
          // The broker decides; the client re-decides nothing and retries
          // nothing. Every code lands on the copy the Files surface already
          // localizes.
          repository.listError = BrokerException(
            message: 'Request failed',
            statusCode: 400,
            error: BrokerError(error: code, code: code),
          );

          final preview = await container
              .read(sessionFileBrowserControllerProvider(browserKey).notifier)
              .openReference(
                const SessionFileReference(rawPath: 'lib/a.dart'),
              );

          final state = container.read(
            sessionFileBrowserControllerProvider(browserKey),
          );
          expect(preview, isNull);
          expect(state.phase, SessionFileBrowserPhase.error);
          expect(state.errorCode, code);
          expect(state.notice, notice);
        });
      }

      test(
        'FS_REMOTE_DISABLED closes the gate for every later mention',
        () async {
          repository.listError = const BrokerException(
            message: 'Request failed',
            statusCode: 403,
            error: BrokerError(error: 'disabled', code: 'FS_REMOTE_DISABLED'),
          );

          await container
              .read(sessionFileBrowserControllerProvider(browserKey).notifier)
              .openReference(const SessionFileReference(rawPath: 'lib/a.dart'));

          final state = container.read(
            sessionFileBrowserControllerProvider(browserKey),
          );
          expect(state.phase, SessionFileBrowserPhase.remoteDisabled);
          expect(state.gate, SessionFileLinkGate.remoteDisabled);
        },
      );
    });

    /// Both facts this controller holds — the trust-gate verdict and the
    /// listing — belong to a HOST, not to a `(tool, sessionId)` pair. Two
    /// brokers can hand out the same native ids, so an unqualified key showed
    /// the previous machine's closed gate and its files after a profile
    /// switch.
    group('broker identity', () {
      BrokerProfile profile(String id, String host, {String? incarnationId}) =>
          BrokerProfile(
            id: id,
            displayName: id,
            baseUri: Uri.parse(host),
            createdAt: DateTime(2026),
            incarnationId: incarnationId,
          );

      ProviderContainer profileContainer(BrokerProfile? active) {
        final container = ProviderContainer(
          overrides: [
            sessionFileBrowserRepositoryProvider.overrideWith(
              (ref) async => repository,
            ),
            activeBrokerProfileProvider.overrideWith((ref) => active),
          ],
        );
        addTearDown(container.dispose);
        return container;
      }

      test('a different broker host is a different browser', () {
        const otherHost = SessionFileBrowserKey(
          brokerScopeKey:
              'profile-b@http%3A%2F%2Fbroker-b.example%3A7734#gen-1',
          session: sessionKey,
        );

        expect(browserKey == otherHost, isFalse);
        expect(
          browserKey ==
              const SessionFileBrowserKey(
                brokerScopeKey: 'profile-a@http%3A%2F%2F127.0.0.1%3A7734#gen-1',
                session: sessionKey,
              ),
          isTrue,
        );
      });

      test('the derived key follows a re-pointed profile', () {
        // A profile is an editable POINTER: re-pointing it at another machine
        // keeps its id, so the qualifier has to be the endpoint-and-
        // incarnation scope key, not the id.
        final container = profileContainer(
          profile('local', 'http://127.0.0.1:7734', incarnationId: 'gen-1'),
        );

        final before = container.read(
          sessionFileBrowserKeyProvider(sessionKey),
        );
        container.read(activeBrokerProfileProvider.notifier).state = profile(
          'local',
          'http://broker-b.example:7734',
          incarnationId: 'gen-1',
        );
        final after = container.read(sessionFileBrowserKeyProvider(sessionKey));

        expect(before.session, sessionKey);
        expect(after.session, sessionKey);
        expect(after.brokerScopeKey, isNot(before.brokerScopeKey));
        expect(after, isNot(before));
      });

      test(
        'a profile identity change yields a fresh gate and listing',
        () async {
          final container = profileContainer(
            profile('local', 'http://127.0.0.1:7734', incarnationId: 'gen-1'),
          );
          repository.listing = _directory(
            '',
            entries: const [
              FsDirEntry(
                name: 'host-a.txt',
                path: 'host-a.txt',
                type: 'file',
                size: 1,
                mtimeMs: 0,
              ),
            ],
          );

          final firstKey = container.read(
            sessionFileBrowserKeyProvider(sessionKey),
          );
          // Hold the first host's browser open, exactly as a mounted page
          // does, so the switch cannot be explained away by auto-dispose.
          final subscription = container.listen(
            sessionFileBrowserControllerProvider(firstKey),
            (previous, next) {},
            fireImmediately: true,
          );
          addTearDown(subscription.close);
          await container
              .read(sessionFileBrowserControllerProvider(firstKey).notifier)
              .probeGate();
          final onHostA = container.read(
            sessionFileBrowserControllerProvider(firstKey),
          );
          expect(onHostA.gate, SessionFileLinkGate.open);
          expect(onHostA.groupedEntries.map((entry) => entry.name), [
            'host-a.txt',
          ]);

          container.read(activeBrokerProfileProvider.notifier).state = profile(
            'local',
            'http://broker-b.example:7734',
            incarnationId: 'gen-2',
          );
          final secondKey = container.read(
            sessionFileBrowserKeyProvider(sessionKey),
          );
          final onHostB = container.read(
            sessionFileBrowserControllerProvider(secondKey),
          );

          expect(secondKey, isNot(firstKey));
          // Nothing has been asked of the new host yet, so it must have no
          // verdict and no files — not the retired host's.
          expect(onHostB.gate, SessionFileLinkGate.unknown);
          expect(onHostB.phase, SessionFileBrowserPhase.idle);
          expect(onHostB.result, isNull);
          expect(onHostB.groupedEntries, isEmpty);
        },
      );

      test('a closed gate does not survive the switch', () async {
        final container = profileContainer(
          profile('local', 'http://127.0.0.1:7734', incarnationId: 'gen-1'),
        );
        repository.listError = const BrokerException(
          message: 'Request failed',
          statusCode: 403,
          error: BrokerError(error: 'disabled', code: 'FS_REMOTE_DISABLED'),
        );

        final firstKey = container.read(
          sessionFileBrowserKeyProvider(sessionKey),
        );
        final subscription = container.listen(
          sessionFileBrowserControllerProvider(firstKey),
          (previous, next) {},
          fireImmediately: true,
        );
        addTearDown(subscription.close);
        await container
            .read(sessionFileBrowserControllerProvider(firstKey).notifier)
            .probeGate();
        expect(
          container.read(sessionFileBrowserControllerProvider(firstKey)).gate,
          SessionFileLinkGate.remoteDisabled,
        );

        container.read(activeBrokerProfileProvider.notifier).state = profile(
          'other',
          'http://broker-b.example:7734',
          incarnationId: 'gen-2',
        );

        // The stale verdict is what kept every mention plain text on a host
        // that would have served them.
        expect(
          container
              .read(
                sessionFileBrowserControllerProvider(
                  container.read(sessionFileBrowserKeyProvider(sessionKey)),
                ),
              )
              .gate,
          SessionFileLinkGate.unknown,
        );
      });
    });
  });
}

FsDirectoryResult _directory(
  String path, {
  List<FsDirEntry> entries = const [],
}) => FsDirectoryResult(
  path: path,
  stat: FsNodeInfo(
    path: path,
    type: 'directory',
    size: 0,
    mtimeMs: 0,
    isDirectory: true,
    isRegularFile: false,
    isSymbolicLink: false,
  ),
  entries: entries,
);

FsDirectoryResult _file(String path) => FsDirectoryResult(
  path: path,
  stat: FsNodeInfo(
    path: path,
    type: 'file',
    size: 4,
    mtimeMs: 0,
    isDirectory: false,
    isRegularFile: true,
    isSymbolicLink: false,
  ),
  entries: const [],
);

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

  /// Per-path stat/listing answers, which take precedence over [listing].
  final Map<String, FsDirectoryResult> listingsByPath = {};
  BrokerException? listError;
  String? lastListedPath;
  final List<String> listedPaths = [];
  String? lastReadPath;
  int? lastReadMaxBytes;

  @override
  Future<FsDirectoryResult> listPath(
    SessionDetailKey sessionKey, {
    String path = '',
  }) async {
    lastListedPath = path;
    listedPaths.add(path);
    final error = listError;
    if (error != null) {
      throw error;
    }
    return listingsByPath[path] ?? listing;
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
