import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_harness_logo.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_pane.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_status_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show OverflowBoxFit;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Global counts deliberately fetch the complete roster. Changing the sidebar's
/// activity window must not silently change the meaning of "running now".
///
/// Refetched only when the sidebar roster actually changed — its revision or
/// any session's status — never on a poll that returned the same rows, and
/// never for the loading/refreshing flicker around one.
final AutoDisposeFutureProvider<ListSessionsResponse?>
workspaceOverviewRosterProvider =
    FutureProvider.autoDispose<ListSessionsResponse?>((ref) async {
      ref.watch(activeBrokerProfileProvider.select(RosterSource.of));
      final state = ref.watch(
        sessionListControllerProvider.select(
          (state) => (
            unavailable:
                state.cachedRoster != null ||
                state.status == SessionListStatus.error ||
                state.status == SessionListStatus.loading,
            revision: state.revision,
            statuses: Object.hashAll(
              state.sessions.map(
                (session) =>
                    Object.hash(session.tool, session.id, session.status),
              ),
            ),
          ),
        ),
      );
      if (state.unavailable) return null;
      final repository = await ref.watch(sessionListRepositoryProvider.future);
      return repository.fetchSessions();
    });

/// Unread completion cues use the durable inbox scoped to the exact broker.
final workspaceUnreadCompletionKeysProvider =
    NotifierProvider<WorkspaceUnreadCompletionKeys, Set<String>>(
      WorkspaceUnreadCompletionKeys.new,
    );

/// The source-qualified `tool/id` keys with an unread completion.
///
/// Compared by value: every inbox refresh recomputes the set, and an unchanged
/// set must not rebuild the workspace, its tabs and the roster.
class WorkspaceUnreadCompletionKeys extends Notifier<Set<String>> {
  @override
  Set<String> build() {
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    final inbox = ref.watch(attentionInboxProvider);
    if (source == null || inbox.isLoading || inbox.hasError) return const {};
    return {
      for (final entry in inbox.valueOrNull?.all ?? <AttentionInboxEntry>[])
        if (RosterSource.ofProfile(entry.profile) == source &&
            entry.isUnread &&
            (entry.event.isRunFinished || entry.event.isGoalFinished) &&
            entry.event.dismissedAt == null &&
            entry.event.agent != null &&
            entry.event.sessionId != null)
          '${entry.event.agent}/${entry.event.sessionId}',
    };
  }

  @override
  bool updateShouldNotify(Set<String> previous, Set<String> next) =>
      !setEquals(previous, next);
}

// No union filter: one that meant waiting plus unread here, and waiting,
// unread and failures on Notifications, read as a fourth category.
enum _OverviewFilter { working, input, completions }

/// Workspace landing page. Unknown data is never represented by a zero.
class WorkspaceOverview extends ConsumerStatefulWidget {
  /// Creates the source-scoped landing page.
  const WorkspaceOverview({required this.onOpen, super.key});

  /// Opens a live session or a cached completion identity.
  final ValueChanged<SessionRef> onOpen;

  @override
  ConsumerState<WorkspaceOverview> createState() => _WorkspaceOverviewState();
}

class _WorkspaceOverviewState extends ConsumerState<WorkspaceOverview> {
  _OverviewFilter _filter = _OverviewFilter.input;

  /// The broker the last settled roster described. A refetch keeps showing
  /// that roster instead of blanking every count to unknown, but only while
  /// the broker is still the same one.
  RosterSource? _settledSource;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final profile = ref.watch(activeBrokerProfileProvider);
    final roster = ref.watch(workspaceOverviewRosterProvider);
    final source = RosterSource.of(profile);
    if (!roster.isLoading && roster.hasValue) _settledSource = source;
    final response =
        roster.hasError || (roster.isLoading && _settledSource != source)
        ? null
        : roster.valueOrNull;
    final sessions = response == null
        ? null
        : ref.watch(sessionStatusRegistryProvider).apply(response.sessions);
    final inbox = ref.watch(attentionInboxProvider);
    final completions = inbox.isLoading || inbox.hasError
        ? null
        : inbox.valueOrNull?.all
              .where(
                (entry) =>
                    RosterSource.ofProfile(entry.profile) ==
                        RosterSource.of(profile) &&
                    entry.isUnread &&
                    (entry.event.isRunFinished || entry.event.isGoalFinished) &&
                    entry.event.dismissedAt == null,
              )
              .toList();
    final running = sessions
        ?.where((session) => session.status == SessionStatus.working)
        .length;
    final waiting = sessions
        ?.where((session) => session.status == SessionStatus.needsInput)
        .length;
    final rows =
        sessions
            ?.where(
              (session) => switch (_filter) {
                _OverviewFilter.working =>
                  session.status == SessionStatus.working,
                _OverviewFilter.input =>
                  session.status == SessionStatus.needsInput,
                _OverviewFilter.completions => false,
              },
            )
            .toList() ??
        <SessionInfo>[];
    final showCompletions = _filter == _OverviewFilter.completions;
    final narrow = MediaQuery.sizeOf(context).width < 600;
    final theme = Theme.of(context);
    final machine = _QuietLink(
      key: const Key('workspace-overview-machine'),
      glyph: StrokeGlyph.monitor,
      label: profile?.displayName ?? l10n.workspaceNoMachine,
      onTap: () => context.go(brokerDevicesSettingsRoute),
    );
    final filterLabels = {
      _OverviewFilter.working: l10n.workspaceRunning,
      _OverviewFilter.input: l10n.workspaceWaiting,
      _OverviewFilter.completions: l10n.workspaceUnreadCompletions,
    };
    final queueCount =
        rows.length + (showCompletions ? completions?.length ?? 0 : 0);
    return SingleChildScrollView(
      key: const Key('workspace-overview'),
      padding: EdgeInsets.fromLTRB(
        narrow ? 16 : 48,
        narrow ? 24 : 44,
        narrow ? 16 : 48,
        24,
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1020),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          MaterialLocalizations.of(context)
                              .formatFullDate(ref.watch(usageNowProvider)())
                              .toUpperCase(),
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: tokens.textTertiary,
                            letterSpacing: 0.84,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          l10n.workspaceOverviewHeading,
                          style: theme.textTheme.displaySmall?.copyWith(
                            fontSize: narrow ? 30 : 36,
                            fontWeight: FontWeight.w400,
                            letterSpacing: -1.1,
                            height: 1.2,
                            color: tokens.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          l10n.workspaceOverviewIntro,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: tokens.textSecondary,
                          ),
                        ),
                        if (narrow) ...[
                          const SizedBox(height: 8),
                          machine,
                        ],
                      ],
                    ),
                  ),
                  if (!narrow) ...[
                    const SizedBox(width: 16),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 240),
                      child: machine,
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 40),
              // The counts' hover fill reaches past the column so their text
              // stays aligned with the heading above.
              LayoutBuilder(
                builder: (context, constraints) => OverflowBox(
                  fit: OverflowBoxFit.deferToChild,
                  minWidth: constraints.maxWidth + 24,
                  maxWidth: constraints.maxWidth + 24,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: _Count(
                          key: const Key('workspace-overview-count-running'),
                          label: l10n.workspaceRunning,
                          detail: l10n.workspaceRunningDetail,
                          value: running,
                          color: tokens.statusWorking,
                          selected: _filter == _OverviewFilter.working,
                          onTap: () =>
                              setState(() => _filter = _OverviewFilter.working),
                        ),
                      ),
                      SizedBox(width: narrow ? 4 : 16),
                      Expanded(
                        child: _Count(
                          key: const Key('workspace-overview-count-waiting'),
                          label: l10n.workspaceWaiting,
                          detail: l10n.workspaceWaitingDetail,
                          value: waiting,
                          color: tokens.statusNeedsInput,
                          selected: _filter == _OverviewFilter.input,
                          onTap: () =>
                              setState(() => _filter = _OverviewFilter.input),
                        ),
                      ),
                      SizedBox(width: narrow ? 4 : 16),
                      Expanded(
                        child: _Count(
                          key: const Key(
                            'workspace-overview-count-completions',
                          ),
                          label: l10n.workspaceUnreadCompletions,
                          detail: l10n.workspaceCompletionsDetail,
                          value: completions?.length,
                          color: tokens.statusError,
                          selected: _filter == _OverviewFilter.completions,
                          onTap: () => setState(
                            () => _filter = _OverviewFilter.completions,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (response == null)
                _Note(
                  text: roster.isLoading
                      ? l10n.workspaceLoading
                      : l10n.workspaceStateUnavailable,
                ),
              if (response == null && !roster.isLoading)
                Align(
                  alignment: Alignment.centerLeft,
                  child: _QuietLink(
                    label: l10n.retry,
                    onTap: () {
                      ref
                        ..invalidate(workspaceOverviewRosterProvider)
                        ..invalidate(
                          usageReportProvider((
                            period: UsagePeriod.today,
                            offset: 0,
                          )),
                        )
                        ..read(sessionListControllerProvider.notifier).load();
                    },
                  ),
                ),
              if (response?.complete == false)
                _Note(text: l10n.workspacePartialRoster),
              const SizedBox(height: 32),
              const _TodayUsage(),
              const SizedBox(height: 36),
              Row(
                children: [
                  Expanded(
                    child: Row(
                      children: [
                        Flexible(
                          child: _Heading(
                            filterLabels[_filter]!,
                          ),
                        ),
                        if (sessions != null) ...[
                          const SizedBox(width: 8),
                          Text(
                            queueCount.toString(),
                            key: const Key('workspace-overview-queue-count'),
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: tokens.textTertiary,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  _QueueFilter(
                    value: _filter,
                    labels: filterLabels,
                    onChanged: (value) => setState(() => _filter = value),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              for (final session in rows)
                _QueueRow(
                  tool: session.tool,
                  title:
                      knownSessionTitle([
                        session.title,
                      ], sessionId: session.id) ??
                      l10n.sessionDetailTitleUntitled,
                  context: [
                    if (session.cwd case final cwd? when cwd.isNotEmpty)
                      _lastPathSegment(cwd),
                    sessionToolLabel(l10n, session.tool),
                  ].join(' · '),
                  trailing: sessionStatusPill(context, session.status),
                  onTap: () => widget.onOpen(SessionRef.fromSession(session)),
                ),
              if (showCompletions)
                for (final entry in completions ?? <AttentionInboxEntry>[])
                  _QueueRow(
                    tool: entry.event.agent ?? '',
                    title: entry.event.sessionTitle ?? entry.event.title,
                    context: entry.event.summary ?? '',
                    trailing: StatusDot(color: tokens.statusError, size: 8),
                    onTap:
                        entry.event.agent == null ||
                            entry.event.sessionId == null
                        ? () => context.go(attentionRoute)
                        : () => widget.onOpen(
                            SessionRef.cachedIdentity(
                              tool: entry.event.agent!,
                              id: entry.event.sessionId!,
                              title:
                                  entry.event.sessionTitle ?? entry.event.title,
                            ),
                          ),
                  ),
              if (sessions != null &&
                  rows.isEmpty &&
                  (!showCompletions ||
                      (completions != null && completions.isEmpty)))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 36),
                  child: Text(
                    l10n.workspaceNothingHere,
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: tokens.textSecondary,
                    ),
                  ),
                ),
              const SizedBox(height: 32),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      l10n.workspaceCompletionReadNote,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textTertiary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  _QuietLink(
                    glyph: StrokeGlyph.bell,
                    label: l10n.notificationsTitle,
                    onTap: () => context.go(attentionRoute),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _lastPathSegment(String path) {
  final parts = path.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty);
  return parts.isEmpty ? path : parts.last;
}

/// A section title in the demo's heading weight: ink, not the accent tint.
class _Heading extends StatelessWidget {
  const _Heading(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: Theme.of(context).textTheme.titleMedium?.copyWith(
      fontSize: 17,
      fontWeight: FontWeight.w700,
      letterSpacing: -0.2,
      color: context.tokens.textPrimary,
    ),
  );
}

/// A borderless secondary action: muted text, optional line icon, a hover
/// fill. The overview's links are this, never an accent-coloured button.
class _QuietLink extends StatelessWidget {
  const _QuietLink({
    required this.label,
    required this.onTap,
    this.glyph,
    this.trailingGlyph,
    super.key,
  });

  final String label;
  final VoidCallback onTap;
  final StrokeGlyph? glyph;
  final StrokeGlyph? trailingGlyph;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final radius = BorderRadius.circular(tokens.radiusMd);
    final leading = glyph;
    final trailing = trailingGlyph;
    return Material(
      color: Colors.transparent,
      borderRadius: radius,
      child: InkWell(
        borderRadius: radius,
        hoverColor: tokens.surface2,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (leading != null) ...[
                StrokeIcon(leading, size: 14, color: tokens.textSecondary),
                const SizedBox(width: 8),
              ],
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: 4),
                StrokeIcon(trailing, size: 12, color: tokens.textTertiary),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The queue's filter: a quiet trigger naming the current choice, and a menu.
class _QueueFilter extends StatelessWidget {
  const _QueueFilter({
    required this.value,
    required this.labels,
    required this.onChanged,
  });

  final _OverviewFilter value;
  final Map<_OverviewFilter, String> labels;
  final ValueChanged<_OverviewFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return MenuAnchor(
      menuChildren: [
        for (final entry in labels.entries)
          MenuItemButton(
            key: Key('workspace-overview-filter-${entry.key.name}'),
            leadingIcon: SizedBox.square(
              dimension: 16,
              child: entry.key == value
                  ? Icon(Icons.check, size: 16, color: tokens.accent)
                  : null,
            ),
            onPressed: () => onChanged(entry.key),
            child: Text(entry.value),
          ),
      ],
      builder: (context, controller, child) => ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 200),
        child: _QuietLink(
          key: const Key('workspace-overview-filter'),
          label: labels[value]!,
          trailingGlyph: StrokeGlyph.chevronDown,
          onTap: () =>
              controller.isOpen ? controller.close() : controller.open(),
        ),
      ),
    );
  }
}

/// One queue row: harness mark, title over its context, state, and an arrow.
class _QueueRow extends StatelessWidget {
  const _QueueRow({
    required this.tool,
    required this.title,
    required this.context,
    required this.trailing,
    required this.onTap,
  });

  final String tool;
  final String title;
  final String context;
  final Widget trailing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final radius = BorderRadius.circular(tokens.radiusMd);
    final line = this.context;
    return Semantics(
      button: true,
      child: Material(
        color: Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          borderRadius: radius,
          hoverColor: tokens.surface2,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: tokens.surface2,
                    borderRadius: BorderRadius.circular(tokens.radiusMd),
                  ),
                  // The context line already names the agent.
                  child: ExcludeSemantics(
                    child: SessionHarnessLogo(tool: tool, size: 16),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: tokens.textPrimary,
                        ),
                      ),
                      if (line.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          line,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: tokens.textTertiary,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                trailing,
                const SizedBox(width: 16),
                StrokeIcon(
                  StrokeGlyph.arrowRight,
                  size: 16,
                  color: tokens.textTertiary,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Count extends StatelessWidget {
  const _Count({
    required this.label,
    required this.detail,
    required this.value,
    required this.color,
    required this.selected,
    required this.onTap,
    super.key,
  });
  final String label;
  final String detail;
  final int? value;
  final Color color;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final narrow = MediaQuery.sizeOf(context).width < 600;
    final radius = BorderRadius.circular(tokens.radiusLg);
    return Semantics(
      selected: selected,
      button: true,
      child: Material(
        color: selected ? tokens.surface2 : Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          hoverColor: tokens.surface2,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    StatusDot(color: color, size: 6),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontSize: 13,
                          color: tokens.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  value?.toString() ?? '—',
                  style: theme.textTheme.displayMedium?.copyWith(
                    fontSize: narrow ? 40 : 48,
                    fontWeight: FontWeight.w400,
                    letterSpacing: -2,
                    height: 1.35,
                    color: tokens.textPrimary,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                Text(
                  detail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: tokens.textTertiary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TodayUsage extends ConsumerWidget {
  const _TodayUsage();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).toLanguageTag();
    final reading = ref.watch(
      usageReportProvider((period: UsagePeriod.today, offset: 0)),
    );
    final report = reading.isLoading || reading.hasError
        ? null
        : reading.valueOrNull?.report;
    final available =
        report != null &&
        !report.needsTokdashUpgrade &&
        report.range.recognized &&
        !(report.coverage?.isEmpty ?? false);
    final active = available ? report.activeTime : null;
    final tokenValue = available
        ? formatCompactCount(report.totals.tokens, locale: locale)
        : '—';
    final runtimeValue = active?.activeMsSum == null
        ? '—'
        : formatUsageAgentTime(active!.activeMsSum!, locale: locale);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: _Heading(l10n.workspaceToday)),
            _QuietLink(
              key: const Key('workspace-overview-usage-details'),
              label: l10n.workspaceUsageDetails,
              trailingGlyph: StrokeGlyph.arrowRight,
              onTap: () => context.go('$usageReportRoute?period=today'),
            ),
          ],
        ),
        const SizedBox(height: 24),
        LayoutBuilder(
          builder: (context, constraints) {
            final metrics = [
              _Figure(
                label: l10n.workspaceEstimatedTime,
                value: runtimeValue,
                // The dash says unavailable; how an available figure is
                // estimated is the report's to explain, not this summary's.
                note: active == null ? l10n.workspaceRuntimeUnavailable : '',
              ),
              _Figure(
                label: l10n.usageTokensLabel,
                value: tokenValue,
                note: available
                    ? usageTokenBreakdownText(l10n, report.totals, locale) ??
                          l10n.workspaceTokenBreakdownUnavailable
                    : '',
              ),
            ];
            return constraints.maxWidth < 520
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      metrics[0],
                      const SizedBox(height: 24),
                      metrics[1],
                    ],
                  )
                : Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: metrics[0]),
                      const SizedBox(width: 48),
                      Expanded(child: metrics[1]),
                    ],
                  );
          },
        ),
        if (!available)
          _Note(
            text: reading.isLoading
                ? l10n.workspaceLoading
                : (report?.needsTokdashUpgrade ?? false)
                ? usageTokdashUpgradeText(l10n, report!.runtime)
                : l10n.usageUnavailable,
          ),
        if (available && report.isPartial)
          _Note(
            text: l10n.workspacePartialUsage(report.sourceErrors.join(', ')),
          ),
      ],
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value, required this.note});
  final String label;
  final String value;
  final String note;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label,
        style: Theme.of(
          context,
        ).textTheme.labelMedium?.copyWith(color: context.tokens.textSecondary),
      ),
      const SizedBox(height: 8),
      Text(
        value,
        style: Theme.of(context).textTheme.headlineMedium?.copyWith(
          fontSize: 32,
          fontWeight: FontWeight.w400,
          letterSpacing: -1,
          height: 1.25,
          color: context.tokens.textPrimary,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
      if (note.isNotEmpty) const SizedBox(height: 8),
      if (note.isNotEmpty)
        Text(
          note,
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: context.tokens.textTertiary),
        ),
    ],
  );
}

class _Note extends StatelessWidget {
  const _Note({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(
      text,
      style: Theme.of(
        context,
      ).textTheme.bodySmall?.copyWith(color: context.tokens.textTertiary),
    ),
  );
}
