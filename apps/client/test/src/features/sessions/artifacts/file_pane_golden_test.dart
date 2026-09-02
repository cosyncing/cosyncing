import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// The file surface states worth pinning as pixels.
///
/// `html_source_only` stands in for the design's `html-rendered`, which cannot
/// be captured here: `canRenderHtmlInPane` is false on Linux and Windows
/// because neither has an embeddable browser view, and the golden runner is
/// Linux. What this pins is the honest thing the reader on those platforms
/// actually sees — the source face plus the notice explaining the limit and
/// the labelled hand-off out of it. The rendered face has its own widget
/// coverage on the platforms that have it.
const filePaneGoldenStates = <String>[
  'source',
  'markdown_rendered',
  'html_source_only',
  'diff_rendered',
  'gone',
  'binary',
  'truncated',
  'no_files',
];

const _session = SessionDetailKey(tool: 'codex', sessionId: 'a');

SessionFilePreview _preview({
  required String path,
  required String mimeType,
  required String text,
  bool truncated = false,
}) => SessionFilePreview(
  path: path,
  displayName: path.split('/').last,
  mimeType: mimeType,
  size: text.length,
  limit: 1024 * 1024,
  truncated: truncated,
  text: text,
);

const _dart = '''
/// Resolves the credential this request should present.
Future<Credential?> resolve(Request request) async {
  final bound = await _store.read(request.host);
  if (bound == null) return null;
  return bound.expired ? _refresh(bound) : bound;
}
''';

const _markdown = '''
# Coverage report

The pipeline writes one row per package.

- `broker` — 94%
- `client` — 88%

> Rows below 80% fail the gate.
''';

const _html = '''
<html>
  <head><title>Coverage</title></head>
  <body><h1>Coverage report</h1></body>
</html>
''';

const _diff = '''
--- a/lib/auth.dart
+++ b/lib/auth.dart
@@ -1,4 +1,5 @@
 Future<Credential?> resolve(Request request) async {
-  final bound = _store.read(request.host);
+  final bound = await _store.read(request.host);
+  if (bound == null) return null;
   return bound;
 }
''';

/// The pane content for [state], or null where the surface itself is the
/// subject.
FileViewerContent? _contentFor(String state) => switch (state) {
  'source' => FileViewerSource(
    preview: _preview(
      path: 'lib/auth.dart',
      mimeType: 'text/x-dart',
      text: _dart,
    ),
  ),
  'markdown_rendered' => FileViewerSource(
    preview: _preview(
      path: 'docs/coverage.md',
      mimeType: 'text/markdown',
      text: _markdown,
    ),
  ),
  'html_source_only' => FileViewerSource(
    preview: _preview(
      path: 'docs/coverage.html',
      mimeType: 'text/html',
      text: _html,
    ),
  ),
  'diff_rendered' => FileViewerSource(
    preview: _preview(
      path: 'work/auth.diff',
      mimeType: 'text/x-diff',
      text: _diff,
    ),
  ),
  'gone' => const FileViewerGone(
    path: 'lib/moved.dart',
    displayName: 'moved.dart',
  ),
  'binary' => const FileViewerUnsupported(
    path: 'assets/preview.png',
    displayName: 'preview.png',
    typeLabel: 'image/png',
    size: 184320,
  ),
  'truncated' => FileViewerSource(
    preview: _preview(
      path: 'logs/report.log',
      mimeType: 'text/plain',
      text: _dart * 4,
      truncated: true,
    ),
  ),
  _ => null,
};

/// The two renderers whose golden is their Rendered face.
bool _opensRendered(String state) =>
    state == 'markdown_rendered' || state == 'diff_rendered';

void main() {
  Widget host({
    required Widget child,
    required Locale locale,
    required Brightness brightness,
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    return ProviderScope(
      overrides: [
        // The empty state is the surface's, not the pane's, and the surface
        // reads two working sets. Both real stores open a Drift database
        // inside a widget test, whose timers never let a pump settle.
        filePanesStoreProvider.overrideWithValue(_EmptyFilePanesStore()),
        openSessionsStoreProvider.overrideWithValue(_EmptyOpenSessionsStore()),
        activeBrokerProfileProvider.overrideWith(
          (ref) => BrokerProfile(
            id: 'p1',
            displayName: 'p1',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026),
          ),
        ),
      ],
      child: MaterialApp(
        // The whole app is the capture here, and the debug banner would sit in
        // the corner of all 33 of them.
        debugShowCheckedModeBanner: false,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        locale: locale,
        theme: buildAppTheme(
          brightness == Brightness.dark ? spec.dark : spec.light,
          brightness,
        ),
        home: Scaffold(body: child),
      ),
    );
  }

  testWidgets('File pane goldens cover every state, locale and brightness', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    final spec = themeSpecById(kDefaultThemeId);
    for (final state in filePaneGoldenStates) {
      for (final locale in const [Locale('en'), Locale('zh')]) {
        for (final brightness in Brightness.values) {
          tester.view
            // Wider than the split's 420dp default on purpose: at 720 the
            // header still names the owning session, so these goldens pin the
            // full header rather than its narrow form.
            ..physicalSize = const Size(720, 620)
            ..devicePixelRatio = 1;
          final content = _contentFor(state);
          await tester.pumpWidget(
            host(
              locale: locale,
              brightness: brightness,
              child: content == null
                  ? const FilePaneSurface(session: _session)
                  : FileViewerPane(
                      content: content,
                      sessionLabel: 'codex · refactor auth',
                      toolColor: brightness == Brightness.dark
                          ? spec.dark.toolCodex
                          : spec.light.toolCodex,
                      initialView: _opensRendered(state)
                          ? (mode: FileViewMode.rendered, offset: 0)
                          : null,
                      onClose: () {},
                    ),
            ),
          );
          await tester.pumpAndSettle();

          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(
              'goldens/file_pane_${state}_${brightness.name}_'
              '${locale.languageCode}.png',
            ),
          );
        }
      }
    }
  });

  testWidgets('the in-pane strip overflows without growing', (tester) async {
    addTearDown(tester.view.reset);
    tester.view
      ..physicalSize = const Size(420, 120)
      ..devicePixelRatio = 1;
    const paths = [
      'lib/authentication_credential_store.dart',
      'lib/session_detail_controller.dart',
      'docs/coverage.md',
      'work/auth.diff',
      'logs/report.log',
    ];
    await tester.pumpWidget(
      host(
        locale: const Locale('en'),
        brightness: Brightness.light,
        child: Align(
          alignment: Alignment.topCenter,
          child: FileTabsStrip(
            panes: [
              for (final path in paths)
                FilePaneKey(session: _session, path: path),
            ],
            activeKey: const FilePaneKey(
              session: _session,
              path: 'docs/coverage.md',
            ).key,
            onSelect: (_) {},
            onClose: (_) {},
            onReorder: (_, _) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/file_pane_strip_overflow_light_en.png'),
    );
  });
}

class _EmptyFilePanesStore implements FilePanesStore {
  @override
  Future<FilePanesState> load(String sourceKey) async => FilePanesState.empty;

  @override
  Future<void> save(String sourceKey, FilePanesState state) async {}
}

class _EmptyOpenSessionsStore implements OpenSessionsStore {
  @override
  Future<OpenSessionsSnapshot> load(String profileId) async =>
      OpenSessionsSnapshot.empty;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {}
}
