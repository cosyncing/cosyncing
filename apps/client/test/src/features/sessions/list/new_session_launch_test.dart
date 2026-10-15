import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('releases Drive handoff only after destination frame', (
    tester,
  ) async {
    var released = false;
    bool? releasedDuringComplete;
    final order = <String>[];

    await tester.pumpWidget(
      _host(
        onCreate: (_) async => _session(),
        onOpen: (_) async {},
        onConnect: (_) async => NewSessionConnectionHandoff(() {
          released = true;
          order.add('release');
        }),
        onComplete: (_) {
          releasedDuringComplete = released;
          order.add('complete');
        },
      ),
    );

    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(releasedDuringComplete, isFalse);
    expect(released, isTrue);
    expect(
      order,
      ['complete', 'release'],
      reason: 'navigation must start before the launch lease is released',
    );
  });

  testWidgets(
    'retry resumes the failed boundary without creating a duplicate',
    (tester) async {
      var createCalls = 0;
      var openCalls = 0;
      SessionInfo? completed;

      await tester.pumpWidget(
        _host(
          onCreate: (_) async {
            createCalls += 1;
            return _session();
          },
          onOpen: (_) async {
            openCalls += 1;
            if (openCalls == 1) throw StateError('raw opening failure');
          },
          onConnect: (_) async => NewSessionConnectionHandoff(() {}),
          onComplete: (session) => completed = session,
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('new-session-launch-failed')),
        findsOneWidget,
      );
      expect(createCalls, 1);
      expect(openCalls, 1);
      expect(
        tester
            .widget<Text>(find.byKey(const Key('new-session-launch-error')))
            .data,
        isNot(contains('raw opening failure')),
      );
      expect(
        find.ancestor(
          of: find.byKey(const Key('new-session-launch-error')),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );

      final retry = find.byKey(const Key('new-session-launch-retry'));
      await tester.tap(retry);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));

      expect(createCalls, 1);
      expect(openCalls, 2);
      expect(completed?.id, 'created');
    },
  );
}

Widget _host({
  required Future<SessionInfo> Function(NewSessionLaunchRequest request)
  onCreate,
  required Future<void> Function(SessionInfo session) onOpen,
  required Future<NewSessionConnectionHandoff> Function(SessionInfo session)
  onConnect,
  ValueChanged<SessionInfo>? onComplete,
  VoidCallback? onBack,
  Brightness brightness = Brightness.light,
}) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  theme: buildAppTheme(
    brightness == Brightness.light
        ? themeSpecById(kDefaultThemeId).light
        : themeSpecById(kDefaultThemeId).dark,
    brightness,
  ),
  darkTheme: buildAppTheme(
    themeSpecById(kDefaultThemeId).dark,
    Brightness.dark,
  ),
  themeMode: brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light,
  home: NewSessionLaunchPage(
    request: const NewSessionLaunchRequest(
      tool: 'codex',
      directory: '/project',
      title: 'Work',
    ),
    onCreate: onCreate,
    onOpen: onOpen,
    onConnect: onConnect,
    onComplete: onComplete ?? (_) {},
    onBack: onBack ?? () {},
  ),
);

SessionInfo _session() => const SessionInfo(
  id: 'created',
  tool: 'codex',
  title: 'Work',
  status: SessionStatus.idle,
  attachMode: AttachMode.resume,
);
