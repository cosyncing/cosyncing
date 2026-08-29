import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Stable identity for every keyboard shortcut the app advertises.
///
/// The enum is the join between a binding site and the help page: binding
/// sites look their specs up by id, and
/// `features/settings/view/keyboard_shortcuts_page.dart` maps the same ids to
/// localized descriptions. Never renumber or reuse a value.
enum AppShortcutId {
  /// Go to the Sessions destination.
  goToSessions,

  /// Go to the Notifications destination.
  goToNotifications,

  /// Go to the Connection destination.
  goToConnection,

  /// Go to the Settings destination.
  goToSettings,

  /// Go to the Transfers destination.
  goToTransfers,

  /// Grow `UiTextScale` one rung.
  increaseTextSize,

  /// Shrink `UiTextScale` one rung.
  decreaseTextSize,

  /// Reset `UiTextScale` to the standard rung.
  resetTextSize,

  /// Ctrl/Cmd + mouse wheel text sizing. A gesture, not a chord: it carries no
  /// activators and exists so the help page can document it.
  wheelTextSize,

  /// Activate an open session by its position in the strip.
  jumpToSession,

  /// Activate the last open session.
  jumpToLastSession,

  /// Activate the next open session, wrapping past the end.
  nextSession,

  /// Activate the previous open session, wrapping past the start.
  previousSession,

  /// Close the active session view (working set only).
  closeSession,

  /// Open the new-session sheet.
  newSession,

  /// Reload the session roster with F5.
  refreshSessions,

  /// Reload the session roster with the Ctrl/Cmd chord.
  refreshSessionsChord,

  /// Focus the roster's search field.
  focusRosterSearch,

  /// Focus the prompt composer.
  focusComposer,

  /// Send the composed prompt.
  sendPrompt,

  /// Select every transfer.
  selectAllTransfers,

  /// Invert the transfer selection.
  invertTransferSelection,

  /// Clear the transfer search or selection.
  clearTransferSearch,

  /// Cancel the focused transfer.
  cancelTransfer,
}

/// Which surface owns a shortcut's handler.
///
/// Handlers stay where the semantics already live; this only says which
/// binding site is expected to supply one.
enum AppShortcutScope {
  /// Bound by `_appRouteNavItems` in `app/router/router.dart`, which also
  /// publishes the chords to the macOS `PlatformMenuBar`.
  navigation,

  /// Bound by the app shell in `app/router/router.dart`.
  global,

  /// Bound by both opened-sessions layout owners: `SessionsWorkspace` (wide)
  /// and `SessionDetailPage` (compact single-pane).
  workspace,

  /// Bound by the roster surfaces.
  sessionList,

  /// Bound by the session detail surfaces.
  sessionDetail,

  /// Bound by the transfer surfaces.
  transfers,
}

/// How the help page groups a shortcut.
enum AppShortcutGroup {
  /// Top-level destinations.
  navigation,

  /// `UiTextScale` controls.
  textSize,

  /// Roster-wide actions.
  sessionList,

  /// The opened-sessions working set (the tab strip).
  openSessions,

  /// Actions inside one session.
  sessionDetail,

  /// Transfer manager actions.
  transfers,
}

/// One shortcut: its activators per surface, and the chord text to show.
///
/// Three activator families, because the web is not free to bind what native
/// desktop is:
///
/// * [nativeActivators] — plain `Ctrl/Cmd+<key>`, Chrome parity. Bound only on
///   native desktop; on web the browser consumes these before Flutter sees
///   them.
/// * [webSafeActivators] — the `Ctrl/Cmd+Alt+<key>` family, bound on every
///   surface. `Ctrl+Alt` is AltGr on Windows and on European Linux layouts, so
///   these carry the [appShortcutAltGrChordAllowed] guard.
/// * [bareActivators] — unmodified keys, bound on every surface and live only
///   outside a text field ([appShortcutBareKeyAllowed]). No browser reserves an
///   unmodified key, which is what makes this the primary web answer.
@immutable
class AppShortcutSpec {
  /// Creates a shortcut spec.
  const AppShortcutSpec({
    required this.id,
    required this.scope,
    required this.group,
    this.nativeActivators = const <SingleActivator>[],
    this.webSafeActivators = const <SingleActivator>[],
    this.bareActivators = const <SingleActivator>[],
    this.nativeChord,
    this.webChord,
    this.unavailableInSafari = false,
  });

  /// Stable identity.
  final AppShortcutId id;

  /// Which surface owns the handler.
  final AppShortcutScope scope;

  /// Help-page grouping.
  final AppShortcutGroup group;

  /// Plain `Ctrl/Cmd` activators, bound on native desktop only.
  final List<SingleActivator> nativeActivators;

  /// `Ctrl/Cmd+Alt` activators, bound on every surface.
  final List<SingleActivator> webSafeActivators;

  /// Unmodified activators, bound on every surface behind the focus guard.
  final List<SingleActivator> bareActivators;

  /// Chord text shown on native desktop; null hides the row there.
  final String? nativeChord;

  /// Chord text shown on web; null hides the row there.
  final String? webChord;

  /// Whether Safari claims this chord for itself. Rendered as a footnote
  /// rather than hiding the row, because the shortcut works in every other
  /// browser.
  final bool unavailableInSafari;

  /// The chord text live on the current surface, or null when the row has no
  /// live binding and must be hidden.
  String? chordFor({required bool webReserved}) =>
      webReserved ? webChord : nativeChord;
}

/// Whether the host browser, not the app, owns the reserved chord families.
///
/// On web the browser takes `Ctrl/Cmd+W`, `+T`, `+N`, `+digits`, `Ctrl+Tab`
/// and the zoom triad before the page sees them, so binding those there would
/// advertise shortcuts that never fire. Reads [kIsWeb] by default.
///
/// [debugWebReservedChordsOverride] overrides it for tests, because `kIsWeb`
/// is a compile-time constant that is always false under the Flutter VM test
/// runner, leaving the web branch otherwise unreachable. This is the one flag
/// for the whole reserved-chord question; zoom used to own a private copy.
bool get appShortcutsWebReserved => debugWebReservedChordsOverride ?? kIsWeb;

/// Test-only override for [appShortcutsWebReserved]. Set it to exercise the
/// web branch and reset it to `null` in a tear-down.
@visibleForTesting
bool? debugWebReservedChordsOverride;

/// The [EditableTextState] that currently holds primary focus, if any.
///
/// Same shape as the check in `_interruptFromShortcut`
/// (`session_detail_page.dart`), which already detects "another editable owns
/// this key".
EditableTextState? _focusedEditable() {
  final context = FocusManager.instance.primaryFocus?.context;
  if (context == null) {
    return null;
  }
  if (context is StatefulElement && context.state is EditableTextState) {
    return context.state as EditableTextState;
  }
  if (context.widget is EditableText) {
    return context.findAncestorStateOfType<EditableTextState>();
  }
  return context.findAncestorStateOfType<EditableTextState>();
}

/// Whether a text field currently holds primary focus.
bool appShortcutEditableHasFocus() => _focusedEditable() != null;

/// Whether an IME composition is in progress in the focused text field.
///
/// Follows the existing precedent in `session_detail_composer.dart` and
/// `session_detail_attachment_intake.dart`: a composing range that is valid
/// and not collapsed means the user is mid-composition, and a command fired
/// then would discard the in-flight text.
bool appShortcutCompositionActive() {
  final composing = _focusedEditable()?.textEditingValue.composing;
  return composing != null && composing.isValid && !composing.isCollapsed;
}

/// Whether an unmodified-key shortcut may fire right now.
///
/// Bare keys are the primary web layer, and they are only safe because this
/// guard is exact: they are live when no text field holds focus and no IME
/// composition is running. Inside a field the keystroke is the user typing.
bool appShortcutBareKeyAllowed() =>
    !appShortcutEditableHasFocus() && !appShortcutCompositionActive();

/// Whether a `Ctrl+Alt` chord may fire right now — the AltGr guard.
///
/// On Windows, and on Linux with the common European layouts, AltGr reports
/// Control+Alt and a `SingleActivator(..., control: true, alt: true)` matches
/// it. AltGr produces real characters there (German `@ € µ`, AZERTY across the
/// digit row, Polish `ń`, Nordic `{ [ ] }`), so every `Ctrl+Alt` chord is
/// suppressed while a text field holds focus. Outside a field AltGr produces
/// no character, so nothing is lost.
///
/// macOS is exempt: `Cmd+Opt` inserts nothing, so the guard would only remove
/// function. Reads [defaultTargetPlatform], which honours
/// `debugDefaultTargetPlatformOverride` in tests.
bool appShortcutAltGrChordAllowed({TargetPlatform? platform}) {
  final effective = platform ?? defaultTargetPlatform;
  final altGrLayout =
      effective == TargetPlatform.windows || effective == TargetPlatform.linux;
  if (!altGrLayout) {
    return true;
  }
  return !appShortcutEditableHasFocus();
}

/// One shortcut handler: fires (or declines) and reports whether it fired.
///
/// The report IS the consumption decision. A guarded-out keystroke must stay
/// unconsumed so it continues to the focused text field — `CallbackShortcuts`
/// marks any matched activator handled regardless of what the callback did,
/// which had the engine `preventDefault` bare digits typed into the composer.
typedef AppShortcutHandler = bool Function();

/// Wraps an unconditional [action] as a handler that always consumes.
AppShortcutHandler appShortcutAlways(VoidCallback action) => () {
  action();
  return true;
};

/// Builds [AppCallbackShortcuts] bindings for [specs] from the handlers
/// supplied by the binding site.
///
/// A spec with no handler in [handlers] contributes nothing, so one call can
/// be given the whole registry slice for a scope and wire only what the site
/// actually owns. Every family carries its guard: the composition guard on
/// modifier chords, the AltGr guard on the `Ctrl+Alt` family, and the focus
/// guard on bare keys. A guard that declines reports unfired, so the
/// keystroke reaches the focused field instead of being swallowed.
///
/// [webReserved] defaults to [appShortcutsWebReserved].
Map<ShortcutActivator, AppShortcutHandler> appShortcutBindings({
  required Iterable<AppShortcutSpec> specs,
  required Map<AppShortcutId, VoidCallback> handlers,
  bool? webReserved,
}) {
  final reserved = webReserved ?? appShortcutsWebReserved;
  final bindings = <ShortcutActivator, AppShortcutHandler>{};
  for (final spec in specs) {
    final handler = handlers[spec.id];
    if (handler == null) {
      continue;
    }
    if (!reserved) {
      for (final activator in spec.nativeActivators) {
        bindings[activator] = () {
          if (appShortcutCompositionActive()) {
            return false;
          }
          handler();
          return true;
        };
      }
    }
    for (final activator in spec.webSafeActivators) {
      bindings[activator] = () {
        if (!appShortcutAltGrChordAllowed()) {
          return false;
        }
        if (appShortcutCompositionActive()) {
          return false;
        }
        handler();
        return true;
      };
    }
    for (final activator in spec.bareActivators) {
      bindings[activator] = appShortcutBareKey(handler);
    }
  }
  return bindings;
}

/// Wraps [action] in the bare-key focus guard; declining reports unfired.
AppShortcutHandler appShortcutBareKey(VoidCallback action) => () {
  if (!appShortcutBareKeyAllowed()) {
    return false;
  }
  action();
  return true;
};

/// Binds each activator in [activators] to [onIndex] with its position.
///
/// The session ordinals are one spec covering eight bare digits, so they
/// cannot go through [appShortcutBindings]'s one-handler-per-id shape.
Map<ShortcutActivator, AppShortcutHandler> appShortcutOrdinalBindings(
  List<SingleActivator> activators,
  void Function(int index) onIndex,
) => <ShortcutActivator, AppShortcutHandler>{
  for (var index = 0; index < activators.length; index++)
    activators[index]: appShortcutBareKey(() => onIndex(index)),
};

/// `CallbackShortcuts` whose consumption follows the handler's report.
///
/// The stock widget returns `handled` for any matched activator even when the
/// callback's guard declined, and a handled keydown never reaches the text
/// input (the web engine `preventDefault`s it; desktop embedders don't
/// forward it to the IME). Here an activator consumes its keystroke only when
/// its [AppShortcutHandler] returns true, so bare keys and AltGr chords typed
/// into a focused field insert their characters.
class AppCallbackShortcuts extends StatelessWidget {
  /// Creates the binding scope.
  const AppCallbackShortcuts({
    required this.bindings,
    required this.child,
    super.key,
  });

  /// Activator → guarded handler, same matching rules as `CallbackShortcuts`.
  final Map<ShortcutActivator, AppShortcutHandler> bindings;

  /// Subtree the bindings cover.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onKeyEvent: (FocusNode node, KeyEvent event) {
        var result = KeyEventResult.ignored;
        // Like the stock widget, every matching binding runs; any that fired
        // consumes.
        for (final entry in bindings.entries) {
          if (entry.key.accepts(event, HardwareKeyboard.instance) &&
              entry.value()) {
            result = KeyEventResult.handled;
          }
        }
        return result;
      },
      child: child,
    );
  }
}

/// The bare digit activators for session ordinals, in strip order: index 0 is
/// the first open session, index 7 the eighth.
///
/// `9` is deliberately absent — it activates the LAST session, Chrome's rule,
/// and is carried by [AppShortcutId.jumpToLastSession].
const List<SingleActivator> kSessionOrdinalActivators = [
  SingleActivator(LogicalKeyboardKey.digit1),
  SingleActivator(LogicalKeyboardKey.digit2),
  SingleActivator(LogicalKeyboardKey.digit3),
  SingleActivator(LogicalKeyboardKey.digit4),
  SingleActivator(LogicalKeyboardKey.digit5),
  SingleActivator(LogicalKeyboardKey.digit6),
  SingleActivator(LogicalKeyboardKey.digit7),
  SingleActivator(LogicalKeyboardKey.digit8),
];

/// Every shortcut the app advertises, in help-page order.
///
/// This is the single source of truth for WHAT the chords are. Binding sites
/// read it, and the help page renders from it, which turns the page's
/// hand-maintained accuracy rule into a structural guarantee.
const List<AppShortcutSpec> kAppShortcuts = [
  // Navigation. Bound by `_appRouteNavItems` in `app/router/router.dart`,
  // which also publishes them to the macOS PlatformMenuBar; declared here so
  // the help page can render them and, on web, hide them. Ctrl/Cmd+digit
  // switches BROWSER tabs there, so listing them on web advertised five
  // bindings that never fire.
  AppShortcutSpec(
    id: AppShortcutId.goToSessions,
    scope: AppShortcutScope.navigation,
    group: AppShortcutGroup.navigation,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.digit1, control: true),
      SingleActivator(LogicalKeyboardKey.digit1, meta: true),
    ],
    nativeChord: 'Ctrl+1 / ⌘1',
  ),
  AppShortcutSpec(
    id: AppShortcutId.goToNotifications,
    scope: AppShortcutScope.navigation,
    group: AppShortcutGroup.navigation,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.digit2, control: true),
      SingleActivator(LogicalKeyboardKey.digit2, meta: true),
    ],
    nativeChord: 'Ctrl+2 / ⌘2',
  ),
  AppShortcutSpec(
    id: AppShortcutId.goToConnection,
    scope: AppShortcutScope.navigation,
    group: AppShortcutGroup.navigation,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.digit3, control: true),
      SingleActivator(LogicalKeyboardKey.digit3, meta: true),
    ],
    nativeChord: 'Ctrl+3 / ⌘3',
  ),
  AppShortcutSpec(
    id: AppShortcutId.goToSettings,
    scope: AppShortcutScope.navigation,
    group: AppShortcutGroup.navigation,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.digit4, control: true),
      SingleActivator(LogicalKeyboardKey.digit4, meta: true),
    ],
    nativeChord: 'Ctrl+4 / ⌘4',
  ),
  AppShortcutSpec(
    id: AppShortcutId.goToTransfers,
    scope: AppShortcutScope.navigation,
    group: AppShortcutGroup.navigation,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.digit5, control: true),
      SingleActivator(LogicalKeyboardKey.digit5, meta: true),
    ],
    nativeChord: 'Ctrl+5 / ⌘5',
  ),

  // Text size. Browser-owned on web: the browser scales the whole page,
  // unbounded, which is the wanted behavior, so nothing is bound and no row is
  // shown there. `equal` is listed with and without Shift because "+" is
  // Shift+= on most layouts.
  AppShortcutSpec(
    id: AppShortcutId.increaseTextSize,
    scope: AppShortcutScope.global,
    group: AppShortcutGroup.textSize,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.equal, control: true),
      SingleActivator(LogicalKeyboardKey.equal, meta: true),
      SingleActivator(LogicalKeyboardKey.equal, control: true, shift: true),
      SingleActivator(LogicalKeyboardKey.equal, meta: true, shift: true),
      SingleActivator(LogicalKeyboardKey.numpadAdd, control: true),
      SingleActivator(LogicalKeyboardKey.numpadAdd, meta: true),
    ],
    nativeChord: 'Ctrl+= / ⌘=',
  ),
  AppShortcutSpec(
    id: AppShortcutId.decreaseTextSize,
    scope: AppShortcutScope.global,
    group: AppShortcutGroup.textSize,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.minus, control: true),
      SingleActivator(LogicalKeyboardKey.minus, meta: true),
      SingleActivator(LogicalKeyboardKey.numpadSubtract, control: true),
      SingleActivator(LogicalKeyboardKey.numpadSubtract, meta: true),
    ],
    nativeChord: 'Ctrl+− / ⌘−',
  ),
  AppShortcutSpec(
    id: AppShortcutId.resetTextSize,
    scope: AppShortcutScope.global,
    group: AppShortcutGroup.textSize,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.digit0, control: true),
      SingleActivator(LogicalKeyboardKey.digit0, meta: true),
      SingleActivator(LogicalKeyboardKey.numpad0, control: true),
      SingleActivator(LogicalKeyboardKey.numpad0, meta: true),
    ],
    nativeChord: 'Ctrl+0 / ⌘0',
  ),
  AppShortcutSpec(
    id: AppShortcutId.wheelTextSize,
    scope: AppShortcutScope.global,
    group: AppShortcutGroup.textSize,
    nativeChord: 'Ctrl+scroll',
  ),

  // Session list.
  AppShortcutSpec(
    id: AppShortcutId.refreshSessions,
    scope: AppShortcutScope.sessionList,
    group: AppShortcutGroup.sessionList,
    nativeChord: 'F5',
    webChord: 'F5',
  ),
  AppShortcutSpec(
    id: AppShortcutId.refreshSessionsChord,
    scope: AppShortcutScope.sessionList,
    group: AppShortcutGroup.sessionList,
    nativeChord: 'Ctrl+R / ⌘R',
    webChord: 'Ctrl+R / ⌘R',
  ),
  // Bare `/` is the primary form and the one web convention already teaches;
  // it needs no fallback, which is why the Safari gap on ⌘⌥F stops mattering.
  // The plain Ctrl/Cmd+F form is bound on native only — on web the browser
  // takes it for find-in-page before Flutter sees it.
  AppShortcutSpec(
    id: AppShortcutId.focusRosterSearch,
    scope: AppShortcutScope.sessionList,
    group: AppShortcutGroup.sessionList,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.keyF, control: true),
      SingleActivator(LogicalKeyboardKey.keyF, meta: true),
    ],
    webSafeActivators: [
      SingleActivator(LogicalKeyboardKey.keyF, control: true, alt: true),
      SingleActivator(LogicalKeyboardKey.keyF, meta: true, alt: true),
    ],
    bareActivators: [SingleActivator(LogicalKeyboardKey.slash)],
    nativeChord: '/ or Ctrl+F / ⌘F',
    webChord: '/ or Ctrl+Alt+F / ⌘⌥F',
  ),

  // The opened-sessions working set. Closing removes the tab, never the
  // session: the agent keeps running and the roster row stays.
  AppShortcutSpec(
    id: AppShortcutId.jumpToSession,
    scope: AppShortcutScope.workspace,
    group: AppShortcutGroup.openSessions,
    bareActivators: kSessionOrdinalActivators,
    nativeChord: '1 … 8',
    webChord: '1 … 8',
  ),
  AppShortcutSpec(
    id: AppShortcutId.jumpToLastSession,
    scope: AppShortcutScope.workspace,
    group: AppShortcutGroup.openSessions,
    bareActivators: [SingleActivator(LogicalKeyboardKey.digit9)],
    nativeChord: '9',
    webChord: '9',
  ),
  AppShortcutSpec(
    id: AppShortcutId.nextSession,
    scope: AppShortcutScope.workspace,
    group: AppShortcutGroup.openSessions,
    nativeActivators: [SingleActivator(LogicalKeyboardKey.tab, control: true)],
    bareActivators: [SingleActivator(LogicalKeyboardKey.bracketRight)],
    nativeChord: '] / Ctrl+Tab',
    webChord: ']',
  ),
  AppShortcutSpec(
    id: AppShortcutId.previousSession,
    scope: AppShortcutScope.workspace,
    group: AppShortcutGroup.openSessions,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.tab, control: true, shift: true),
    ],
    bareActivators: [SingleActivator(LogicalKeyboardKey.bracketLeft)],
    nativeChord: '[ / Ctrl+Shift+Tab',
    webChord: '[',
  ),
  AppShortcutSpec(
    id: AppShortcutId.closeSession,
    scope: AppShortcutScope.workspace,
    group: AppShortcutGroup.openSessions,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.keyW, control: true),
      SingleActivator(LogicalKeyboardKey.keyW, meta: true),
    ],
    webSafeActivators: [
      SingleActivator(LogicalKeyboardKey.keyW, control: true, alt: true),
      SingleActivator(LogicalKeyboardKey.keyW, meta: true, alt: true),
    ],
    nativeChord: 'Ctrl+W / ⌘W',
    webChord: 'Ctrl+Alt+W / ⌘⌥W',
    unavailableInSafari: true,
  ),
  // `T` on native, `N` on web: `Ctrl+Alt+T` is Ubuntu's terminal.
  AppShortcutSpec(
    id: AppShortcutId.newSession,
    scope: AppShortcutScope.workspace,
    group: AppShortcutGroup.openSessions,
    nativeActivators: [
      SingleActivator(LogicalKeyboardKey.keyT, control: true),
      SingleActivator(LogicalKeyboardKey.keyT, meta: true),
    ],
    webSafeActivators: [
      SingleActivator(LogicalKeyboardKey.keyN, control: true, alt: true),
      SingleActivator(LogicalKeyboardKey.keyN, meta: true, alt: true),
    ],
    nativeChord: 'Ctrl+T / ⌘T',
    webChord: 'Ctrl+Alt+N / ⌘⌥N',
  ),

  // Session detail.
  AppShortcutSpec(
    id: AppShortcutId.focusComposer,
    scope: AppShortcutScope.sessionDetail,
    group: AppShortcutGroup.sessionDetail,
    nativeChord: 'Ctrl+K / ⌘K',
    webChord: 'Ctrl+K / ⌘K',
  ),
  AppShortcutSpec(
    id: AppShortcutId.sendPrompt,
    scope: AppShortcutScope.sessionDetail,
    group: AppShortcutGroup.sessionDetail,
    nativeChord: 'Ctrl+Enter / ⌘Enter',
    webChord: 'Ctrl+Enter / ⌘Enter',
  ),

  // Transfers.
  AppShortcutSpec(
    id: AppShortcutId.selectAllTransfers,
    scope: AppShortcutScope.transfers,
    group: AppShortcutGroup.transfers,
    nativeChord: 'Ctrl+A / ⌘A',
    webChord: 'Ctrl+A / ⌘A',
  ),
  AppShortcutSpec(
    id: AppShortcutId.invertTransferSelection,
    scope: AppShortcutScope.transfers,
    group: AppShortcutGroup.transfers,
    nativeChord: 'Ctrl+I / ⌘I',
    webChord: 'Ctrl+I / ⌘I',
  ),
  AppShortcutSpec(
    id: AppShortcutId.clearTransferSearch,
    scope: AppShortcutScope.transfers,
    group: AppShortcutGroup.transfers,
    nativeChord: 'Esc',
    webChord: 'Esc',
  ),
  AppShortcutSpec(
    id: AppShortcutId.cancelTransfer,
    scope: AppShortcutScope.transfers,
    group: AppShortcutGroup.transfers,
    nativeChord: 'Esc / Del',
    webChord: 'Esc / Del',
  ),
];

/// The specs owned by [scope], in registry order.
Iterable<AppShortcutSpec> appShortcutsForScope(AppShortcutScope scope) =>
    kAppShortcuts.where((spec) => spec.scope == scope);
