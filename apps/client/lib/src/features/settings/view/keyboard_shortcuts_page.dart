import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:flutter/material.dart';

/// Help screen documenting the app's real keyboard shortcuts.
///
/// Every row is rendered from `kAppShortcuts`
/// (`app/shortcuts/app_shortcuts.dart`), which is also what the binding sites
/// read. That is deliberate: a help page listing bindings the app does not
/// have is worse than no help page — it costs the reader the time to try each
/// one and teaches them the page cannot be trusted — and hand-maintaining the
/// rows made that a review obligation instead of a structural guarantee. Add a
/// shortcut to the registry and it appears here; give it no live chord on a
/// surface and its row disappears there.
///
/// The three surface-conditional cases the registry expresses:
///
/// * text size is hidden on web, where the browser owns the whole zoom triad;
/// * navigation is hidden on web, where Ctrl/Cmd+1..5 switch BROWSER tabs, so
///   the five rows advertised bindings that never fired;
/// * close and new session swap their plain Ctrl/Cmd form for the
///   Ctrl/Cmd+Alt form, which is the one that survives a browser tab.
///
/// Chord text stays an untranslated literal; only the descriptions are
/// localized.
///
/// See `docs/architecture/client-ui.md`.
class KeyboardShortcutsPage extends StatelessWidget {
  /// Creates the [KeyboardShortcutsPage].
  const KeyboardShortcutsPage({super.key});

  /// Group render order.
  static const List<AppShortcutGroup> _groupOrder = [
    AppShortcutGroup.navigation,
    AppShortcutGroup.textSize,
    AppShortcutGroup.sessionList,
    AppShortcutGroup.openSessions,
    AppShortcutGroup.sessionDetail,
    AppShortcutGroup.transfers,
  ];

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final webReserved = appShortcutsWebReserved;

    final groups = <Widget>[];
    var showSafariNote = false;
    for (final group in _groupOrder) {
      final entries = <_ShortcutEntry>[];
      for (final spec in kAppShortcuts) {
        if (spec.group != group) continue;
        final chord = spec.chordFor(webReserved: webReserved);
        if (chord == null) continue;
        if (spec.unavailableInSafari) showSafariNote = true;
        entries.add(
          _ShortcutEntry(
            label: chord,
            description: _shortcutDescription(l10n, spec.id),
          ),
        );
      }
      if (entries.isEmpty) continue;
      if (groups.isNotEmpty) groups.add(const SizedBox(height: 12));
      groups.add(
        _ShortcutGroup(title: _groupTitle(l10n, group), entries: entries),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(l10n.keyboardShortcutsTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SelectableText(
              l10n.keyboardShortcutsIntro,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            ...groups,
            // Safari claims Cmd+Opt+W for Close Other Tabs. The row stays,
            // because the chord works in every other browser and on native
            // desktop; the gap is documented instead of hidden.
            if (showSafariNote) ...[
              const SizedBox(height: 12),
              SelectableText(
                l10n.shortcutSafariGap,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Localized heading for a shortcut group.
String _groupTitle(AppLocalizations l10n, AppShortcutGroup group) =>
    switch (group) {
      AppShortcutGroup.navigation => l10n.shortcutGroupNavigation,
      AppShortcutGroup.textSize => l10n.shortcutGroupTextSize,
      AppShortcutGroup.sessionList => l10n.shortcutGroupSessions,
      AppShortcutGroup.openSessions => l10n.shortcutGroupOpenSessions,
      AppShortcutGroup.sessionDetail => l10n.shortcutGroupSessionDetail,
      AppShortcutGroup.transfers => l10n.shortcutGroupTransfers,
    };

/// Localized description for one shortcut.
///
/// The navigation arm is kept in destination order 1..5; the copy contract
/// test (`test/src/s2_copy_contract_test.dart`) asserts that this file and the
/// router's `_appRouteNavItems` name the same five destinations in the same
/// sequence, so a remap breaks a test by design.
String _shortcutDescription(AppLocalizations l10n, AppShortcutId id) =>
    switch (id) {
      AppShortcutId.goToSessions => l10n.shortcutGoToSessions,
      AppShortcutId.goToNotifications => l10n.shortcutGoToAttention,
      AppShortcutId.goToConnection => l10n.shortcutGoToConnection,
      AppShortcutId.goToSettings => l10n.shortcutGoToSettings,
      AppShortcutId.goToTransfers => l10n.shortcutGoToTransfers,
      AppShortcutId.increaseTextSize => l10n.shortcutIncreaseTextSize,
      AppShortcutId.decreaseTextSize => l10n.shortcutDecreaseTextSize,
      AppShortcutId.resetTextSize => l10n.shortcutResetTextSize,
      AppShortcutId.wheelTextSize => l10n.shortcutWheelTextSize,
      AppShortcutId.refreshSessions ||
      AppShortcutId.refreshSessionsChord => l10n.shortcutRefreshSessions,
      AppShortcutId.focusRosterSearch => l10n.shortcutFocusRosterSearch,
      AppShortcutId.jumpToSession => l10n.shortcutJumpToSession,
      AppShortcutId.jumpToLastSession => l10n.shortcutJumpToLastSession,
      AppShortcutId.nextSession => l10n.shortcutNextSession,
      AppShortcutId.previousSession => l10n.shortcutPreviousSession,
      AppShortcutId.closeSession => l10n.shortcutCloseSession,
      AppShortcutId.newSession => l10n.shortcutNewSession,
      AppShortcutId.focusComposer => l10n.shortcutFocusComposer,
      AppShortcutId.sendPrompt => l10n.shortcutSendPrompt,
      AppShortcutId.selectAllTransfers => l10n.shortcutSelectAllTransfers,
      AppShortcutId.invertTransferSelection =>
        l10n.shortcutInvertTransferSelection,
      AppShortcutId.clearTransferSearch => l10n.shortcutClearTransferSearch,
      AppShortcutId.cancelTransfer => l10n.shortcutCancelTransfer,
    };

class _ShortcutGroup extends StatelessWidget {
  const _ShortcutGroup({required this.title, required this.entries});

  final String title;
  final List<_ShortcutEntry> entries;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: SelectionArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              for (final entry in entries) ...[
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: entry,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ShortcutEntry extends StatelessWidget {
  const _ShortcutEntry({required this.label, required this.description});

  final String label;
  final String description;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _ShortcutKeyPill(label: label),
        const SizedBox(width: 12),
        Expanded(child: Text(description, style: theme.textTheme.bodyMedium)),
      ],
    );
  }
}

class _ShortcutKeyPill extends StatelessWidget {
  const _ShortcutKeyPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: theme.colorScheme.outline),
        color: theme.colorScheme.surfaceContainerHighest,
      ),
      child: Text(
        label,
        style: theme.textTheme.labelMedium?.copyWith(
          fontFamily: 'monospace',
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
