import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_list_pane.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

SessionInfo _session(
  String tool,
  String id, {
  String title = 'A session',
  SessionStatus status = SessionStatus.idle,
  String? cwd,
  String? machine,
  String? projectName,
  SessionCurrentModel? currentModel,
  int? updatedAt,
}) => SessionInfo(
  id: id,
  tool: tool,
  title: title,
  status: status,
  cwd: cwd,
  machine: machine,
  projectName: projectName,
  currentModel: currentModel,
  updatedAt: updatedAt,
  attachMode: AttachMode.observe,
);

void main() {
  Widget host(
    Widget child, {
    Brightness brightness = Brightness.light,
    Locale locale = const Locale('en'),
  }) => ProviderScope(
    child: MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        brightness == Brightness.dark
            ? themeSpecById(kDefaultThemeId).dark
            : themeSpecById(kDefaultThemeId).light,
        brightness,
      ),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: Scaffold(body: child),
    ),
  );

  /// Projects are collapsed by default (R1b), so any test that asserts on
  /// session rows has to open its group first.
  Future<void> expandProject(WidgetTester tester, String key) async {
    await tester.tap(find.byKey(ValueKey('project-header-$key')));
    await tester.pump();
  }

  /// Group key used by sessions built without a `cwd`.
  const ungrouped = '__ungrouped__';

  group('SessionListPane', () {
    const projectKey = '/work/alpha';

    Widget projectRoster(
      List<SessionStatus> statuses, {
      VoidCallback? onNew,
      String cwd = projectKey,
      String? projectName,
      double? width,
    }) {
      final pane = SessionListPane(
        sessions: [
          for (var index = 0; index < statuses.length; index++)
            _session(
              'codex',
              'project-$index',
              title: 'Project session $index',
              status: statuses[index],
              cwd: cwd,
              projectName: projectName,
            ),
        ],
        activeKey: null,
        onOpen: (_) {},
        onNewProject: onNew == null ? null : (_) => onNew(),
        visibilityPreferences: const SessionVisibilityPreferences(),
      );
      return width == null ? pane : SizedBox(width: width, child: pane);
    }

    testWidgets('shows the empty state when there are no sessions', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: const [],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
            emptyState: const Text('No sessions'),
          ),
        ),
      );

      expect(find.text('No sessions'), findsOneWidget);
    });

    testWidgets('renders a row per session and reports open', (tester) async {
      final opened = <String>[];
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session('claude', 'a', title: 'First'),
              _session('codex', 'b', title: 'Second'),
            ],
            activeKey: 'claude/a',
            onOpen: (session) => opened.add('${session.tool}/${session.id}'),
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      await expandProject(tester, ungrouped);

      expect(find.text('First'), findsOneWidget);
      expect(find.text('Second'), findsOneWidget);
      expect(find.byKey(const Key('session-row-claude/a')), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text('Second'),
          matching: find.byType(SelectionArea),
        ),
        findsNothing,
        reason: 'roster rows are navigation and carry no selection region',
      );

      await tester.drag(find.text('Second'), const Offset(80, 0));
      await tester.pump();
      expect(opened, isEmpty, reason: 'drag selection must not open the row');

      await tester.tap(find.byKey(const Key('session-row-codex/b')));
      expect(
        opened,
        ['codex/b'],
        reason:
            'the row opens once; the tap region must not re-supply the tap '
            'the row InkWell already receives',
      );
    });

    testWidgets('the roster carries no selection machinery at all', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session('claude', 'a', title: 'First'),
              _session('codex', 'b', title: 'Second'),
              _session('codex', 'c', title: 'Third'),
            ],
            activeKey: 'claude/a',
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await expandProject(tester, ungrouped);

      // The reported grey slab is Flutter's release RenderErrorBox, and it is
      // consistent with a known web failure: every SelectionArea adds a
      // platform view whose placeholder reads `localToGlobal` from a
      // post-frame callback with no `attached` guard, and a scrolling viewport
      // that collects it first makes that throw (flutter/flutter#122680, fixed
      // by #186840, absent from the 3.44.3 we pin). No exception was ever
      // captured and there is no deterministic repro, so that cause is
      // unproven — but one region per row showed one slab per row and one
      // shared region showed one slab over the list; removing SelectionArea
      // from the roster removes the mechanism outright. It is navigation, not
      // a document: no selection region, no per-row island.
      expect(find.byType(SelectionArea), findsNothing);
      expect(find.byType(SelectableTapRegion), findsNothing);
      for (final title in ['First', 'Second', 'Third']) {
        expect(
          find.ancestor(
            of: find.text(title),
            matching: find.byType(SelectableRegion),
          ),
          findsNothing,
          reason: '$title must not sit inside any selectable region',
        );
      }
    });

    testWidgets('shows status labels without overflowing', (tester) async {
      await tester.pumpWidget(
        host(
          SizedBox(
            width: 280,
            child: SessionListPane(
              sessions: [
                _session(
                  'claude',
                  'a',
                  title:
                      'A very long session title that must ellipsize '
                      'instead of pushing the row wider than the pane',
                  status: SessionStatus.needsInput,
                ),
              ],
              activeKey: null,
              onOpen: (_) {},
              visibilityPreferences: const SessionVisibilityPreferences(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expandProject(tester, ungrouped);

      expect(find.text('Needs input'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('starts every project collapsed and expands from the header', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session('claude', 'a', title: 'First', cwd: '/work/alpha'),
              _session('codex', 'b', title: 'Second', cwd: '/work/alpha'),
              _session('claude', 'c', title: 'Elsewhere', cwd: '/work/beta'),
            ],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // R1b: a cold load shows headers only. Before R1b the empty
      // collapsed-key set left every group open on the first frame.
      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);
      expect(find.byKey(const Key('session-row-codex/b')), findsNothing);
      expect(find.byKey(const Key('session-row-claude/c')), findsNothing);
      expect(
        find.byKey(const ValueKey('project-header-/work/alpha')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('project-header-/work/beta')),
        findsOneWidget,
      );
      // Project total plus the idle-status summary count survive collapse.
      expect(find.text('2'), findsNWidgets(2));

      await expandProject(tester, '/work/alpha');

      // Only the tapped group opens; its sibling stays closed.
      expect(find.byKey(const Key('session-row-claude/a')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/b')), findsOneWidget);
      expect(find.byKey(const Key('session-row-claude/c')), findsNothing);

      await expandProject(tester, '/work/alpha');

      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);
      expect(find.byKey(const Key('session-row-codex/b')), findsNothing);
      expect(
        find.byKey(const ValueKey('project-header-/work/alpha')),
        findsOneWidget,
      );
    });

    testWidgets('toggles OpenCode sub-agent children under their parent', (
      tester,
    ) async {
      SessionInfo parent(String id, String title) => SessionInfo(
        id: id,
        tool: 'opencode',
        title: title,
        status: SessionStatus.idle,
        cwd: '/work/alpha',
        attachMode: AttachMode.observe,
        nativeId: id,
      );
      SessionInfo child(String id, String title, String parentId) =>
          SessionInfo(
            id: id,
            tool: 'opencode',
            title: title,
            status: SessionStatus.idle,
            cwd: '/work/alpha',
            attachMode: AttachMode.observe,
            origin: SessionOrigin.subagent,
            nativeId: id,
            parentThreadId: parentId,
          );

      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              parent('ses_parent', 'Build the thing'),
              child('ses_child1', 'Explore repo', 'ses_parent'),
              child('ses_child2', 'Research API', 'ses_parent'),
            ],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expandProject(tester, '/work/alpha');

      // Children are grouped off the top level; only the parent shows, with a
      // toggle chip carrying the child count.
      expect(
        find.byKey(const Key('session-row-opencode/ses_parent')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-row-opencode/ses_child1')),
        findsNothing,
      );
      final toggle = find.byKey(
        const ValueKey('session-children-opencode/ses_parent'),
      );
      expect(toggle, findsOneWidget);

      // Toggling the chip reveals both children as rows under the parent.
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-row-opencode/ses_child1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-row-opencode/ses_child2')),
        findsOneWidget,
      );

      // Toggling again collapses them back.
      await tester.tap(
        find.byKey(const ValueKey('session-children-opencode/ses_parent')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-row-opencode/ses_child1')),
        findsNothing,
      );
    });

    testWidgets('keeps the add button working while a group is collapsed', (
      tester,
    ) async {
      final created = <String>[];
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session('claude', 'a', title: 'First', cwd: '/work/alpha'),
            ],
            activeKey: null,
            onOpen: (_) {},
            onNewProject: (group) => created.add(group.key),
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The group is already collapsed by default.
      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);

      // Tapping the add button must not also toggle the header underneath it.
      await tester.tap(find.byKey(const ValueKey('project-new-/work/alpha')));
      await tester.pumpAndSettle();

      expect(created, ['/work/alpha']);
      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);
    });

    testWidgets('shows agent and compact model but never the machine name', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session(
                'codex',
                'model',
                machine: 'howard-laptop',
                currentModel: const SessionCurrentModel(
                  providerID: 'openai',
                  modelID: 'gpt-5.4-codex',
                  variant: 'fast',
                  reasoningEffort: 'high',
                ),
              ),
            ],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // Machine-qualified group key: identity stays machine-safe even though
      // the machine never renders.
      await expandProject(tester, 'howard-laptop\u0000$ungrouped');

      expect(find.text('Codex · GPT-5.4'), findsOneWidget);
      expect(find.textContaining('howard-laptop'), findsNothing);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is Tooltip &&
              widget.message ==
                  'Model: openai/gpt-5.4-codex · Variant: fast · Effort: high',
        ),
        findsOneWidget,
      );
    });

    testWidgets('search filters the live roster without another fetch', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session('codex', 'a', title: 'Alpha task'),
              _session('claude', 'b', title: 'Beta task'),
            ],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'beta',
      );
      await tester.pump();

      expect(find.text('Alpha task'), findsNothing);
      expect(find.text('Beta task'), findsOneWidget);
    });

    testWidgets(
      'ready dot appears only after working to idle and clears open',
      (
        tester,
      ) async {
        final opened = <String>[];
        final working = _session(
          'codex',
          'ready',
          status: SessionStatus.working,
        );
        final idle = _session('codex', 'ready');
        final readyKey = ValueKey(
          'session-ready-${sessionCompositeRosterKey(idle)}',
        );

        Widget pane(SessionInfo session) => host(
          SessionListPane(
            sessions: [session],
            activeKey: null,
            onOpen: (value) => opened.add(value.id),
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        );

        await tester.pumpWidget(pane(working));
        await tester.pump();
        await expandProject(tester, ungrouped);
        expect(find.byKey(readyKey), findsNothing);

        await tester.pumpWidget(pane(idle));
        await tester.pump();
        expect(find.byKey(readyKey), findsOneWidget);

        await tester.tap(find.byKey(const Key('session-row-codex/ready')));
        await tester.pump();
        expect(opened, ['ready']);
        expect(find.byKey(readyKey), findsNothing);
      },
    );

    testWidgets(
      'shows only non-zero project counters in order in English and Chinese',
      (tester) async {
        final semantics = tester.ensureSemantics();
        final cases =
            <
              ({
                String name,
                List<SessionStatus> statuses,
                List<String> ids,
                String en,
                String zh,
              })
            >[
              (
                name: 'idle only',
                statuses: [SessionStatus.idle, SessionStatus.idle],
                ids: ['idle'],
                en: 'Idle: 2',
                zh: '空闲：2',
              ),
              (
                name: 'working only',
                statuses: [SessionStatus.working],
                ids: ['working'],
                en: 'Working: 1',
                zh: '工作中：1',
              ),
              (
                name: 'needs input only',
                statuses: [SessionStatus.needsInput],
                ids: ['needs-input'],
                en: 'Needs input: 1',
                zh: '需要输入：1',
              ),
              (
                name: 'needs input and working',
                statuses: [
                  SessionStatus.needsInput,
                  SessionStatus.working,
                ],
                ids: ['needs-input', 'working'],
                en: 'Needs input: 1 · Working: 1',
                zh: '需要输入：1 · 工作中：1',
              ),
              (
                name: 'needs input and idle',
                statuses: [SessionStatus.needsInput, SessionStatus.idle],
                ids: ['needs-input', 'idle'],
                en: 'Needs input: 1 · Idle: 1',
                zh: '需要输入：1 · 空闲：1',
              ),
              (
                name: 'working and idle',
                statuses: [SessionStatus.working, SessionStatus.idle],
                ids: ['working', 'idle'],
                en: 'Working: 1 · Idle: 1',
                zh: '工作中：1 · 空闲：1',
              ),
              (
                name: 'all statuses',
                statuses: [
                  SessionStatus.needsInput,
                  SessionStatus.working,
                  SessionStatus.idle,
                ],
                ids: ['needs-input', 'working', 'idle'],
                en: 'Needs input: 1 · Working: 1 · Idle: 1',
                zh: '需要输入：1 · 工作中：1 · 空闲：1',
              ),
            ];

        for (final localeCase in [
          (locale: const Locale('en'), language: 'en'),
          (locale: const Locale('zh'), language: 'zh'),
        ]) {
          for (final counterCase in cases) {
            await tester.pumpWidget(
              host(
                projectRoster(counterCase.statuses),
                locale: localeCase.locale,
              ),
            );
            await tester.pumpAndSettle();

            final expectedSummary = localeCase.language == 'en'
                ? counterCase.en
                : counterCase.zh;
            final region = find.byKey(
              const ValueKey('project-counts-/work/alpha'),
            );
            final tooltip = tester.widget<Tooltip>(
              find.byKey(
                const ValueKey('project-counts-tooltip-/work/alpha'),
              ),
            );
            expect(
              tooltip.message,
              expectedSummary,
              reason: '${localeCase.language}: ${counterCase.name}',
            );
            expect(
              tester.getSemantics(region).label,
              expectedSummary,
              reason: '${localeCase.language}: ${counterCase.name}',
            );
            expect(
              find.descendant(of: region, matching: find.text('0')),
              findsNothing,
              reason: '${localeCase.language}: ${counterCase.name}',
            );

            for (final id in ['needs-input', 'working', 'idle']) {
              expect(
                find.byKey(ValueKey('project-count-$projectKey-$id')),
                counterCase.ids.contains(id) ? findsOneWidget : findsNothing,
                reason: '${localeCase.language}: ${counterCase.name}: $id',
              );
            }

            expect(
              find.byKey(const ValueKey('project-total-/work/alpha')),
              findsOneWidget,
            );
            expect(
              find.byKey(const ValueKey('project-summary-/work/alpha')),
              findsOneWidget,
            );

            final summaryDot = find.byKey(
              const ValueKey('project-summary-/work/alpha'),
            );
            var previous = summaryDot;
            for (var index = 0; index < counterCase.ids.length; index++) {
              final counter = find.byKey(
                ValueKey(
                  'project-count-$projectKey-${counterCase.ids[index]}',
                ),
              );
              final gap =
                  tester.getTopLeft(counter).dx -
                  tester.getTopRight(previous).dx;
              expect(
                gap,
                index == 0 ? 8 : 4,
                reason:
                    '${localeCase.language}: ${counterCase.name}: '
                    'gap before ${counterCase.ids[index]}',
              );
              previous = counter;
            }
          }
        }
        semantics.dispose();
      },
    );

    testWidgets('removes counters again across live zero transitions', (
      tester,
    ) async {
      Future<void> pumpStatuses(List<SessionStatus> statuses) async {
        await tester.pumpWidget(host(projectRoster(statuses)));
        await tester.pumpAndSettle();
      }

      Finder counter(String id) =>
          find.byKey(ValueKey('project-count-$projectKey-$id'));

      await pumpStatuses([SessionStatus.idle]);
      expect(counter('needs-input'), findsNothing);
      await pumpStatuses([SessionStatus.needsInput, SessionStatus.idle]);
      expect(counter('needs-input'), findsOneWidget);
      await pumpStatuses([SessionStatus.idle]);
      expect(counter('needs-input'), findsNothing);

      expect(counter('working'), findsNothing);
      await pumpStatuses([SessionStatus.working, SessionStatus.idle]);
      expect(counter('working'), findsOneWidget);
      await pumpStatuses([SessionStatus.idle]);
      expect(counter('working'), findsNothing);

      await pumpStatuses([SessionStatus.working]);
      expect(counter('idle'), findsNothing);
      await pumpStatuses([SessionStatus.working, SessionStatus.idle]);
      expect(counter('idle'), findsOneWidget);
      await pumpStatuses([SessionStatus.working]);
      expect(counter('idle'), findsNothing);
    });

    testWidgets(
      'compact project headers ellipsize non-selectable cwd metadata and '
      'keep New usable',
      (tester) async {
        const longProjectName =
            'A project name long enough to require compact ellipsis';
        const longCwd =
            '/work/a-very-long-directory-name/with/nested/source/project';

        for (final brightness in [Brightness.light, Brightness.dark]) {
          var created = 0;
          await tester.pumpWidget(
            host(
              projectRoster(
                [
                  SessionStatus.needsInput,
                  SessionStatus.working,
                  SessionStatus.idle,
                ],
                cwd: longCwd,
                projectName: longProjectName,
                width: 320,
                onNew: () => created += 1,
              ),
              brightness: brightness,
            ),
          );
          await tester.pumpAndSettle();

          final title = tester.widget<Text>(find.text(longProjectName));
          expect(title.maxLines, 1);
          expect(title.overflow, TextOverflow.ellipsis);
          final cwd = find.byKey(const ValueKey('project-cwd-$longCwd'));
          expect(cwd, findsOneWidget);
          final cwdText = tester.widget<Text>(cwd);
          expect(cwdText.data, longCwd);
          expect(cwdText.maxLines, 1);
          expect(cwdText.overflow, TextOverflow.ellipsis);
          // The header carries no copy affordance. It used to, and the
          // button's tooltip opened a card over the roster row on hover. Both
          // the button and the decorated code surface it sat in are gone; the
          // path is non-selectable roster metadata, a plain `Text`.
          expect(find.byType(CopyableCodeLine), findsNothing);
          expect(find.byTooltip('Copy command'), findsNothing);
          expect(tester.takeException(), isNull);

          await tester.tap(find.byKey(const ValueKey('project-new-$longCwd')));
          await tester.pump();
          expect(created, 1);
        }
      },
    );

    testWidgets(
      'project rename stays usable at narrow width in both themes',
      (tester) async {
        final renamed = <SessionProjectGroup>[];
        for (final brightness in [Brightness.light, Brightness.dark]) {
          await tester.pumpWidget(
            host(
              SizedBox(
                width: 320,
                child: SessionListPane(
                  sessions: [
                    _session(
                      'codex',
                      'rename-project',
                      cwd: '/work/exact-project',
                      projectName: 'A project alias that must ellipsize',
                    ),
                  ],
                  activeKey: null,
                  onOpen: (_) {},
                  onRenameProject: renamed.add,
                  visibilityPreferences: const SessionVisibilityPreferences(),
                ),
              ),
              brightness: brightness,
            ),
          );

          await tester.tap(
            find.byKey(const ValueKey('project-rename-/work/exact-project')),
          );

          expect(tester.takeException(), isNull, reason: '$brightness');
        }
        expect(renamed, hasLength(2));
        expect(
          renamed.every((group) => group.cwd == '/work/exact-project'),
          isTrue,
        );
        expect(
          renamed.every(
            (group) => group.label == 'A project alias that must ellipsize',
          ),
          isTrue,
        );
      },
    );

    testWidgets('project rename defers handoff until the dialog closes', (
      tester,
    ) async {
      final registry = WebHandoffParticipants.instance..reset();
      var readinessHints = 0;
      WebHandoffParticipants.readinessHook = () => readinessHints++;
      addTearDown(() {
        WebHandoffParticipants.readinessHook = null;
        registry.reset();
      });
      const project = SessionProjectGroup(
        key: '/work/rename',
        cwd: '/work/rename',
        label: 'Rename me',
        rows: [],
        rootCount: 0,
        summaryStatus: SessionStatus.idle,
        needsInputCount: 0,
        workingCount: 0,
        idleCount: 0,
        readyCount: 0,
      );
      await tester.pumpWidget(
        host(
          Consumer(
            builder: (context, ref, child) => TextButton(
              key: const Key('open-project-rename'),
              onPressed: () => unawaited(
                renameProjectAliasFromList(context, ref, project),
              ),
              child: const Text('Open rename'),
            ),
          ),
        ),
      );

      await tester.tap(find.byKey(const Key('open-project-rename')));
      await tester.pumpAndSettle();

      expect(registry.participantCount, 1);
      expect(await registry.prepare(), isFalse);
      expect(readinessHints, 0);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(registry.participantCount, 0);
      expect(readinessHints, 1);
      expect(await registry.prepare(), isTrue);
    });

    testWidgets('renders filters and roster metadata in dark theme', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session(
                'opencode',
                'dark',
                title: 'Dark roster',
                status: SessionStatus.needsInput,
                currentModel: const SessionCurrentModel(
                  providerID: 'anthropic',
                  modelID: 'claude-opus-4-8',
                ),
              ),
            ],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
          brightness: Brightness.dark,
        ),
      );
      await tester.pumpAndSettle();
      await expandProject(tester, ungrouped);

      expect(find.byKey(const Key('session-roster-search')), findsOneWidget);
      expect(find.text('OpenCode · Opus 4.8'), findsOneWidget);
      expect(find.text('Needs input'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('formats old activity dates with Material locale rules', (
      tester,
    ) async {
      final updated = DateTime(2020, 1, 2);
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: [
              _session(
                'codex',
                'dated',
                updatedAt: updated.millisecondsSinceEpoch,
              ),
            ],
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      await expandProject(tester, ungrouped);

      final row = find.byKey(const Key('session-row-codex/dated'));
      final localized = MaterialLocalizations.of(
        tester.element(row),
      ).formatCompactDate(updated);
      expect(find.textContaining(localized), findsOneWidget);
      expect(localized, isNot('1/2/2020'));
    });
  });

  // R1b. Expansion is tracked as an explicit expanded-key set, so anything the
  // roster has not been told to open — including a project discovered by a
  // later delta — stays closed. Every case below fails against the previous
  // collapsed-key model, where an empty set meant "everything is open".
  group('SessionListPane project expansion (R1b)', () {
    Widget roster(
      List<SessionInfo> sessions, {
      double? width,
      Brightness brightness = Brightness.light,
      Future<void> Function()? onRefresh,
      Future<void> Function()? onRetry,
    }) {
      final pane = SessionListPane(
        sessions: sessions,
        activeKey: null,
        onOpen: (_) {},
        onRefresh: onRefresh,
        onRetry: onRetry,
        visibilityPreferences: const SessionVisibilityPreferences(),
      );
      return host(
        width == null ? pane : SizedBox(width: width, child: pane),
        brightness: brightness,
      );
    }

    SessionInfo alpha(
      String id, {
      SessionStatus status = SessionStatus.idle,
      String? projectName,
      String cwd = '/work/alpha',
    }) => _session(
      'codex',
      id,
      title: 'Alpha $id',
      status: status,
      cwd: cwd,
      projectName: projectName,
    );

    final beta = _session('codex', 'b1', title: 'Beta one', cwd: '/work/beta');

    testWidgets('a project discovered after initial load starts collapsed', (
      tester,
    ) async {
      await tester.pumpWidget(roster([alpha('a1')]));
      await tester.pumpAndSettle();
      await expandProject(tester, '/work/alpha');
      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);

      // A later roster response brings a project the user has never opened.
      await tester.pumpWidget(roster([alpha('a1'), beta]));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/b1')), findsNothing);
      expect(
        find.byKey(const ValueKey('project-header-/work/beta')),
        findsOneWidget,
      );
    });

    testWidgets('manual expansion survives refresh, reorder, and status', (
      tester,
    ) async {
      await tester.pumpWidget(roster([alpha('a1'), alpha('a2'), beta]));
      await tester.pumpAndSettle();
      await expandProject(tester, '/work/alpha');
      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);

      // Same identities, reordered and re-statused exactly as a delta would.
      await tester.pumpWidget(
        roster([
          beta,
          alpha('a2', status: SessionStatus.working),
          alpha('a1', status: SessionStatus.needsInput),
        ]),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/a2')), findsOneWidget);
      // A status change must not auto-open the untouched sibling project.
      expect(find.byKey(const Key('session-row-codex/b1')), findsNothing);
    });

    testWidgets('search reveals matches and clearing restores the saved view', (
      tester,
    ) async {
      await tester.pumpWidget(roster([alpha('a1'), beta]));
      await tester.pumpAndSettle();
      await expandProject(tester, '/work/alpha');

      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/b1')), findsNothing);

      // The reveal shows the matching group without writing to the saved set.
      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'Beta',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-codex/b1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/a1')), findsNothing);

      // Clearing restores exactly the pre-search presentation: alpha open
      // because the user opened it, beta closed because they never did.
      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        '',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/b1')), findsNothing);
    });

    testWidgets('collapsing during a reveal never edits the saved set', (
      tester,
    ) async {
      await tester.pumpWidget(roster([alpha('a1'), beta]));
      await tester.pumpAndSettle();
      await expandProject(tester, '/work/alpha');

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'Alpha',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);

      // Closing the revealed group is a transient presentation choice.
      await expandProject(tester, '/work/alpha');
      expect(find.byKey(const Key('session-row-codex/a1')), findsNothing);

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        '',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);
    });

    testWidgets(
      'a display rename keeps expansion; a new key starts collapsed',
      (
        tester,
      ) async {
        await tester.pumpWidget(roster([alpha('a1')]));
        await tester.pumpAndSettle();
        await expandProject(tester, '/work/alpha');
        expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);

        // The group key is the real directory, so a projectName rename is
        // display-only and the expansion holds.
        await tester.pumpWidget(roster([alpha('a1', projectName: 'Renamed')]));
        await tester.pumpAndSettle();
        expect(find.text('Renamed'), findsOneWidget);
        expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);

        // A moved directory is a different, unknown key: collapsed by rule.
        await tester.pumpWidget(
          roster([alpha('a1', cwd: '/work/alpha-moved')]),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('project-header-/work/alpha-moved')),
          findsOneWidget,
        );
        expect(find.byKey(const Key('session-row-codex/a1')), findsNothing);
      },
    );

    testWidgets('collapsed headers keep the total and non-zero counts only', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster([
          alpha('a1', status: SessionStatus.needsInput),
          alpha('a2', status: SessionStatus.working),
          alpha('a3', status: SessionStatus.working),
        ]),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-row-codex/a1')), findsNothing);
      final total = tester.widget<Text>(
        find.byKey(const ValueKey('project-total-/work/alpha')),
      );
      expect(total.data, '3');
      expect(
        find.byKey(const ValueKey('project-count-/work/alpha-needs-input')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('project-count-/work/alpha-working')),
        findsOneWidget,
      );
      // Idle is zero here and must stay omitted while collapsed.
      expect(
        find.byKey(const ValueKey('project-count-/work/alpha-idle')),
        findsNothing,
      );
      expect(
        tester
            .widget<Tooltip>(
              find.byKey(const ValueKey('project-counts-tooltip-/work/alpha')),
            )
            .message,
        'Needs input: 1 · Working: 2',
      );
    });

    testWidgets('header announces collapsed state and toggles by keyboard', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      const headerKey = ValueKey('project-header-/work/alpha');
      await tester.pumpWidget(roster([alpha('a1')]));
      await tester.pumpAndSettle();

      SemanticsNode header() => tester.getSemantics(find.byKey(headerKey));
      // Tristate.isFalse, not Tristate.none: the header advertises that it has
      // an expanded state and that the state is currently closed.
      expect(header().flagsCollection.isExpanded, Tristate.isFalse);

      // Tab to the header, then activate it the way a keyboard user would.
      bool headerHasFocus() {
        final context = FocusManager.instance.primaryFocus?.context;
        if (context == null) return false;
        var found = false;
        context.visitAncestorElements((element) {
          if (element.widget.key == headerKey) {
            found = true;
            return false;
          }
          return true;
        });
        return found;
      }

      var tabs = 0;
      while (!headerHasFocus() && tabs < 20) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pumpAndSettle();
        tabs += 1;
      }
      expect(headerHasFocus(), isTrue, reason: 'header never took focus');

      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-row-codex/a1')), findsOneWidget);
      expect(header().flagsCollection.isExpanded, Tristate.isTrue);
      semantics.dispose();
    });

    testWidgets(
      'collapses by default and expands at compact and roomy widths',
      (
        tester,
      ) async {
        for (final layout in [
          (name: 'compact', width: 320.0, brightness: Brightness.light),
          (name: 'roomy', width: 900.0, brightness: Brightness.dark),
        ]) {
          // Drop the previous pane so each layout starts from a cold mount.
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpWidget(
            roster(
              [alpha('a1'), alpha('a2')],
              width: layout.width,
              brightness: layout.brightness,
            ),
          );
          await tester.pumpAndSettle();

          expect(
            find.byKey(const Key('session-row-codex/a1')),
            findsNothing,
            reason: layout.name,
          );
          await expandProject(tester, '/work/alpha');
          expect(
            find.byKey(const Key('session-row-codex/a1')),
            findsOneWidget,
            reason: layout.name,
          );
          expect(tester.takeException(), isNull, reason: layout.name);
        }
      },
    );

    testWidgets('expanding, collapsing, and searching issue no roster fetch', (
      tester,
    ) async {
      var refreshes = 0;
      var retries = 0;
      await tester.pumpWidget(
        roster(
          [alpha('a1'), beta],
          onRefresh: () async => refreshes += 1,
          onRetry: () async => retries += 1,
        ),
      );
      await tester.pumpAndSettle();

      await expandProject(tester, '/work/alpha');
      await expandProject(tester, '/work/alpha');
      await expandProject(tester, '/work/beta');
      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'alpha',
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        '',
      );
      await tester.pumpAndSettle();

      expect(refreshes, 0);
      expect(retries, 0);
    });
  });

  // R1c. The roster used to render one flat broker-ordered list with no depth,
  // no rollup and a redundant parent chip. These fail against that renderer.
  group('SessionListPane child tree (R1c)', () {
    const projectKey = '/work/tree';

    SessionInfo node(
      String id, {
      String? parentId,
      SessionStatus status = SessionStatus.idle,
      String title = '',
      String tool = 'opencode',
    }) => SessionInfo(
      id: id,
      tool: tool,
      title: title.isEmpty ? 'Session $id' : title,
      status: status,
      cwd: projectKey,
      attachMode: AttachMode.observe,
      nativeId: id,
      parentThreadId: parentId,
      origin: parentId == null ? null : SessionOrigin.subagent,
    );

    Widget roster(
      List<SessionInfo> sessions, {
      bool showBackground = true,
      double? width,
      Brightness brightness = Brightness.light,
      Locale locale = const Locale('en'),
      Future<void> Function()? onRefresh,
    }) {
      final pane = SessionListPane(
        sessions: sessions,
        activeKey: null,
        onOpen: (_) {},
        onRefresh: onRefresh,
        visibilityPreferences: SessionVisibilityPreferences(
          showBackgroundSessions: showBackground,
        ),
      );
      return host(
        width == null ? pane : SizedBox(width: width, child: pane),
        brightness: brightness,
        locale: locale,
      );
    }

    Future<void> openProject(WidgetTester tester) =>
        expandProject(tester, projectKey);

    double rowIndent(WidgetTester tester, String id) {
      final row = find.byKey(Key('session-row-opencode/$id'));
      final title = find.descendant(
        of: row,
        matching: find.text('Session $id'),
      );
      return tester.getTopLeft(title).dx - tester.getTopLeft(row).dx;
    }

    testWidgets('child-first input still paints the parent then the child', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster([node('c1', parentId: 'p1'), node('p1')]),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      final parent = find.byKey(const Key('session-row-opencode/p1'));
      final child = find.byKey(const Key('session-row-opencode/c1'));
      expect(parent, findsOneWidget);
      expect(child, findsOneWidget);
      expect(
        tester.getTopLeft(parent).dy,
        lessThan(tester.getTopLeft(child).dy),
      );
    });

    testWidgets('child content indents while the whole row stays tappable', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster([node('p1'), node('c1', parentId: 'p1')]),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      // 12 dp per depth, on the 4-point grid.
      expect(rowIndent(tester, 'c1') - rowIndent(tester, 'p1'), 12);

      // The ink response still spans the full row, so the indent is padding
      // rather than a narrowed hit target.
      final parentRow = tester.getRect(
        find.byKey(const Key('session-row-opencode/p1')),
      );
      final childRow = tester.getRect(
        find.byKey(const Key('session-row-opencode/c1')),
      );
      expect(childRow.left, parentRow.left);
      expect(childRow.width, parentRow.width);
    });

    testWidgets('indent steps per depth and stops at the reviewed cap', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster([
          node('p1'),
          node('d1', parentId: 'p1'),
          node('d2', parentId: 'd1'),
          node('d3', parentId: 'd2'),
          node('d4', parentId: 'd3'),
        ]),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      final base = rowIndent(tester, 'p1');
      expect(rowIndent(tester, 'd1') - base, 12);
      expect(rowIndent(tester, 'd2') - base, 24);
      expect(rowIndent(tester, 'd3') - base, 36);
      // Depth 4 keeps its place in the tree but stops eating roster width.
      expect(rowIndent(tester, 'd4') - base, 36);
    });

    testWidgets('a nested tree fits compact width in light and dark', (
      tester,
    ) async {
      for (final brightness in [Brightness.light, Brightness.dark]) {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpWidget(
          roster(
            [
              node('p1', title: 'A parent session with a fairly long title'),
              node(
                'd1',
                parentId: 'p1',
                title: 'A nested subagent with an equally long title',
                status: SessionStatus.working,
              ),
              node('d2', parentId: 'd1', title: 'Deeper still, and longer yet'),
              node('d3', parentId: 'd2', status: SessionStatus.needsInput),
            ],
            width: 320,
            brightness: brightness,
          ),
        );
        await tester.pumpAndSettle();
        await openProject(tester);

        expect(
          find.byKey(const Key('session-row-opencode/d3')),
          findsOneWidget,
          reason: '$brightness',
        );
        expect(tester.takeException(), isNull, reason: '$brightness');
      }
    });

    testWidgets('a nested tree renders at expanded width', (tester) async {
      await tester.pumpWidget(
        roster([
          node('p1'),
          node('d1', parentId: 'p1'),
          node('d2', parentId: 'd1'),
        ], width: 900),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      expect(rowIndent(tester, 'd2') - rowIndent(tester, 'p1'), 24);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the parent pill shows the rolled-up subtree status', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster([
          node('p1'),
          node('c1', parentId: 'p1', status: SessionStatus.working),
        ]),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      // Parent displays Working; the child keeps its own pill.
      final parentPill = find.descendant(
        of: find.byKey(const Key('session-row-opencode/p1')),
        matching: find.text('Working'),
      );
      final childPill = find.descendant(
        of: find.byKey(const Key('session-row-opencode/c1')),
        matching: find.text('Working'),
      );
      expect(parentPill, findsOneWidget);
      expect(childPill, findsOneWidget);
      expect(find.text('Idle'), findsNothing);
    });

    testWidgets('a roster delta updates the pill and counters in place', (
      tester,
    ) async {
      Future<void> pump(SessionStatus childStatus) async {
        await tester.pumpWidget(
          roster([
            node('p1'),
            node('c1', parentId: 'p1', status: childStatus),
          ]),
        );
        await tester.pumpAndSettle();
      }

      await pump(SessionStatus.working);
      await openProject(tester);
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey('project-total-$projectKey')),
            )
            .data,
        '1',
      );
      expect(
        find.byKey(const ValueKey('project-count-$projectKey-working')),
        findsOneWidget,
      );

      // Same widget, one delta: no remount and no reload.
      await pump(SessionStatus.idle);

      expect(
        find.descendant(
          of: find.byKey(const Key('session-row-opencode/p1')),
          matching: find.text('Idle'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('project-count-$projectKey-working')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('project-count-$projectKey-idle')),
        findsOneWidget,
      );
      // The project total still counts logical roots only.
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey('project-total-$projectKey')),
            )
            .data,
        '1',
      );
    });

    testWidgets('expanding children never moves the project counters', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster(
          [
            node('p1'),
            node('c1', parentId: 'p1', status: SessionStatus.working),
            node('c2', parentId: 'p1', status: SessionStatus.working),
          ],
          showBackground: false,
        ),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      String counters() {
        final total = tester
            .widget<Text>(
              find.byKey(const ValueKey('project-total-$projectKey')),
            )
            .data!;
        final summary = tester
            .widget<Tooltip>(
              find.byKey(
                const ValueKey('project-counts-tooltip-$projectKey'),
              ),
            )
            .message!;
        return '$total|$summary';
      }

      final before = counters();
      expect(before, '1|Working: 1');
      expect(find.byKey(const Key('session-row-opencode/c1')), findsNothing);

      await tester.tap(
        find.byKey(const ValueKey('session-children-opencode/p1')),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-row-opencode/c1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-opencode/c2')), findsOneWidget);
      expect(counters(), before);
    });

    testWidgets('parent-local expansion survives a roster delta', (
      tester,
    ) async {
      Future<void> pump(SessionStatus childStatus) async {
        await tester.pumpWidget(
          roster(
            [
              node('c1', parentId: 'p1', status: childStatus),
              node('p1'),
            ],
            showBackground: false,
          ),
        );
        await tester.pumpAndSettle();
      }

      await pump(SessionStatus.idle);
      await openProject(tester);
      await tester.tap(
        find.byKey(const ValueKey('session-children-opencode/p1')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-opencode/c1')), findsOneWidget);

      // Reordered and re-statused delta: the child stays revealed and adjacent.
      await pump(SessionStatus.working);

      final parent = find.byKey(const Key('session-row-opencode/p1'));
      final child = find.byKey(const Key('session-row-opencode/c1'));
      expect(child, findsOneWidget);
      expect(
        tester.getSemantics(parent).flagsCollection.isButton,
        isTrue,
        reason: 'plain row text must not erase button semantics',
      );
      expect(
        tester.getTopLeft(parent).dy,
        lessThan(tester.getTopLeft(child).dy),
      );
    });

    testWidgets('semantics expose the relationship and the expand action', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        roster([
          node('p1', title: 'Build the thing'),
          node('c1', parentId: 'p1'),
        ]),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      // The child announces whose subagent it is now that the chip is gone.
      expect(
        tester
            .getSemantics(
              find.byKey(const ValueKey('session-lineage-opencode/c1')),
            )
            .label,
        contains('Subagent of Build the thing'),
      );
      // The affordance keeps a localized, counted label that states what it
      // will do next — here the child is already revealed by the global
      // background preference, so it offers to hide it.
      expect(
        tester
            .widget<ActionChip>(
              find.byKey(const ValueKey('session-children-opencode/p1')),
            )
            .tooltip,
        'Hide 1 linked session',
      );
      // The redundant parent chip is gone; adjacency carries the relation.
      expect(
        find.byKey(const ValueKey('session-parent-opencode/c1')),
        findsNothing,
      );
      semantics.dispose();
    });

    testWidgets('the expand affordance is localized in Chinese', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster(
          [node('p1'), node('c1', parentId: 'p1'), node('c2', parentId: 'p1')],
          showBackground: false,
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      expect(
        tester
            .widget<ActionChip>(
              find.byKey(const ValueKey('session-children-opencode/p1')),
            )
            .tooltip,
        '显示 2 个关联会话',
      );
    });

    testWidgets('the child chip hides and reshows with background enabled', (
      tester,
    ) async {
      // Regression: with showBackgroundSessions on, the chip used to read
      // "Show 1 linked session" while the child was already on screen, and
      // tapping it never hid anything.
      await tester.pumpWidget(
        roster([node('p1'), node('c1', parentId: 'p1')]),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      String chipTooltip() => tester
          .widget<ActionChip>(
            find.byKey(const ValueKey('session-children-opencode/p1')),
          )
          .tooltip!;
      Finder chip() =>
          find.byKey(const ValueKey('session-children-opencode/p1'));

      // Children are visible, so the affordance must offer to hide them.
      expect(find.byKey(const Key('session-row-opencode/c1')), findsOneWidget);
      expect(chipTooltip(), 'Hide 1 linked session');

      await tester.tap(chip());
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-opencode/c1')), findsNothing);
      expect(chipTooltip(), 'Show 1 linked session');

      await tester.tap(chip());
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-opencode/c1')), findsOneWidget);
      expect(chipTooltip(), 'Hide 1 linked session');
    });

    testWidgets('searching a hidden child reveals it under its parent', (
      tester,
    ) async {
      // Default visibility, parent never expanded, query matching the child
      // only: the child has to become reachable, then hide again on clear.
      Future<void> pump() async {
        await tester.pumpWidget(
          roster(
            [node('p1', title: 'Build the thing'), node('c1', parentId: 'p1')],
            showBackground: false,
          ),
        );
        await tester.pumpAndSettle();
      }

      await pump();
      await openProject(tester);
      expect(find.byKey(const Key('session-row-opencode/p1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-opencode/c1')), findsNothing);

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'Session c1',
      );
      await tester.pumpAndSettle();

      final parent = find.byKey(const Key('session-row-opencode/p1'));
      final child = find.byKey(const Key('session-row-opencode/c1'));
      expect(child, findsOneWidget);
      expect(parent, findsOneWidget);
      expect(
        tester.getTopLeft(parent).dy,
        lessThan(tester.getTopLeft(child).dy),
      );

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        '',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-row-opencode/c1')), findsNothing);
      expect(find.byKey(const Key('session-row-opencode/p1')), findsOneWidget);
    });

    testWidgets('a saved child collapse does not block a search reveal', (
      tester,
    ) async {
      // The saved map is ignored while narrowing, so a subtree the user closed
      // still surfaces its matching descendant, and clearing restores it.
      await tester.pumpWidget(roster([node('p1'), node('c1', parentId: 'p1')]));
      await tester.pumpAndSettle();
      await openProject(tester);

      Finder chip() =>
          find.byKey(const ValueKey('session-children-opencode/p1'));
      Finder childRow() => find.byKey(const Key('session-row-opencode/c1'));

      // Save an explicit collapse (background visibility is on, so this is a
      // real user choice against the global preference).
      await tester.tap(chip());
      await tester.pumpAndSettle();
      expect(childRow(), findsNothing);

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'Session c1',
      );
      await tester.pumpAndSettle();
      expect(childRow(), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        '',
      );
      await tester.pumpAndSettle();
      expect(childRow(), findsNothing);
    });

    testWidgets('toggling children during a search leaves the saved state', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster(
          [node('p1'), node('c1', parentId: 'p1')],
          showBackground: false,
        ),
      );
      await tester.pumpAndSettle();
      await openProject(tester);

      Finder chip() =>
          find.byKey(const ValueKey('session-children-opencode/p1'));
      Finder childRow() => find.byKey(const Key('session-row-opencode/c1'));

      // Save an explicit expansion.
      await tester.tap(chip());
      await tester.pumpAndSettle();
      expect(childRow(), findsOneWidget);

      // Close it *during* a reveal: transient only.
      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        'Session',
      );
      await tester.pumpAndSettle();
      await tester.tap(chip());
      await tester.pumpAndSettle();
      expect(childRow(), findsNothing);

      // Clearing discards the transient close and restores the saved expansion.
      await tester.enterText(
        find.byKey(const Key('session-roster-search')),
        '',
      );
      await tester.pumpAndSettle();
      expect(childRow(), findsOneWidget);
    });

    testWidgets('projects still collapse by default with children present', (
      tester,
    ) async {
      await tester.pumpWidget(
        roster([node('p1'), node('c1', parentId: 'p1')]),
      );
      await tester.pumpAndSettle();

      // R1b survives R1c: the tree is behind a collapsed project header.
      expect(find.byKey(const Key('session-row-opencode/p1')), findsNothing);
      expect(find.byKey(const Key('session-row-opencode/c1')), findsNothing);
      await openProject(tester);
      expect(find.byKey(const Key('session-row-opencode/p1')), findsOneWidget);
      expect(find.byKey(const Key('session-row-opencode/c1')), findsOneWidget);
    });

    testWidgets('rendering and expanding a tree issues no roster fetch', (
      tester,
    ) async {
      var refreshes = 0;
      await tester.pumpWidget(
        roster(
          [node('p1'), node('c1', parentId: 'p1'), node('g1', parentId: 'c1')],
          showBackground: false,
          onRefresh: () async => refreshes += 1,
        ),
      );
      await tester.pumpAndSettle();
      await openProject(tester);
      await tester.tap(
        find.byKey(const ValueKey('session-children-opencode/p1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('session-children-opencode/c1')),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-row-opencode/g1')), findsOneWidget);
      expect(refreshes, 0);
    });
  });

  group('SessionListPane roster clock and status affordances', () {
    const ungrouped = '__ungrouped__';

    Widget timedRoster({
      required DateTime Function() now,
      required int updatedAt,
      bool tickerEnabled = true,
      SessionStatus status = SessionStatus.idle,
    }) {
      return host(
        TickerMode(
          enabled: tickerEnabled,
          child: SessionListPane(
            sessions: [
              _session(
                'codex',
                'timed',
                status: status,
                updatedAt: updatedAt,
              ),
            ],
            activeKey: null,
            onOpen: (_) {},
            now: now,
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
    }

    testWidgets('relative time advances without a broker rebuild', (
      tester,
    ) async {
      var now = DateTime(2026, 8, 10, 12);
      final updatedAt = now
          .subtract(const Duration(seconds: 30))
          .millisecondsSinceEpoch;
      await tester.pumpWidget(
        timedRoster(now: () => now, updatedAt: updatedAt),
      );
      expect(
        find.byKey(const ValueKey('project-header-__ungrouped__')),
        findsOneWidget,
      );
      await expandProject(tester, ungrouped);
      expect(
        find.byKey(const Key('session-row-codex/timed')),
        findsOneWidget,
      );
      expect(find.textContaining('just now'), findsOneWidget);

      now = now.add(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 30));
      expect(find.textContaining('1m ago'), findsOneWidget);
    });

    testWidgets('one timer serves every row and skips unchanged rebuilds', (
      tester,
    ) async {
      final fixedNow = DateTime(2026, 8, 10, 12);
      var nowReads = 0;
      var periodicTimers = 0;
      DateTime now() {
        nowReads += 1;
        return fixedNow;
      }

      await runZoned(
        () => tester.pumpWidget(
          host(
            SessionListPane(
              sessions: [
                for (var index = 0; index < 8; index += 1)
                  _session(
                    'codex',
                    'clock-$index',
                    updatedAt: fixedNow
                        .subtract(const Duration(minutes: 2))
                        .millisecondsSinceEpoch,
                  ),
              ],
              activeKey: null,
              onOpen: (_) {},
              now: now,
              visibilityPreferences: const SessionVisibilityPreferences(),
            ),
          ),
        ),
        zoneSpecification: ZoneSpecification(
          createPeriodicTimer: (self, parent, zone, duration, callback) {
            periodicTimers += 1;
            return parent.createPeriodicTimer(zone, duration, callback);
          },
        ),
      );
      expect(periodicTimers, 1);

      await expandProject(tester, ungrouped);
      final readsAfterRowsBuilt = nowReads;
      await tester.pump(const Duration(seconds: 30));

      // The timer reads the clock once. Since all eight labels are unchanged,
      // no row rebuild follows and there are no additional per-row reads.
      expect(nowReads, readsAfterRowsBuilt + 1);
    });

    testWidgets('offstage and background clocks pause then refresh on resume', (
      tester,
    ) async {
      var now = DateTime(2026, 8, 10, 12);
      final updatedAt = now
          .subtract(const Duration(seconds: 30))
          .millisecondsSinceEpoch;

      await tester.pumpWidget(
        timedRoster(now: () => now, updatedAt: updatedAt),
      );
      await expandProject(tester, ungrouped);
      expect(find.textContaining('just now'), findsOneWidget);

      await tester.pumpWidget(
        timedRoster(
          now: () => now,
          updatedAt: updatedAt,
          tickerEnabled: false,
        ),
      );
      now = now.add(const Duration(minutes: 2));
      await tester.pump(const Duration(seconds: 60));
      expect(find.textContaining('just now'), findsOneWidget);

      await tester.pumpWidget(
        timedRoster(now: () => now, updatedAt: updatedAt),
      );
      expect(find.textContaining('2m ago'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pump();
      now = now.add(const Duration(minutes: 2));
      await tester.pump(const Duration(seconds: 60));
      expect(find.textContaining('2m ago'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(find.textContaining('4m ago'), findsOneWidget);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
    });

    testWidgets('dispose cancels the shared roster timer', (tester) async {
      final now = DateTime(2026, 8, 10, 12);
      await tester.pumpWidget(
        timedRoster(
          now: () => now,
          updatedAt: now.millisecondsSinceEpoch,
        ),
      );
      await tester.pumpWidget(host(const SizedBox.shrink()));
      await tester.pump(const Duration(minutes: 1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('roster uses pulse and full ring status contracts', (
      tester,
    ) async {
      for (final testCase in const [
        (SessionStatus.working, true, false),
        (SessionStatus.needsInput, false, true),
        (SessionStatus.idle, false, false),
      ]) {
        final now = DateTime(2026, 8, 10, 12);
        await tester.pumpWidget(
          timedRoster(
            now: () => now,
            updatedAt: now.millisecondsSinceEpoch,
            status: testCase.$1,
          ),
        );
        final row = find.byKey(const Key('session-row-codex/timed'));
        if (row.evaluate().isEmpty) {
          await expandProject(tester, ungrouped);
        }
        final marker = tester.widget<StatusDot>(
          find
              .descendant(
                of: row,
                matching: find.byType(StatusDot),
              )
              .first,
        );
        expect(marker.pulse, testCase.$2);
        expect(marker.ringColor != null, testCase.$3);
        expect(marker.ringGapColor != null, testCase.$3);
      }
    });
  });
}
