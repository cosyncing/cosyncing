part of 'session_detail_page.dart';

/// Everything the `⋮` menu can do: switch view, or flip a chat-scoped toggle.
enum _SessionViewMenuAction {
  chat,
  status,
  terminal,
  files,
  debug,
  reportView,
  expandTools,
}

/// Row height for every entry in the ⋮ menu.
///
/// 32 rather than Material's 48 (or the 40 this menu shipped with): the rows
/// carry one 18px icon and a `bodySmall` label, so 40 was padding a 12px line
/// with 28dp of air. Still a comfortable pointer target, and the menu is
/// keyboard- and touch-reachable at this height on every platform the app
/// targets.
const double _menuItemHeight = 32;

/// Horizontal inset for ⋮ menu rows (Material default is 16).
const EdgeInsets _menuItemPadding = EdgeInsets.symmetric(horizontal: 12);

/// The single overflow menu for the session, anchored top-right.
///
/// Variant C folds four views out of a tab strip and into this menu, so the
/// signals that strip used to carry have to survive the move: the Status badge
/// count and the Terminal fresh-output dot render inline on their items, and
/// the button itself takes an aggregate dot whenever an *inactive* view has
/// something unseen. Dropping either would lose information silently — the
/// counts would still be computed and simply never shown.
class _SessionViewMenu extends StatelessWidget {
  const _SessionViewMenu({
    required this.view,
    required this.showTerminal,
    required this.showDebug,
    required this.statusBadgeCount,
    required this.terminalFresh,
    required this.reportView,
    required this.toolsExpanded,
    required this.onSelectView,
    required this.onReportViewChanged,
    required this.onToolsExpandedChanged,
  });

  final _SessionDetailView view;
  final bool showTerminal;

  /// Whether the read-only Debug destination is offered (D1 gate).
  final bool showDebug;
  final int statusBadgeCount;
  final bool terminalFresh;
  final bool reportView;
  final bool toolsExpanded;
  final ValueChanged<_SessionDetailView> onSelectView;
  final ValueChanged<bool> onReportViewChanged;
  final ValueChanged<bool> onToolsExpandedChanged;

  /// Unseen signals from views the user is not currently looking at.
  ///
  /// Empty means no dot. Non-empty doubles as the tooltip, which enumerates
  /// what is waiting rather than leaving a bare dot to be decoded.
  List<String> _pendingSignals(AppLocalizations l10n) => [
    if (statusBadgeCount > 0 && view != _SessionDetailView.status)
      l10n.sessionViewMenuStatusUpdates(statusBadgeCount),
    if (showTerminal && terminalFresh && view != _SessionDetailView.terminal)
      l10n.sessionViewMenuTerminalOutput,
  ];

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final scale = MediaQuery.textScalerOf(context);
    final pending = _pendingSignals(l10n);

    return SizedBox(
      width: 32,
      height: 32,
      child: PopupMenuButton<_SessionViewMenuAction>(
        key: const Key('session-detail-view-menu'),
        tooltip: pending.isEmpty
            ? l10n.sessionViewMenuTooltip
            : pending.join(' · '),
        // 16px matches `_stripIconButtonStyle`, so the ⋮ and the back chevron
        // read as one icon family rather than two weights in a 36dp row.
        iconSize: scale.scale(16),
        padding: EdgeInsets.zero,
        // 184, not the spec's 220: the widest row ("Expand all tools") needs
        // 18 icon + 12 gap + ~92 label + 12 badge gutter, so 220 left ~90dp of
        // dead width on every row. Measured at 1440 and 420.
        constraints: const BoxConstraints(minWidth: 184),
        // Halves the menu's own top/bottom inset (Material default is 8).
        menuPadding: const EdgeInsets.symmetric(vertical: 4),
        position: PopupMenuPosition.under,
        icon: Stack(
          clipBehavior: Clip.none,
          children: [
            const Icon(Icons.more_vert),
            if (pending.isNotEmpty)
              Positioned(
                right: -1,
                top: -1,
                child: Container(
                  key: const Key('session-detail-view-menu-dot'),
                  // 4dp rather than the spec's 6: the dot rides a 16px glyph in
                  // a 36dp strip, and 6 read as a blob against it. Checked at
                  // both brightnesses — accent on surface still carries at 4.
                  width: 4,
                  height: 4,
                  decoration: BoxDecoration(
                    color: tokens.accent,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
          ],
        ),
        onSelected: (action) {
          switch (action) {
            case _SessionViewMenuAction.chat:
              onSelectView(_SessionDetailView.chat);
            case _SessionViewMenuAction.status:
              onSelectView(_SessionDetailView.status);
            case _SessionViewMenuAction.terminal:
              onSelectView(_SessionDetailView.terminal);
            case _SessionViewMenuAction.files:
              onSelectView(_SessionDetailView.files);
            case _SessionViewMenuAction.debug:
              onSelectView(_SessionDetailView.debug);
            case _SessionViewMenuAction.reportView:
              onReportViewChanged(!reportView);
            case _SessionViewMenuAction.expandTools:
              onToolsExpandedChanged(!toolsExpanded);
          }
        },
        itemBuilder: (context) => [
          _destination(
            context,
            action: _SessionViewMenuAction.chat,
            target: _SessionDetailView.chat,
            name: 'chat',
            label: l10n.sessionViewChat,
          ),
          _destination(
            context,
            action: _SessionViewMenuAction.status,
            target: _SessionDetailView.status,
            name: 'status',
            label: l10n.sessionViewStatus,
            badgeCount: statusBadgeCount,
          ),
          if (showTerminal)
            _destination(
              context,
              action: _SessionViewMenuAction.terminal,
              target: _SessionDetailView.terminal,
              name: 'terminal',
              label: l10n.sessionViewTerminal,
              showDot: terminalFresh,
            ),
          _destination(
            context,
            action: _SessionViewMenuAction.files,
            target: _SessionDetailView.files,
            name: 'files',
            label: l10n.sessionViewFiles,
          ),
          if (showDebug)
            _destination(
              context,
              action: _SessionViewMenuAction.debug,
              target: _SessionDetailView.debug,
              name: 'debug',
              label: l10n.sessionViewDebug,
            ),
          // Half the Material default (16): the rule only has to separate
          // destinations from toggles, not open a gap in the middle of a
          // six-row menu.
          const PopupMenuDivider(height: 8),
          _toggle(
            context,
            action: _SessionViewMenuAction.reportView,
            name: 'report',
            label: l10n.sessionComposerMenuReportView,
            checked: reportView,
          ),
          _toggle(
            context,
            action: _SessionViewMenuAction.expandTools,
            name: 'expand',
            label: l10n.sessionComposerMenuExpandTools,
            checked: toolsExpanded,
          ),
        ],
      ),
    );
  }

  PopupMenuEntry<_SessionViewMenuAction> _destination(
    BuildContext context, {
    required _SessionViewMenuAction action,
    required _SessionDetailView target,
    required String name,
    required String label,
    int badgeCount = 0,
    bool showDot = false,
  }) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final active = view == target;
    return PopupMenuItem<_SessionViewMenuAction>(
      key: Key('session-detail-view-item-$name'),
      value: action,
      height: _menuItemHeight,
      padding: _menuItemPadding,
      child: Row(
        children: [
          SizedBox.square(
            dimension: 18,
            child: active
                ? Icon(Icons.check, size: 16, color: tokens.accent)
                : null,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: active ? FontWeight.w600 : null,
              ),
            ),
          ),
          if (badgeCount > 0 || showDot) ...[
            const SizedBox(width: 12),
            _MenuSignalBadge(name: name, count: badgeCount),
          ],
        ],
      ),
    );
  }

  PopupMenuEntry<_SessionViewMenuAction> _toggle(
    BuildContext context, {
    required _SessionViewMenuAction action,
    required String name,
    required String label,
    required bool checked,
  }) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return PopupMenuItem<_SessionViewMenuAction>(
      key: Key('session-detail-view-item-$name'),
      value: action,
      height: _menuItemHeight,
      padding: _menuItemPadding,
      child: Row(
        children: [
          Icon(
            checked ? Icons.check_box_outlined : Icons.check_box_outline_blank,
            size: 18,
            color: checked ? tokens.accent : tokens.textTertiary,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(label, style: theme.textTheme.bodySmall),
          ),
        ],
      ),
    );
  }
}

/// The Status count / Terminal freshness marker, rendered inline on a menu row.
///
/// This is the tab strip's badge, relocated. Same accent pill, same "dot when
/// there is no count" rule.
class _MenuSignalBadge extends StatelessWidget {
  const _MenuSignalBadge({required this.name, required this.count});

  final String name;
  final int count;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Container(
      key: Key('session-detail-view-badge-$name'),
      constraints: const BoxConstraints(minWidth: 8, minHeight: 8),
      padding: count > 0
          ? const EdgeInsets.symmetric(horizontal: 4, vertical: 1)
          : EdgeInsets.zero,
      decoration: BoxDecoration(
        color: tokens.accent,
        borderRadius: BorderRadius.circular(999),
      ),
      child: count > 0
          ? Text(
              '$count',
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.accentInk,
                fontWeight: FontWeight.w700,
              ),
            )
          : null,
    );
  }
}
