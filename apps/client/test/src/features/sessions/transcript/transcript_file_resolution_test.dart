import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/transcript_file_resolution.dart';
import 'package:flutter_test/flutter_test.dart';

FsDirectoryResult _file(String path) => FsDirectoryResult(
  path: path,
  stat: FsNodeInfo(
    path: path,
    type: 'file',
    size: 1,
    mtimeMs: 0,
    isDirectory: false,
    isRegularFile: true,
    isSymbolicLink: false,
  ),
  entries: const [],
);

BrokerException _error(String code) => BrokerException(
  message: code,
  error: BrokerError(error: code, code: code),
);

void main() {
  test('report references preserve spaces, host paths and source anchors', () {
    final uri = transcriptFileReference(
      'file:///workspace/my%20notes.md#L12C4',
      explicit: true,
    )!;
    expect(uri.rawPath, '/workspace/my notes.md');
    expect(uri.line, 12);
    expect(uri.column, 4);
    expect(transcriptFileReference(r'C:\work\test.py:3')!.line, 3);
    expect(
      transcriptFileReference('~/transfer/report.md')!.rawPath,
      '~/transfer/report.md',
    );
    expect(
      transcriptFileReference('`Dockerfile`', explicit: true)!.rawPath,
      'Dockerfile',
    );
    expect(transcriptFileReference('.env'), isNotNull);
    expect(transcriptFileReference('function()'), isNull);
    expect(
      transcriptFileReference('https://example.com/a.md', explicit: true),
      isNull,
    );
    expect(
      transcriptFileReference('javascript:alert(1)', explicit: true),
      isNull,
    );
    expect(
      transcriptFileReference('file://another-host/a.md', explicit: true),
      isNull,
    );
    expect(
      transcriptFileReference('first.md\nsecond.md', explicit: true),
      isNull,
    );
  });

  test('Markdown URI targets decode escapes and discard heading fragments', () {
    expect(
      transcriptMarkdownFileReference('docs/my%20notes.md')!.rawPath,
      'docs/my notes.md',
    );
    expect(
      transcriptMarkdownFileReference('docs/guide.md#setup')!.rawPath,
      'docs/guide.md',
    );
    expect(transcriptMarkdownFileReference('/repo/code.py#L12')!.line, 12);
    expect(
      transcriptMarkdownFileReference('docs/100%25.md')!.rawPath,
      'docs/100%.md',
    );
    expect(
      transcriptMarkdownFileReference('https://example.com/file.md'),
      isNull,
    );
    expect(transcriptFileReference('docs/a%20b.md')!.rawPath, 'docs/a%20b.md');
    expect(
      transcriptFileReference('docs/guide.md#setup', explicit: true)!.rawPath,
      'docs/guide.md#setup',
    );
  });

  test('a Markdown basename can carry a source line', () {
    expect(transcriptMarkdownFileReference('notes.md:12')!.line, 12);
  });

  test('an exact file wins without searching', () async {
    final found = await resolveTranscriptFile(
      reference: const SessionFileReference(rawPath: 'report.md'),
      knownReferences: const [],
      stat: (path) async => _file(path),
      search: (_) async => throw StateError('unexpected search'),
    );
    expect(found.matches.single.path, 'report.md');
  });

  test(
    'Pi-style basename resolves from a full path already in the session',
    () async {
      final calls = <String>[];
      final found = await resolveTranscriptFile(
        reference: const SessionFileReference(rawPath: 'PLAN.md'),
        knownReferences: const [
          SessionFileReference(rawPath: '/workspace/transfer/PLAN.md'),
        ],
        stat: (path) async {
          calls.add(path);
          if (path == 'PLAN.md') throw _error('NOT_FOUND');
          return _file('transfer/PLAN.md');
        },
        search: (_) async => throw StateError('unexpected search'),
      );
      expect(found.matches.single.path, 'transfer/PLAN.md');
      expect(calls, ['PLAN.md', '/workspace/transfer/PLAN.md']);
    },
  );

  test(
    'duplicate spellings coalesce, ambiguous known files stay distinct',
    () async {
      final found = await resolveTranscriptFile(
        reference: const SessionFileReference(rawPath: 'notes.md'),
        knownReferences: const [
          SessionFileReference(rawPath: '/root/a/notes.md'),
          SessionFileReference(rawPath: 'a/notes.md'),
          SessionFileReference(rawPath: 'b/notes.md'),
          SessionFileReference(rawPath: 'gone/notes.md'),
        ],
        stat: (path) async {
          if (path == 'notes.md' || path.startsWith('gone/')) {
            throw _error('NOT_FOUND');
          }
          return _file(path.replaceFirst('/root/', ''));
        },
        search: (_) async => throw StateError('unexpected search'),
      );
      expect(found.matches.map((match) => match.path), [
        'a/notes.md',
        'b/notes.md',
      ]);
    },
  );

  test(
    'missing relative paths search by suffix and retain partial status',
    () async {
      final found = await resolveTranscriptFile(
        reference: const SessionFileReference(rawPath: './transfer/jobs.json'),
        knownReferences: const [],
        stat: (_) async => throw _error('NOT_FOUND'),
        search: (query) async {
          expect(query, 'transfer/jobs.json');
          return FsSearchResult(
            query: query,
            matches: [_file('x/transfer/jobs.json').stat],
            truncated: true,
          );
        },
      );
      expect(found.truncated, isTrue);
    },
  );

  test(
    'access errors and absolute missing paths never trigger broader search',
    () async {
      for (final code in [
        'PATH_ESCAPE',
        'FS_REMOTE_DISABLED',
        'PATH_SYMLINK',
      ]) {
        await expectLater(
          resolveTranscriptFile(
            reference: const SessionFileReference(rawPath: 'secret.md'),
            knownReferences: const [],
            stat: (_) async => throw _error(code),
            search: (_) async => throw StateError('unexpected search'),
          ),
          throwsA(isA<BrokerException>()),
        );
      }
      final found = await resolveTranscriptFile(
        reference: const SessionFileReference(rawPath: '/outside/secret.md'),
        knownReferences: const [],
        stat: (_) async => throw _error('NOT_FOUND'),
        search: (_) async => throw StateError('unexpected search'),
      );
      expect(found.matches, isEmpty);
    },
  );
}
