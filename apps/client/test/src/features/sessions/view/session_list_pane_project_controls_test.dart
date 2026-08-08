import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_list_pane.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// V1/V2-R1 project-control refinements: contained 40x40 compact header
/// targets with no overlap or fall-through, the wide-layout pencil vs the
/// narrow-layout visible overflow, and the reset-disclosing rename dialog
/// whose Save cannot submit an unchanged name.
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

  bool contained(Rect inner, Rect outer) =>
      inner.left >= outer.left - 0.01 &&
      inner.top >= outer.top - 0.01 &&
      inner.right <= outer.right + 0.01 &&
      inner.bottom <= outer.bottom + 0.01;

  bool overlaps(Rect a, Rect b) {
    final intersection = a.intersect(b);
    return intersection.width > 0.01 && intersection.height > 0.01;
  }

  group('project header control geometry (narrow)', () {
    testWidgets(
      'collapsed headers expose contained, non-overlapping 40x40 targets',
      (tester) async {
        await setViewSize(tester, const Size(360, 800));
        await tester.pumpWidget(
          host(twoProjectPane(onNew: (_) {}, onRename: (_) {})),
        );
        await tester.pumpAndSettle();

        final rects = <String, Rect>{};
        for (final cwd in [alphaCwd, betaCwd]) {
          final headerRect = tester.getRect(
            find.byKey(ValueKey('project-header-$cwd')),
          );
          for (final control in ['project-new-$cwd', 'project-overflow-$cwd']) {
            final rect = tester.getRect(find.byKey(ValueKey(control)));
            rects[control] = rect;
            expect(
              rect.width,
              greaterThanOrEqualTo(40),
              reason: '$control must give a 40dp-wide touch target',
            );
            expect(
              rect.height,
              greaterThanOrEqualTo(40),
              reason: '$control must give a 40dp-tall touch target',
            );
            expect(
              contained(rect, headerRect),
              isTrue,
              reason:
                  '$control must stay inside its own project header '
                  '($rect vs $headerRect)',
            );
          }
          // The actions are separated: no shared boundary pixel column.
          final addRect = rects['project-new-$cwd']!;
          final overflowRect = rects['project-overflow-$cwd']!;
          expect(
            overflowRect.left - addRect.right,
            greaterThanOrEqualTo(4),
            reason: 'add and overflow must not abut in $cwd',
          );
        }

        final entries = rects.entries.toList();
        for (var i = 0; i < entries.length; i++) {
          for (var j = i + 1; j < entries.length; j++) {
            expect(
              overlaps(entries[i].value, entries[j].value),
              isFalse,
              reason: '${entries[i].key} overlaps ${entries[j].key}',
            );
          }
        }
      },
    );

    testWidgets('boundary-coordinate taps cannot steal a neighboring action', (
      tester,
    ) async {
      await setViewSize(tester, const Size(360, 800));
      final created = <String>[];
      final renamed = <String>[];
      await tester.pumpWidget(
        host(twoProjectPane(onNew: created.add, onRename: renamed.add)),
      );
      await tester.pumpAndSettle();

      final addAlpha = tester.getRect(
        find.byKey(const ValueKey('project-new-$alphaCwd')),
      );
      final overflowAlpha = tester.getRect(
        find.byKey(const ValueKey('project-overflow-$alphaCwd')),
      );

      Finder rowOf(String id) => find.byKey(Key('session-row-codex/$id'));

      // Dead center and edge-of-target taps invoke add — never the header
      // toggle, never rename, never the neighboring project.
      await tester.tapAt(addAlpha.center);
      await tester.pumpAndSettle();
      await tester.tapAt(addAlpha.bottomCenter - const Offset(0, 0.5));
      await tester.pumpAndSettle();
      expect(created, [alphaCwd, alphaCwd]);
      expect(renamed, isEmpty);
      expect(rowOf('a1'), findsNothing, reason: 'header must stay collapsed');
      expect(rowOf('b1'), findsNothing);

      // The gap between the two targets is dead space, not a hidden third
      // control: nothing fires and neither header toggles.
      final gapPoint = Offset(
        (addAlpha.right + overflowAlpha.left) / 2,
        addAlpha.center.dy,
      );
      await tester.tapAt(gapPoint);
      await tester.pumpAndSettle();
      expect(created, hasLength(2));
      expect(renamed, isEmpty);
      expect(find.byType(PopupMenuItem<VoidCallback>), findsNothing);
      expect(rowOf('a1'), findsNothing);

      // The neighboring project's add fires only for its own header.
      final addBeta = tester.getRect(
        find.byKey(const ValueKey('project-new-$betaCwd')),
      );
      await tester.tapAt(addBeta.topCenter + const Offset(0, 0.5));
      await tester.pumpAndSettle();
      expect(created, [alphaCwd, alphaCwd, betaCwd]);

      // The overflow opens its own menu from an edge coordinate.
      await tester.tapAt(overflowAlpha.bottomCenter - const Offset(0, 0.5));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('project-overflow-rename-$alphaCwd')),
        findsOneWidget,
      );
    });

    testWidgets('compact collapsed header height stays at the accepted value', (
      tester,
    ) async {
      await setViewSize(tester, const Size(360, 800));
      await tester.pumpWidget(
        host(twoProjectPane(onNew: (_) {}, onRename: (_) {})),
      );
      await tester.pumpAndSettle();

      final height = tester
          .getRect(find.byKey(const ValueKey('project-header-$alphaCwd')))
          .height;
      // Measured 56.0 on the accepted checkpoint d167c6b at this exact
      // configuration. Growing this is an explicit product decision, not a
      // touch-target side effect.
      expect(height, 56.0);
    });
  });

  group('project header rename affordance by width', () {
    testWidgets('wide layouts retain the pencil and gain separation', (
      tester,
    ) async {
      await setViewSize(tester, const Size(1000, 800));
      final renamed = <String>[];
      await tester.pumpWidget(
        host(twoProjectPane(onNew: (_) {}, onRename: renamed.add)),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('project-rename-$alphaCwd')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('project-overflow-$alphaCwd')),
        findsNothing,
      );
      final addRect = tester.getRect(
        find.byKey(const ValueKey('project-new-$alphaCwd')),
      );
      final pencilRect = tester.getRect(
        find.byKey(const ValueKey('project-rename-$alphaCwd')),
      );
      expect(pencilRect.left - addRect.right, greaterThanOrEqualTo(4));

      await tester.tap(find.byKey(const ValueKey('project-rename-$alphaCwd')));
      await tester.pumpAndSettle();
      expect(renamed, [alphaCwd]);
    });

    testWidgets('narrow layouts expose one visible overflow with rename', (
      tester,
    ) async {
      await setViewSize(tester, const Size(360, 800));
      final renamed = <String>[];
      await tester.pumpWidget(
        host(twoProjectPane(onNew: (_) {}, onRename: renamed.add)),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('project-rename-$alphaCwd')),
        findsNothing,
        reason: 'narrow keeps a visible overflow instead of the pencil',
      );
      final overflow = find.byKey(const ValueKey('project-overflow-$alphaCwd'));
      expect(overflow, findsOneWidget);

      await tester.tap(overflow);
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('project-overflow-rename-$alphaCwd')),
      );
      await tester.pumpAndSettle();
      expect(renamed, [alphaCwd]);
    });
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
