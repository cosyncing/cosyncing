import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

enum _GoldenBoxKind { error, permission, question, artifact }

void main() {
  group('transcript box goldens', () {
    for (final kind in _GoldenBoxKind.values) {
      for (final brightness in Brightness.values) {
        for (final width in const [360.0, 720.0]) {
          for (final locale in const [Locale('en'), Locale('zh')]) {
            final sizeName = width == 360 ? 'compact' : 'roomy';
            final name =
                '${kind.name}_${brightness.name}_${sizeName}_'
                '${locale.languageCode}';
            testWidgets(name, (tester) async {
              tester.view
                ..physicalSize = Size(width, 300)
                ..devicePixelRatio = 1;
              addTearDown(tester.view.resetPhysicalSize);
              addTearDown(tester.view.resetDevicePixelRatio);

              final tokens = brightness == Brightness.dark
                  ? themeSpecById(kDefaultThemeId).dark
                  : themeSpecById(kDefaultThemeId).light;
              await tester.pumpWidget(
                MaterialApp(
                  locale: locale,
                  localizationsDelegates:
                      AppLocalizations.localizationsDelegates,
                  supportedLocales: AppLocalizations.supportedLocales,
                  theme: buildAppTheme(tokens, brightness),
                  home: Scaffold(
                    body: Column(
                      children: [
                        RepaintBoundary(
                          key: const Key('transcript-box-golden'),
                          child: SelectionArea(
                            child: Builder(
                              builder: (context) => _buildBox(context, kind),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
              await tester.pumpAndSettle();

              await expectLater(
                find.byKey(const Key('transcript-box-golden')),
                matchesGoldenFile('goldens/transcript_box_$name.png'),
              );
            });
          }
        }
      }
    }

    testWidgets(
      'all themes lay out at both widths, locales, and text scales',
      (tester) async {
        for (final spec in kAppThemes) {
          for (final brightness in Brightness.values) {
            for (final width in const [360.0, 960.0]) {
              for (final locale in const [Locale('en'), Locale('zh')]) {
                for (final scale in const [1.0, 2.0]) {
                  tester.view
                    ..physicalSize = Size(width, 1200)
                    ..devicePixelRatio = 1;
                  final tokens = brightness == Brightness.dark
                      ? spec.dark
                      : spec.light;
                  await tester.pumpWidget(
                    MaterialApp(
                      locale: locale,
                      localizationsDelegates:
                          AppLocalizations.localizationsDelegates,
                      supportedLocales: AppLocalizations.supportedLocales,
                      theme: buildAppTheme(tokens, brightness),
                      builder: (context, child) => MediaQuery(
                        data: MediaQuery.of(context).copyWith(
                          textScaler: TextScaler.linear(scale),
                        ),
                        child: child!,
                      ),
                      home: Scaffold(
                        body: SingleChildScrollView(
                          child: SelectionArea(
                            child: Builder(
                              builder: (context) => Column(
                                children: [
                                  for (final kind in _GoldenBoxKind.values)
                                    _buildBox(context, kind),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                  await tester.pumpAndSettle();
                  expect(
                    tester.takeException(),
                    isNull,
                    reason:
                        '${spec.id} ${brightness.name} width=$width '
                        '${locale.languageCode} scale=$scale',
                  );
                }
              }
            }
          }
        }
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      },
    );
  });
}

Widget _buildBox(BuildContext context, _GoldenBoxKind kind) {
  final l10n = AppLocalizations.of(context);
  return switch (kind) {
    _GoldenBoxKind.error => buildAgentMessageRenderer(
      context,
      const AgentMessage(
        type: AgentMessageType.error,
        raw: {
          'type': 'error',
          'code': 'E_WRITE',
          'message': 'Could not save report.md',
        },
      ),
    ),
    _GoldenBoxKind.permission => buildAgentMessageRenderer(
      context,
      const AgentMessage(
        type: AgentMessageType.permissionRequest,
        raw: {
          'type': 'permission-request',
          'requestId': 'permission-golden',
          'permission': 'disk.write',
          'target': 'report.md',
        },
      ),
      requestAction: Wrap(
        spacing: 8,
        children: [
          OutlinedButton(
            onPressed: () {},
            child: Text(l10n.sessionRequestReject),
          ),
          FilledButton(
            onPressed: () {},
            child: Text(l10n.sessionRequestApproveOnce),
          ),
        ],
      ),
    ),
    _GoldenBoxKind.question => buildAgentMessageRenderer(
      context,
      const AgentMessage(
        type: AgentMessageType.questionRequest,
        raw: {
          'type': 'question-request',
          'requestId': 'question-golden',
          'questions': [
            {'question': 'Which server should run this?'},
          ],
        },
      ),
      requestAction: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const TextField(decoration: InputDecoration(isDense: true)),
          const SizedBox(height: 4),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: FilledButton(
              onPressed: () {},
              child: Text(l10n.sessionRequestSubmit),
            ),
          ),
        ],
      ),
    ),
    _GoldenBoxKind.artifact => buildAgentMessageRenderer(
      context,
      const AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'report.md',
          'size': 1240,
          'artifactKey': 'report',
        },
      ),
      fileArtifactAction: TextButton.icon(
        onPressed: () {},
        icon: const Icon(Icons.download_outlined, size: 14),
        label: Text(l10n.download),
      ),
    ),
  };
}
