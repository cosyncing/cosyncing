import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_pane.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Project header actions: no inline pencil or path, a long-press sheet on
/// touch, a hover add and a right-click menu on pointer layouts, and the
/// reset-disclosing rename dialog whose Save cannot submit an unchanged name.
SessionInfo _session(
  String tool,
  String id, {
  String title = 'A session',
  SessionStatus status = SessionStatus.idle,
  String? cwd,
}) => SessionInfo(
  id: id,
  tool: tool,
  title: title,
  status: status,
  cwd: cwd,
  attachMode: AttachMode.observe,
);

class _RecordingRenameController extends SessionListController {
  final List<(String, String)> renames = [];

  @override
  SessionListState build() => const SessionListState();

  @override
  Future<void> load({bool silent = false}) async {}

  @override
  Future<bool> renameProject({
    required String cwd,
    required String name,
  }) async {
    renames.add((cwd, name));
    return true;
  }
}

void main() {
  const alphaCwd = '/work/alpha';
  const betaCwd = '/work/beta';

  Future<void> setViewSize(WidgetTester tester, Size size) async {
    tester.view
      ..physicalSize = size
      ..devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  Widget host(
    Widget child, {
    Locale locale = const Locale('en'),
    List<Override> overrides = const [],
  }) => ProviderScope(
    overrides: overrides,
    child: MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        themeSpecById(kDefaultThemeId).light,
        Brightness.light,
      ),
      home: Scaffold(body: child),
    ),
  );

  Widget twoProjectPane({
    void Function(String cwd)? onNew,
    void Function(String cwd)? onRename,
  }) => SessionListPane(
    sessions: [
      _session('codex', 'a1', cwd: alphaCwd),
      _session('codex', 'b1', cwd: betaCwd),
    ],
    activeKey: null,
    onOpen: (_) {},
    onNewProject: (group) => onNew?.call(group.cwd!),
    onRenameProject: (group) => onRename?.call(group.cwd!),
    visibilityPreferences: const SessionVisibilityPreferences(),
  );

  group('project header actions', () {
    testWidgets('the header carries no pencil, overflow, count or path line', (
      tester,
    ) async {
      await setViewSize(tester, const Size(360, 800));
      await tester.pumpWidget(
        host(twoProjectPane(onNew: (_) {}, onRename: (_) {})),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('project-rename-$alphaCwd')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('project-overflow-$alphaCwd')),
        findsNothing,
      );
      // Touch has no hover, so the add action lives in the long-press sheet.
      expect(find.byKey(const ValueKey('project-new-$alphaCwd')), findsNothing);
      expect(find.text(alphaCwd), findsNothing);
    });

    testWidgets('a touch long-press opens a sheet with add and rename', (
      tester,
    ) async {
      await setViewSize(tester, const Size(360, 800));
      final created = <String>[];
      final renamed = <String>[];
      await tester.pumpWidget(
        host(twoProjectPane(onNew: created.add, onRename: renamed.add)),
      );
      await tester.pumpAndSettle();

      final header = find.byKey(const ValueKey('project-header-$alphaCwd'));
      expect(tester.getSize(header).height, 40);
      await tester.longPress(header);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('project-sheet-$alphaCwd')),
        findsOneWidget,
      );
      // The path the header no longer prints is one long-press away.
      expect(
        find.byKey(const ValueKey('project-path-$alphaCwd')),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const ValueKey('project-menu-new-$alphaCwd')),
      );
      await tester.pumpAndSettle();
      expect(created, [alphaCwd]);
      expect(
        find.byKey(const Key('session-row-codex/a1')),
        findsNothing,
        reason: 'a long-press must not also toggle the project open',
      );

      await tester.longPress(header);
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('project-menu-rename-$alphaCwd')),
      );
      await tester.pumpAndSettle();
      expect(renamed, [alphaCwd]);
    });

    testWidgets(
      'a pointer hover reveals add and a right-click opens the menu',
      (
        tester,
      ) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.windows;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        await setViewSize(tester, const Size(1000, 800));
        final created = <String>[];
        final renamed = <String>[];
        await tester.pumpWidget(
          host(twoProjectPane(onNew: created.add, onRename: renamed.add)),
        );
        await tester.pumpAndSettle();

        final header = find.byKey(const ValueKey('project-header-$alphaCwd'));
        expect(tester.getSize(header).height, 36);
        expect(
          find.byKey(const ValueKey('project-new-$alphaCwd')),
          findsNothing,
        );
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);
        await mouse.moveTo(tester.getCenter(header));
        await tester.pump();
        final add = find.byKey(const ValueKey('project-new-$alphaCwd'));
        expect(add, findsOneWidget);
        // Only the hovered project offers it.
        expect(
          find.byKey(const ValueKey('project-new-$betaCwd')),
          findsNothing,
        );
        await tester.tap(add);
        await tester.pumpAndSettle();
        expect(created, [alphaCwd]);
        expect(
          find.byKey(const Key('session-row-codex/a1')),
          findsNothing,
          reason: 'the add action must not fall through to the header toggle',
        );

        await tester.tap(
          header,
          buttons: kSecondaryMouseButton,
          kind: PointerDeviceKind.mouse,
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('project-path-$alphaCwd')),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const ValueKey('project-menu-rename-$alphaCwd')),
        );
        await tester.pumpAndSettle();
        expect(renamed, [alphaCwd]);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );

    testWidgets(
      'a pointer layout shows the path as the header tooltip',
      (
        tester,
      ) async {
        await setViewSize(tester, const Size(1000, 800));
        await tester.pumpWidget(
          host(twoProjectPane(onNew: (_) {}, onRename: (_) {})),
        );
        await tester.pumpAndSettle();

        expect(find.byTooltip(alphaCwd), findsOneWidget);
        expect(find.text(alphaCwd), findsNothing);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  });

  group('project rename dialog', () {
    const project = SessionProjectGroup(
      key: '/work/rename',
      cwd: '/work/rename',
      label: 'Alias',
      rows: [],
      rootCount: 0,
      summaryStatus: SessionStatus.idle,
      needsInputCount: 0,
      workingCount: 0,
      idleCount: 0,
      readyCount: 0,
    );

    Widget renameHost(
      _RecordingRenameController controller, {
      Locale locale = const Locale('en'),
    }) => host(
      Consumer(
        builder: (context, ref, child) => TextButton(
          key: const Key('open-project-rename'),
          onPressed: () => unawaited(
            renameProjectAliasFromList(context, ref, project),
          ),
          child: const Text('Open rename'),
        ),
      ),
      locale: locale,
      overrides: [
        sessionListControllerProvider.overrideWith(() => controller),
      ],
    );

    FilledButton saveButton(WidgetTester tester) => tester.widget<FilledButton>(
      find.byKey(const Key('project-rename-confirm')),
    );

    testWidgets('Save is disabled only while the trimmed value is unchanged', (
      tester,
    ) async {
      final controller = _RecordingRenameController();
      await tester.pumpWidget(renameHost(controller));
      await tester.tap(find.byKey(const Key('open-project-rename')));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'Changes the app label only. Leave empty to reset to the '
          'directory name.',
        ),
        findsOneWidget,
      );
      expect(saveButton(tester).onPressed, isNull);

      // Whitespace-only difference is still "unchanged".
      await tester.enterText(
        find.byKey(const Key('project-rename-input')),
        '  Alias ',
      );
      await tester.pump();
      expect(saveButton(tester).onPressed, isNull);

      // Submitting from the keyboard cannot bypass the gate either.
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(controller.renames, isEmpty);

      await tester.enterText(
        find.byKey(const Key('project-rename-input')),
        'New alias',
      );
      await tester.pump();
      expect(saveButton(tester).onPressed, isNotNull);
      await tester.tap(find.byKey(const Key('project-rename-confirm')));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsNothing);
      expect(controller.renames, [('/work/rename', 'New alias')]);
      expect(find.text('Project renamed'), findsOneWidget);
    });

    testWidgets('empty input stays submittable and reads back as a reset', (
      tester,
    ) async {
      final controller = _RecordingRenameController();
      await tester.pumpWidget(renameHost(controller));
      await tester.tap(find.byKey(const Key('open-project-rename')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('project-rename-input')),
        '',
      );
      await tester.pump();
      expect(saveButton(tester).onPressed, isNotNull);

      await tester.tap(find.byKey(const Key('project-rename-confirm')));
      await tester.pumpAndSettle();

      expect(controller.renames, [('/work/rename', '')]);
      expect(find.text('Project name reset'), findsOneWidget);
    });

    testWidgets('the reset disclosure and gate render in Chinese', (
      tester,
    ) async {
      final controller = _RecordingRenameController();
      await tester.pumpWidget(
        renameHost(controller, locale: const Locale('zh')),
      );
      await tester.tap(find.byKey(const Key('open-project-rename')));
      await tester.pumpAndSettle();

      expect(find.text('仅更改应用内显示名称。留空可重置为目录名称。'), findsOneWidget);
      expect(saveButton(tester).onPressed, isNull);

      await tester.enterText(
        find.byKey(const Key('project-rename-input')),
        '',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('project-rename-confirm')));
      await tester.pumpAndSettle();
      expect(controller.renames, [('/work/rename', '')]);
      expect(find.text('项目名称已重置'), findsOneWidget);
    });
  });
}
