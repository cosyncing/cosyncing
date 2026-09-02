import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers_builtin.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

FileRendererDescriptor _stub(
  String id, {
  RendererSource source = const BuiltInRendererSource(),
  Set<String> extensions = const {},
  Set<String> mimeTypes = const {},
  Set<String> basenames = const {},
}) => FileRendererDescriptor(
  id: id,
  source: source,
  extensions: extensions,
  mimeTypes: mimeTypes,
  basenames: basenames,
  build: (context, request) => const SizedBox.shrink(),
);

void main() {
  group('resolveFileRenderer', () {
    final registry = <FileRendererDescriptor>[
      _stub('gzip', extensions: {'gz'}),
      _stub('tarball', extensions: {'tar.gz'}),
      _stub('csv', extensions: {'csv'}, mimeTypes: {'text/csv'}),
      _stub('shell', basenames: {'dockerfile'}),
      _stub('plain'),
    ];

    FileRendererDescriptor resolve(String path, {String? mime, String? pin}) =>
        resolveFileRenderer(
          registry,
          path: path,
          fallbackId: 'plain',
          mimeType: mime,
          pinnedRendererId: pin,
        );

    test('a user pin wins outright', () {
      expect(resolve('a.csv', pin: 'plain').id, 'plain');
    });

    test('the longest extension wins', () {
      expect(resolve('archive.tar.gz').id, 'tarball');
      expect(resolve('archive.gz').id, 'gzip');
    });

    test('MIME decides only when the broker actually guessed something', () {
      expect(resolve('rows', mime: 'text/csv').id, 'csv');
      // The broker guesses octet-stream for most source, so honouring it would
      // route every unlabelled file to whichever renderer claimed it.
      expect(resolve('rows', mime: 'application/octet-stream').id, 'plain');
      expect(resolve('rows', mime: 'text/csv; charset=utf-8').id, 'csv');
    });

    test('an extensionless file falls to its basename', () {
      expect(resolve('build/Dockerfile').id, 'shell');
    });

    test('the fallback is reached rather than an exception', () {
      expect(resolve('mystery.qqq').id, 'plain');
      expect(resolve('').id, 'plain');
    });

    test('a plugin outranks a built-in on a tie, and is visible doing it', () {
      final contested = <FileRendererDescriptor>[
        _stub('builtin-csv', extensions: {'csv'}),
        _stub(
          'plugin-csv',
          extensions: {'csv'},
          source: const PluginRendererSource(id: 'sheets', version: '1.0.0'),
        ),
        _stub('plain'),
      ];
      final winner = resolveFileRenderer(
        contested,
        path: 'rows.csv',
        fallbackId: 'plain',
      );
      expect(winner.id, 'plugin-csv');
      // Which is exactly why the header names the active renderer: a plugin
      // winning silently is how a renderer becomes a phishing surface.
      expect(winner.source, isA<PluginRendererSource>());
    });
  });

  group('fileLanguageIdFor', () {
    test('maps extensions the highlighter actually knows', () {
      expect(fileLanguageIdFor('lib/a.dart'), 'dart');
      expect(fileLanguageIdFor('scripts/run.sh'), 'bash');
      expect(fileLanguageIdFor('src/main.rs'), 'rust');
      expect(fileLanguageIdFor('a/b/c.pyi'), 'python');
      expect(fileLanguageIdFor('web/index.html'), 'html');
    });

    test('handles extensionless files by basename', () {
      expect(fileLanguageIdFor('Dockerfile'), 'bash');
      expect(fileLanguageIdFor('build/Makefile'), 'bash');
    });

    test('returns null rather than guessing', () {
      expect(fileLanguageIdFor('notes.md'), isNull);
      expect(fileLanguageIdFor('data.bin'), isNull);
      expect(fileLanguageIdFor('LICENSE'), isNull);
    });
  });

  group('builtInFileRenderers', () {
    test('registers the plain fallback the resolver requires', () {
      final registry = builtInFileRenderers();
      expect(
        registry.where((entry) => entry.id == plainFileRendererId),
        hasLength(1),
      );
    });

    test('markdown is offered both faces, code only one', () {
      final registry = builtInFileRenderers();
      final markdown = registry.firstWhere(
        (entry) => entry.id == markdownFileRendererId,
      );
      final code = registry.firstWhere(
        (entry) => entry.id == codeFileRendererId,
      );
      expect(markdown.modes, {FileViewMode.source, FileViewMode.rendered});
      expect(markdown.defaultMode, FileViewMode.source);
      expect(code.modes, {FileViewMode.source});
    });

    test('every source file the browser admits reaches a renderer', () {
      final registry = builtInFileRenderers();
      for (final path in [
        'a.dart',
        'a.py',
        'a.ts',
        'a.rs',
        'a.go',
        'a.sh',
        'a.yaml',
        'a.toml',
        'a.c',
        'a.md',
        'a.txt',
        'a.log',
        'Dockerfile',
        'mystery',
      ]) {
        expect(
          () => resolveFileRenderer(
            registry,
            path: path,
            fallbackId: plainFileRendererId,
          ),
          returnsNormally,
          reason: path,
        );
      }
    });
  });
}
