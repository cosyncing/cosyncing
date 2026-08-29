import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/cached_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_visibility_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Roster rendered from the bounded local identity snapshot (N3).
///
/// This is the cached side of the freshness boundary and it is a DIFFERENT
/// renderer from `SessionListPane` on purpose. It cannot draw an activity pill,
/// a status dot, a project status count, a ready-to-review marker or any
/// control affordance, because it holds none of the data those are made of.
/// Reusing the authoritative row renderer would have required inventing a
/// [SessionStatus], and an invented status is indistinguishable from a real one
/// on screen.
///
/// Every row is explicitly labelled last-known, the header states why, and the
/// list is replaced wholesale the moment an authoritative response lands.
class CachedRosterPane extends ConsumerWidget {
  /// Creates a cached roster pane.
  const CachedRosterPane({
    required this.presentation,
    required this.onOpen,
    this.visibilityPreferences,
    this.onRetry,
    super.key,
  });

  /// Cached rows plus why they are on screen.
  final CachedRosterPresentation presentation;

  /// Opens one cached row by its exact identity.
  final ValueChanged<SessionRosterIdentity> onOpen;

  /// Optional deterministic preference source for embedded/test surfaces.
  final SessionVisibilityPreferences? visibilityPreferences;

  /// Retries the failed authoritative load.
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final preferences =
        visibilityPreferences ??
        ref.watch(sessionVisibilityControllerProvider).valueOrNull ??
        const SessionVisibilityPreferences();
    final projection = CachedRosterProjection.build(
      rows: presentation.snapshot.rows,
      preferences: preferences,
      ungroupedLabel: l10n.sessionRosterOtherSessions,
    );

    return Column(
      key: const Key('cached-roster-pane'),
      children: [
        _CachedRosterBanner(
          reason: presentation.reason,
          onRetry: onRetry,
        ),
        Expanded(
          // No selection region, matching the authoritative pane: this is a
          // navigation roster, and on web a `SelectionArea` carries a platform
          // view whose placeholder can throw when a scrolling viewport
          // collects it (flutter/flutter#122680, unfixed in our pinned 3.44.3).
          child: ListView(
            key: const Key('cached-roster-list'),
            padding: const EdgeInsets.symmetric(vertical: 4),
            children: [
              for (final group in projection.groups)
                _CachedProjectGroup(group: group, onOpen: onOpen),
              if (presentation.snapshot.isPartial)
                _CachedRosterPartialNote(
                  omitted: presentation.snapshot.omittedRowCount,
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// States plainly that nothing here is current, and offers Retry on failure.
class _CachedRosterBanner extends StatelessWidget {
  const _CachedRosterBanner({required this.reason, required this.onRetry});

  final CachedRosterReason reason;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final message = switch (reason) {
      CachedRosterReason.hydrating => l10n.sessionRosterCachedReconnecting,
      CachedRosterReason.unreachable => l10n.sessionRosterCachedUnreachable,
    };
    final showRetry =
        reason == CachedRosterReason.unreachable && onRetry != null;
    return Material(
      key: const Key('cached-roster-banner'),
      color: tokens.surface2,
      child: InkWell(
        onTap: showRetry ? () => onRetry!() : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: [
              Icon(
                reason == CachedRosterReason.hydrating
                    ? Icons.sync
                    : Icons.sync_problem,
                size: 16,
                color: tokens.textSecondary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
              ),
              if (showRetry)
                Text(
                  l10n.retry,
                  key: const Key('cached-roster-retry'),
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: tokens.accent,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Honest note that the bounds dropped rows, so the list is not the roster.
class _CachedRosterPartialNote extends StatelessWidget {
  const _CachedRosterPartialNote({required this.omitted});

  final int omitted;

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const Key('cached-roster-partial'),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
      child: Text(
        AppLocalizations.of(context).sessionRosterCachedPartial(omitted),
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: context.tokens.textTertiary,
        ),
      ),
    );
  }
}

/// A cached project group.
///
/// Collapsed by default, exactly like R1b's authoritative groups, so the roster
/// does not visibly restructure when real data replaces this. The header shows
/// the row total and nothing else: status counts and the ready dot are
/// activity, which the cache does not have.
class _CachedProjectGroup extends StatefulWidget {
  const _CachedProjectGroup({required this.group, required this.onOpen});

  final CachedRosterGroup group;
  final ValueChanged<SessionRosterIdentity> onOpen;

  @override
  State<_CachedProjectGroup> createState() => _CachedProjectGroupState();
}

class _CachedProjectGroupState extends State<_CachedProjectGroup> {
  bool _collapsed = true;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final group = widget.group;
    return Column(
      key: ValueKey('cached-project-${group.key}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Material(
          color: tokens.surface2,
          child: Semantics(
            expanded: !_collapsed,
            child: InkWell(
              key: ValueKey('cached-project-header-${group.key}'),
              onTap: () => setState(() => _collapsed = !_collapsed),
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Row(
                  children: [
                    Icon(
                      _collapsed ? Icons.chevron_right : Icons.expand_more,
                      key: ValueKey('cached-project-collapse-${group.key}'),
                      size: 20,
                      color: tokens.textSecondary,
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: group.cwd == null
                          ? Text(
                              group.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.labelLarge?.copyWith(
                                color: tokens.textPrimary,
                                fontWeight: FontWeight.w700,
                              ),
                            )
                          // No copy affordance, matching the authoritative
                          // header: the path is non-selectable roster
                          // metadata, not a command, and the button put an
                          // interactive island inside an expand-only row.
                          : Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  group.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.labelLarge?.copyWith(
                                    color: tokens.textPrimary,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                Text(
                                  group.cwd!,
                                  key: ValueKey(
                                    'cached-project-cwd-${group.key}',
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: tokens.textSecondary,
                                    fontFamily: 'monospace',
                                  ),
                                ),
                              ],
                            ),
                    ),
                    Text(
                      '${group.rootCount}',
                      key: ValueKey('cached-project-total-${group.key}'),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (!_collapsed)
          for (var index = 0; index < group.rows.length; index++) ...[
            if (index > 0)
              Divider(height: 1, thickness: 1, color: tokens.separator),
            _CachedSessionRow(
              key: Key('cached-session-row-${group.rows[index].key}'),
              row: group.rows[index],
              onTap: () => widget.onOpen(group.rows[index].identity),
            ),
          ],
        const SizedBox(height: 8),
      ],
    );
  }
}

/// Child rows step in by this much per depth, matching the authoritative pane.
const double _kCachedRowIndentStep = 12;

/// Deepest indent a nested cached row may draw, matching R1c's cap.
const int _kCachedRowMaxIndentDepth = 3;

/// One cached identity row.
///
/// The leading dot is the TOOL identity colour, which is identity, not status;
/// it carries no needs-input ring and there is no status pill beside it. The
/// trailing text is an explicit "last known" label so the row cannot read as a
/// live one.
class _CachedSessionRow extends StatelessWidget {
  const _CachedSessionRow({required this.row, required this.onTap, super.key});

  final CachedRosterRow row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final identity = row.identity;
    final title = identity.title.isNotEmpty
        ? identity.title
        : identity.sessionId;
    final indentDepth = row.depth < _kCachedRowMaxIndentDepth
        ? row.depth
        : _kCachedRowMaxIndentDepth;
    final parent = row.parent;
    final lineageLabel = row.depth > 0 && parent != null
        ? l10n.sessionRosterChildOf(
            parent.title.isEmpty ? parent.sessionId : parent.title,
          )
        : null;

    final content = Material(
      type: MaterialType.transparency,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            12 + _kCachedRowIndentStep * indentDepth,
            8,
            12,
            8,
          ),
          child: Row(
            children: [
              // Tool identity only. No `ringColor`: the ring means needs-input,
              // and the cache has no idea whether it does.
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: tokens.toolColor(identity.tool),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                // Plain text in a navigation row: no selection island, so the
                // row's InkWell owns the tap outright.
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: tokens.textPrimary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    _subtitle(context, identity),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Text(
                l10n.sessionRosterCachedRowLabel,
                key: ValueKey('cached-session-label-${row.key}'),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: tokens.textTertiary,
                ),
              ),
            ],
          ),
        ),
      ),
    );

    return Semantics(
      key: lineageLabel == null
          ? null
          : ValueKey('cached-session-lineage-${row.key}'),
      label: lineageLabel,
      button: true,
      child: content,
    );
  }

  Widget _subtitle(BuildContext context, SessionRosterIdentity identity) {
    final l10n = AppLocalizations.of(context);
    final parts = <String>[_toolLabel(l10n, identity.tool)];
    if (identity.modelLabel case final model?) parts.add(model);
    if (identity.origin case final origin?) {
      final label = switch (origin) {
        SessionOrigin.subagent => l10n.sessionRosterOriginSubagent,
        SessionOrigin.exec => l10n.sessionRosterOriginAutomation,
        SessionOrigin.vscode => l10n.sessionRosterOriginVscode,
        SessionOrigin.unknown => null,
      };
      if (label != null) parts.add(label);
    }
    final child = Text(
      parts.join(' · '),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        color: context.tokens.textSecondary,
      ),
    );
    final modelId = identity.modelId;
    if (modelId == null) return child;
    return Tooltip(
      message: l10n.sessionRosterModelTooltip(modelId),
      child: child,
    );
  }
}

String _toolLabel(AppLocalizations l10n, String tool) =>
    switch (tool.toLowerCase()) {
      'claude' => l10n.sessionRosterAgentClaude,
      'codex' => l10n.sessionRosterAgentCodex,
      'opencode' => l10n.sessionRosterAgentOpenCode,
      'pi' => l10n.sessionRosterAgentPi,
      'omp' => l10n.sessionRosterAgentOmp,
      // The backend id and the product name differ here, so the fallback below
      // would render the command (`agy`) where every other row renders a name.
      'agy' => l10n.sessionRosterAgentAntigravity,
      _ => tool,
    };
