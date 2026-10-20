import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Transient selection for one tab strip, separate from its active destination.
@immutable
class WorkspaceTabSelection {
  /// An empty selection, or a keyed group with a stable range anchor.
  const WorkspaceTabSelection({this.keys = const {}, this.anchor});

  /// Tabs included in the next group action.
  final Set<String> keys;

  /// Fixed beginning of a Shift-click range.
  final String? anchor;
}

/// Source-scoped selection shared across compact and expanded tab strips.
final NotifierProviderFamily<
  WorkspaceTabSelectionController,
  WorkspaceTabSelection,
  String
>
workspaceTabSelectionProvider =
    NotifierProvider.family<
      WorkspaceTabSelectionController,
      WorkspaceTabSelection,
      String
    >(
      WorkspaceTabSelectionController.new,
    );

/// Applies desktop selection gestures without navigating modified clicks.
class WorkspaceTabSelectionController
    extends FamilyNotifier<WorkspaceTabSelection, String> {
  @override
  WorkspaceTabSelection build(String region) {
    ref
      ..watch(activeBrokerProfileProvider)
      ..listen(openSessionsControllerProvider, (previous, next) {
        if (region == 'sessions') {
          final active = next.valueOrNull?.activeKey;
          final valid =
              next.valueOrNull?.refs.map((entry) => entry.key).toSet() ??
              <String>{};
          state = previous?.valueOrNull?.activeKey != active
              ? WorkspaceTabSelection(
                  keys: {if (active != null) active},
                  anchor: active,
                )
              : WorkspaceTabSelection(
                  keys: state.keys.intersection(valid),
                  anchor: state.anchor,
                );
        }
        if (region != 'sessions' &&
            previous?.valueOrNull?.activeKey != next.valueOrNull?.activeKey) {
          state = const WorkspaceTabSelection();
        }
      });
    if (region.startsWith('files:')) {
      ref.listen(filePanesControllerProvider, (previous, next) {
        final valid =
            next.valueOrNull?.panes.map((pane) => pane.key).toSet() ??
            <String>{};
        state = WorkspaceTabSelection(
          keys: state.keys.intersection(valid),
          anchor: state.anchor,
        );
      });
    }
    return const WorkspaceTabSelection();
  }

  /// Returns true for a plain click that should activate its destination.
  bool select(String key, List<String> ordered, String? active) {
    final keyboard = HardwareKeyboard.instance;
    final toggle = keyboard.isControlPressed || keyboard.isMetaPressed;
    final range = keyboard.isShiftPressed;
    final kept =
        state.anchor == null &&
            state.keys.isEmpty &&
            active != null &&
            ordered.contains(active)
        ? <String>{active}
        : state.keys.intersection(ordered.toSet());
    final anchor = ordered.contains(state.anchor) ? state.anchor : active;
    if (range) {
      final from = ordered.indexOf(anchor ?? key);
      final to = ordered.indexOf(key);
      final start = from < 0 ? to : from;
      final keys = ordered
          .sublist(start < to ? start : to, (start > to ? start : to) + 1)
          .toSet();
      state = WorkspaceTabSelection(
        keys: toggle ? {...kept, ...keys} : keys,
        anchor: anchor ?? key,
      );
    } else if (toggle) {
      if (!kept.add(key)) kept.remove(key);
      state = WorkspaceTabSelection(keys: kept, anchor: key);
    } else {
      state = WorkspaceTabSelection(keys: {key}, anchor: key);
    }
    return !toggle && !range;
  }

  /// Collapses a selection to the active destination (or clears it).
  void reset([String? active]) => state = WorkspaceTabSelection(
    keys: active == null ? const {} : {active},
    anchor: active,
  );
}

/// Modified clicks select rather than start a drag.
bool get workspaceTabModifiersPressed =>
    HardwareKeyboard.instance.isControlPressed ||
    HardwareKeyboard.instance.isMetaPressed ||
    HardwareKeyboard.instance.isShiftPressed;

/// Moves modified selection into the strip's keyboard scope. This keeps web
/// close chords out of the composer's AltGr character-entry guard.
void focusWorkspaceTabSelection(BuildContext context) {
  if (workspaceTabModifiersPressed) {
    FocusScope.of(context).requestFocus();
  }
}

/// Mouse reorder that checks modifiers at pointer-down rather than build time.
class WorkspaceTabReorderListener extends StatelessWidget {
  /// Keeps touch scrolling and ordinary mouse dragging available.
  const WorkspaceTabReorderListener({
    required this.index,
    required this.child,
    super.key,
  });

  /// Current visual position in the reorderable strip.
  final int index;

  /// The tab content.
  final Widget child;
  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (event) {
      if (event.kind != PointerDeviceKind.mouse ||
          event.buttons != kPrimaryMouseButton ||
          workspaceTabModifiersPressed) {
        return;
      }
      SliverReorderableList.of(context).startItemDragReorder(
        index: index,
        event: event,
        recognizer: ImmediateMultiDragGestureRecognizer(debugOwner: this)
          ..gestureSettings = MediaQuery.maybeGestureSettingsOf(context),
      );
    },
    child: child,
  );
}

/// Lets Escape reset selection after any inner popup has handled the key.
class WorkspaceTabSelectionRegion extends ConsumerStatefulWidget {
  /// Adds Escape handling to one selection region.
  const WorkspaceTabSelectionRegion({
    required this.region,
    required this.activeKey,
    required this.child,
    super.key,
  });

  /// Source-local selection identity.
  final String region;

  /// Destination to retain when clearing a group.
  final String? activeKey;

  /// Strip receiving selection gestures.
  final Widget child;
  @override
  ConsumerState<WorkspaceTabSelectionRegion> createState() =>
      _WorkspaceTabSelectionRegionState();
}

class _WorkspaceTabSelectionRegionState
    extends ConsumerState<WorkspaceTabSelectionRegion> {
  final _scope = FocusScopeNode(
    debugLabel: 'Workspace tab selection',
    traversalEdgeBehavior: TraversalEdgeBehavior.parentScope,
  );

  @override
  void dispose() {
    _scope.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final region = widget.region;
    if (!TickerMode.valuesOf(context).enabled &&
        ref.watch(workspaceTabSelectionProvider(region)).keys.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (context.mounted && !TickerMode.valuesOf(context).enabled) {
          ref.read(workspaceTabSelectionProvider(region).notifier).reset();
        }
      });
    }
    return FocusScope(
      node: _scope,
      onKeyEvent: (_, event) {
        if (event is! KeyDownEvent ||
            event.logicalKey != LogicalKeyboardKey.escape) {
          return KeyEventResult.ignored;
        }
        final selection = ref.read(workspaceTabSelectionProvider(region));
        if ((selection.keys.isEmpty && selection.anchor == null) ||
            (selection.keys.length == 1 &&
                selection.keys.contains(widget.activeKey) &&
                selection.anchor == widget.activeKey)) {
          return KeyEventResult.ignored;
        }
        ref
            .read(workspaceTabSelectionProvider(region).notifier)
            .reset(widget.activeKey);
        return KeyEventResult.handled;
      },
      child: widget.child,
    );
  }
}
