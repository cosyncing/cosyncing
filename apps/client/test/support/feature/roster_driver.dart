import 'package:cosyncing_client/src/design/components/adaptive_picker.dart';
// Roster, new-session and open-tab verbs for feature tests (F02).
//
// Everything is a thin finder or a user gesture over the real App; waiting is
// bounded frame pumping under fake time (see `AppDriver`).
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'fake_broker.dart';

/// Roster verbs over a running App.
extension RosterDriver on AppDriver {
  /// The roster row of session [id] under [tool].
  Finder row(String id, {String tool = 'codex'}) =>
      find.byKey(Key('session-row-$tool/$id'));

  /// The header of the project group for [cwd].
  Finder projectHeader(String cwd) => find.byKey(Key('project-header-$cwd'));

  /// Opens project group [cwd] when it is collapsed; leaves it alone when open.
  Future<void> expandProject(String cwd) async {
    await waitFor(projectHeader(cwd));
    if (isProjectExpanded(cwd)) return;
    await tester.tap(projectHeader(cwd));
    await settle();
  }

  /// Whether project group [cwd] is open (its collapse chevron is upright).
  bool isProjectExpanded(String cwd) {
    final icon = find.byKey(ValueKey('project-collapse-icon-$cwd'));
    if (icon.evaluate().isEmpty) return false;
    return (tester.widget(icon) as dynamic).quarterTurns == 0;
  }

  /// Types [query] into the roster search box.
  Future<void> search(String query) async {
    await tester.enterText(
      find.byKey(const Key('session-roster-search')),
      query,
    );
    await settle();
  }

  /// Switches to saved server [id] through the workspace server menu.
  Future<void> switchServer(String id) async {
    // A snack bar sits over the server row until it times out.
    await waitForAbsent(find.byType(SnackBar));
    await tapKey('workspace-server-row');
    await tap(find.byKey(Key('workspace-server-option-$id')));
  }

  /// Opens the project context menu for [cwd] (right click on the header).
  Future<void> openProjectMenu(String cwd) async {
    await tester.tap(projectHeader(cwd), buttons: kSecondaryButton);
    await settle();
  }

  /// Renames project [cwd] to [name] through its context menu.
  Future<void> renameProject(String cwd, String name) async {
    await openProjectMenu(cwd);
    await tap(find.byKey(Key('project-menu-rename-$cwd')));
    await enterText(find.byKey(const Key('project-rename-input')), name);
    await tapKey('project-rename-confirm');
  }

  // --- new session --------------------------------------------------------

  /// Opens the New session sheet from the sidebar's global button.
  Future<void> openNewSession() => tapKey('sessions-workspace-global-new');

  /// The agent picker in the New session sheet.
  Finder get agentPicker => find.descendant(
    of: find.byKey(const Key('new-session-agent')),
    matching: find.byType(AdaptivePickerFormField<String>),
  );

  /// The model picker in the New session sheet.
  Finder get modelPicker => find.byWidgetPredicate(
    (w) =>
        w is AdaptivePickerFormField<String> &&
        w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith('new-session-model-'),
  );

  /// The permission-mode picker in the New session sheet.
  Finder get modePicker => find.byWidgetPredicate(
    (w) =>
        w is AdaptivePickerFormField<String> &&
        w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith(
          'new-session-permission-',
        ),
  );

  /// Opens [picker] and chooses the entry labelled [label].
  Future<void> choose(Finder picker, String label) async {
    await tap(picker);
    await tester.ensureVisible(find.text(label).last);
    await tester.tap(find.text(label).last);
    await settle();
  }

  /// The labels [picker] offers, in order.
  List<String> optionsOf(Finder picker) {
    final button = tester.widget<AdaptivePickerFormField<String>>(picker);
    return [
      for (final item in button.items)
        switch (item.child) {
          final Text text => text.data ?? '',
          final Tooltip tooltip when tooltip.child is Text =>
            (tooltip.child! as Text).data ?? '',
          _ => '?',
        },
    ];
  }

  /// Presses Create in the New session sheet.
  Future<void> submitNewSession() => tapKey('new-session-submit');

  /// Presses the roster's Retry button.
  Future<void> retryRoster() => tapKey('session-roster-retry');

  /// Opens a session from its roster row, expanding its project first.
  Future<void> openFromRoster(
    String id, {
    String tool = 'codex',
    String? cwd,
  }) async {
    if (cwd != null) await expandProject(cwd);
    await tester.tap(row(id, tool: tool));
    await settle();
  }

  /// The tab for the open session [id].
  Finder tab(String id, {String tool = 'codex'}) =>
      find.byKey(Key('open-session-tab-$tool/$id'));

  /// The open-session tabs on screen, left to right, as `tool/id` keys.
  List<String> get openTabKeys {
    final pattern = RegExp(
      r'^open-session-tab-(?!close-|unread-|prompt-)(.+/.+)$',
    );
    final tabs = <(double, String)>[];
    for (final element in find.byWidgetPredicate((w) {
      final key = w.key;
      return key is ValueKey<String> && pattern.hasMatch(key.value);
    }).evaluate()) {
      final key = (element.widget.key! as ValueKey<String>).value;
      final box = element.renderObject! as RenderBox;
      tabs.add((
        box.localToGlobal(Offset.zero).dx,
        pattern.firstMatch(key)!.group(1)!,
      ));
    }
    tabs.sort((a, b) => a.$1.compareTo(b.$1));
    return [for (final (_, key) in tabs) key];
  }

  /// The key of the active tab, if any.
  String? get activeTabKey =>
      container.read(openSessionsControllerProvider).valueOrNull?.activeKey;

  /// Text of the label on tab [id].
  String tabLabel(String id, {String tool = 'codex'}) {
    final texts = find.descendant(
      of: tab(id, tool: tool),
      matching: find.byType(Text),
    );
    return tester.widget<Text>(texts.first).data ?? '';
  }

  /// Roster reads (`GET /api/sessions`) [broker] has seen, optionally only
  /// those for one query [window] (the sidebar asks `7d` by default).
  List<FakeBrokerRequest> rosterReads(FakeBroker broker, {String? window}) => [
    for (final request in broker.requestsTo('/api/sessions', method: 'GET'))
      if (window == null || request.uri.queryParameters['window'] == window)
        request,
  ];

  /// Moves the app to [state] like the operating system would.
  Future<void> lifecycle(AppLifecycleState state) async {
    // The framework only allows the legal chain between states.
    const chain = [
      AppLifecycleState.resumed,
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ];
    var current = tester.binding.lifecycleState ?? AppLifecycleState.resumed;
    final target = chain.indexOf(state);
    while (current != state) {
      final at = chain.indexOf(current);
      current = chain[at + (target > at ? 1 : -1)];
      tester.binding.handleAppLifecycleStateChanged(current);
    }
    await settle();
  }

  /// Rows the roster currently lists, in order, by session key.
  List<String> get rosterRowKeys => [
    for (final element
        in find
            .byWidgetPredicate(
              (w) =>
                  w.key is Key &&
                  '${w.key}'.contains('session-row-') &&
                  w is! SizedBox,
            )
            .evaluate())
      (element.widget.key! as ValueKey<String>).value.substring(
        'session-row-'.length,
      ),
  ];

  /// The roster's loaded sessions (controller state, for ordering asserts).
  List<SessionRef> get rosterRefs => [
    for (final s in container.read(rosterSessionsProvider))
      SessionRef.fromSession(s),
  ];

  /// Sends Ctrl+F (the roster search chord on desktop).
  Future<void> pressCtrlF() async {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await settle();
  }
}
