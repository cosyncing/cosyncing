import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_event_copy.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/relative_time.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Durable, multi-broker Attention inbox.
///
/// See `docs/architecture/client-ui.md`.
class AttentionPage extends ConsumerStatefulWidget {
  /// Creates the Attention destination.
  const AttentionPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  @override
  ConsumerState<AttentionPage> createState() => _AttentionPageState();
}

class _AttentionPageState extends ConsumerState<AttentionPage> {
  bool _clearing = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final inbox = ref.watch(attentionInboxProvider);
    final loadedSections = inbox.valueOrNull;
    ref.watch(attentionInboxSeenRuntimeProvider);
    return Scaffold(
      appBar: AppBar(
        leading: widget.showSessionsBack
            ? IconButton(
                key: const Key('attention-back-to-sessions'),
                tooltip: l10n.attentionPageBackToSessions,
                onPressed: () => context.go(sessionsRoute),
                icon: const Icon(Icons.arrow_back),
              )
            : null,
        title: SelectionArea(child: Text(l10n.attentionPageTitle)),
        actions: [
          TextButton(
            key: const Key('attention-clear-all'),
            onPressed: !_clearing && (loadedSections?.all.isNotEmpty ?? false)
                ? () => _clearAll(loadedSections!)
                : null,
            child: Text(l10n.attentionPageClearAll),
          ),
          IconButton(
            key: const Key('attention-refresh'),
            tooltip: l10n.attentionPageRefresh,
            onPressed: () => ref.invalidate(attentionInboxProvider),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: inbox.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => _AttentionError(
          message: localizedFailureMessage(
            l10n,
            error,
            lead: l10n.attentionInboxLoadFailed,
          ),
          onRetry: () => ref.invalidate(attentionInboxProvider),
        ),
        data: (sections) => _AttentionInbox(sections: sections),
      ),
    );
  }

  Future<void> _clearAll(AttentionInboxSections snapshot) async {
    if (_clearing) return;
    setState(() => _clearing = true);
    try {
      final result = await ref
          .read(attentionInboxActionsProvider)
          .clearAll(snapshot);
      if (!mounted || !result.hasPendingSync) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context).attentionSavedLocallySyncPending,
          ),
        ),
      );
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context).attentionPageClearFailed),
        ),
      );
    } finally {
      if (mounted) setState(() => _clearing = false);
    }
  }
}

class _AttentionInbox extends StatelessWidget {
  const _AttentionInbox({required this.sections});

  final AttentionInboxSections sections;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    if (sections.all.isEmpty) {
      return const _EmptyAttentionInbox();
    }
    return RefreshIndicator(
      onRefresh: () async {
        final container = ProviderScope.containerOf(context);
        await (container..invalidate(attentionInboxProvider)).read(
          attentionInboxProvider.future,
        );
      },
      child: ListView(
        key: const Key('attention-inbox-list'),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          if (sections.actionRequired.isNotEmpty)
            _AttentionSection(
              title: l10n.attentionPageActionRequired,
              subtitle: l10n.attentionPageActionRequiredSubtitle,
              icon: Icons.priority_high_rounded,
              tone: _AttentionTone.action,
              entries: sections.actionRequired,
            ),
          if (sections.maintenance.isNotEmpty)
            _AttentionSection(
              title: l10n.attentionPageMaintenance,
              subtitle: l10n.attentionPageMaintenanceSubtitle,
              icon: Icons.build_circle_outlined,
              tone: _AttentionTone.maintenance,
              entries: sections.maintenance,
            ),
          if (sections.resolved.isNotEmpty)
            _AttentionSection(
              title: l10n.attentionPageRecent,
              subtitle: l10n.attentionPageRecentSubtitle,
              icon: Icons.history_rounded,
              tone: _AttentionTone.resolved,
              entries: sections.resolved,
            ),
        ],
      ),
    );
  }
}

enum _AttentionTone { action, maintenance, resolved }

class _AttentionSection extends StatelessWidget {
  const _AttentionSection({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.tone,
    required this.entries,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final _AttentionTone tone;
  final List<AttentionInboxEntry> entries;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final accent = switch (tone) {
      _AttentionTone.action => tokens.statusNeedsInput,
      _AttentionTone.maintenance => tokens.accent,
      _AttentionTone.resolved => tokens.statusIdle,
    };
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 8, 4, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Icon(icon, color: accent, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: SectionHeader(
                            title,
                            padding: EdgeInsets.zero,
                          ),
                        ),
                        MetadataChip(label: '${entries.length}'),
                      ],
                    ),
                    const SizedBox(height: 4),
                    SelectionArea(
                      child: Padding(
                        padding: const EdgeInsets.only(left: 28),
                        child: Text(
                          subtitle,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: tokens.textSecondary,
                              ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              for (final entry in entries)
                _AttentionEventCard(entry: entry, accent: accent),
            ],
          ),
        ),
      ),
    );
  }
}

class _AttentionEventCard extends ConsumerWidget {
  const _AttentionEventCard({required this.entry, required this.accent});

  final AttentionInboxEntry entry;
  final Color accent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final event = entry.event;
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        key: Key('attention-event-${event.id}'),
        color: entry.isUnread ? tokens.surface : tokens.surface2,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(tokens.radiusMd),
          side: BorderSide(color: tokens.separator),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(tokens.radiusMd),
          onTap: () => _open(context, ref),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: entry.isUnread
                      ? StatusDot(color: accent, size: 8)
                      : const SizedBox(width: 8, height: 8),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectionArea(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    _eventTitle(context, event),
                                    style: Theme.of(
                                      context,
                                    ).textTheme.titleSmall,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  _relativeTime(context, event.updatedAt),
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(color: tokens.textSecondary),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              entry.profile.displayName,
                              style: Theme.of(
                                context,
                              ).textTheme.labelMedium?.copyWith(color: accent),
                            ),
                            if (event.summary?.trim().isNotEmpty ?? false) ...[
                              const SizedBox(height: 8),
                              Text(
                                event.summary!.trim(),
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          FilledButton.tonalIcon(
                            onPressed: () => _open(context, ref),
                            icon: const Icon(Icons.open_in_new, size: 16),
                            label: Text(
                              AppLocalizations.of(
                                context,
                              ).foregroundAttentionOpen,
                            ),
                          ),
                          TextButton.icon(
                            onPressed: () => _dismiss(context, ref),
                            icon: const Icon(Icons.close, size: 16),
                            label: Text(
                              AppLocalizations.of(
                                context,
                              ).attentionPageDismiss,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(attentionInboxActionsProvider).acknowledge(entry);
    } on Object catch (_) {
      if (context.mounted) _showSyncWarning(context);
    }
    if (!context.mounted) return;
    await ref
        .read(brokerProfileManagerControllerProvider)
        .setActiveProfile(
          entry.profile.id,
          expectedProfile: entry.profile,
        );
    if (!context.mounted) return;
    final action = entry.event.action;
    if (action.isOpenSession &&
        action.tool != null &&
        action.sessionId != null) {
      context.go(
        sessionDetailLocation(
          tool: action.tool!,
          sessionId: action.sessionId!,
        ),
      );
      return;
    }
    if (action.isOpenRuntimeSettings ||
        action.isOpenQuotaSettings ||
        action.isOpenBrokerHealth) {
      context.go(settingsRoute);
    }
  }

  Future<void> _dismiss(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(attentionInboxActionsProvider).dismiss(entry);
    } on Object catch (_) {
      if (context.mounted) _showSyncWarning(context);
    }
  }

  void _showSyncWarning(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).attentionSavedLocallySyncPending,
        ),
      ),
    );
  }

  static String _fallbackTitle(BuildContext context, String kind) {
    final l10n = AppLocalizations.of(context);
    return switch (kind) {
      'scheduled-send' => l10n.attentionPageScheduledSent,
      'scheduled-send-failed' => l10n.attentionPageScheduledFailed,
      'unknown' || '' => l10n.attentionPageFallbackTitle,
      _ => l10n.attentionPageFallbackTitle,
    };
  }

  static String _eventTitle(BuildContext context, AttentionEvent event) {
    final sessionId = event.action.sessionId ?? event.sessionId;
    if (sessionId != null &&
        sessionId.trim().isNotEmpty &&
        (event.isPermissionRequired ||
            event.isQuestionRequired ||
            event.isGoalFinished ||
            event.isRunFinished ||
            event.isRunFailed ||
            event.isSyncDegraded)) {
      return attentionSessionEventTitle(event, AppLocalizations.of(context));
    }
    return event.title.trim().isEmpty
        ? _fallbackTitle(context, event.kind)
        : event.title.trim();
  }

  static String _relativeTime(BuildContext context, int epochMs) {
    final l10n = AppLocalizations.of(context);
    return relativeTimeLabel(
      context,
      l10n,
      epochMs,
      now: DateTime.now(),
    );
  }
}

class _EmptyAttentionInbox extends StatelessWidget {
  const _EmptyAttentionInbox();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.notifications_none_rounded,
                size: 52,
                color: tokens.accent,
              ),
              const SizedBox(height: 16),
              SelectionArea(
                child: Column(
                  children: [
                    Text(
                      l10n.attentionPageEmptyTitle,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      l10n.attentionPageEmptyBody,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AttentionError extends StatelessWidget {
  const _AttentionError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40),
            const SizedBox(height: 12),
            SelectableText(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton(onPressed: onRetry, child: Text(l10n.retry)),
          ],
        ),
      ),
    );
  }
}
