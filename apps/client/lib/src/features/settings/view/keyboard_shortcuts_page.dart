import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

/// Help screen documenting the app's real keyboard shortcuts.
///
/// Every row here is checked against the code that binds it. A help page that
/// lists bindings the app does not have is worse than no help page: it costs
/// the reader the time to try each one and teaches them the page cannot be
/// trusted. The sources of truth are:
///
/// * navigation and text size — `_appRouteNavItems`, `_textScaleUpActivators`,
///   `_textScaleDownActivators` and `_handlePointerSignal` in
///   `app/router/router.dart`;
/// * session list refresh — `sessions_page.dart`;
/// * composer focus and prompt send — `session_detail_page.dart` and
///   `session_detail_composer.dart`;
/// * transfer selection and cancel — `transfer_manager_page.dart` and
///   `session_detail_transfers_artifacts.dart`.
///
/// Most global bindings accept Control and Meta. Prompt send is intentionally
/// platform-specific: Control on web/Windows/Linux and Meta on macOS.
///
/// The text-size group is hidden on web: there the browser owns zoom
/// (Ctrl/Cmd +/- and Ctrl+wheel) and the app binds nothing, so the group would
/// list shortcuts that do not exist. It stays on native desktop, where
/// `UiTextScale` is the only zoom.
///
/// See `docs/architecture/client-ui.md`.
class KeyboardShortcutsPage extends StatelessWidget {
  /// Creates the [KeyboardShortcutsPage].
  const KeyboardShortcutsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

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
            _ShortcutGroup(
              title: l10n.shortcutGroupNavigation,
              entries: [
                _ShortcutEntry(
                  label: 'Ctrl+1 / ⌘1',
                  description: l10n.shortcutGoToSessions,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+2 / ⌘2',
                  description: l10n.shortcutGoToAttention,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+3 / ⌘3',
                  description: l10n.shortcutGoToConnection,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+4 / ⌘4',
                  description: l10n.shortcutGoToSettings,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+5 / ⌘5',
                  description: l10n.shortcutGoToTransfers,
                ),
              ],
            ),
            // On web the browser owns zoom (Ctrl/Cmd +/- and Ctrl+wheel), so
            // the app does not bind these; see `_browserOwnsZoom` in
            // `app/router/router.dart`. The shortcuts still apply on native
            // desktop, so the group is shown there and hidden only on web.
            if (!kIsWeb) const SizedBox(height: 12),
            if (!kIsWeb)
              _ShortcutGroup(
                title: l10n.shortcutGroupTextSize,
                entries: [
                  _ShortcutEntry(
                    label: 'Ctrl+= / ⌘=',
                    description: l10n.shortcutIncreaseTextSize,
                  ),
                  _ShortcutEntry(
                    label: 'Ctrl+− / ⌘−',
                    description: l10n.shortcutDecreaseTextSize,
                  ),
                  _ShortcutEntry(
                    label: 'Ctrl+scroll',
                    description: l10n.shortcutWheelTextSize,
                  ),
                ],
              ),
            const SizedBox(height: 12),
            _ShortcutGroup(
              title: l10n.shortcutGroupSessions,
              entries: [
                _ShortcutEntry(
                  label: 'F5',
                  description: l10n.shortcutRefreshSessions,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+R / ⌘R',
                  description: l10n.shortcutRefreshSessions,
                ),
              ],
            ),
            const SizedBox(height: 12),
            _ShortcutGroup(
              title: l10n.shortcutGroupSessionDetail,
              entries: [
                _ShortcutEntry(
                  label: 'Ctrl+K / ⌘K',
                  description: l10n.shortcutFocusComposer,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+Enter / ⌘Enter',
                  description: l10n.shortcutSendPrompt,
                ),
              ],
            ),
            const SizedBox(height: 12),
            _ShortcutGroup(
              title: l10n.shortcutGroupTransfers,
              entries: [
                _ShortcutEntry(
                  label: 'Ctrl+A / ⌘A',
                  description: l10n.shortcutSelectAllTransfers,
                ),
                _ShortcutEntry(
                  label: 'Ctrl+I / ⌘I',
                  description: l10n.shortcutInvertTransferSelection,
                ),
                _ShortcutEntry(
                  label: 'Esc',
                  description: l10n.shortcutClearTransferSearch,
                ),
                _ShortcutEntry(
                  label: 'Esc / Del',
                  description: l10n.shortcutCancelTransfer,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

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
