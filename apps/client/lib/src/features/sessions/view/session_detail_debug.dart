part of 'session_detail_page.dart';

class _DebugTimeline extends StatelessWidget {
  const _DebugTimeline({required this.state});

  final SessionDetailState state;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Theme.of(context).colorScheme.surface,
      child: _DebugTimelineBody(state: state),
    );
  }
}

class _DebugTimelineBody extends StatelessWidget {
  const _DebugTimelineBody({required this.state});

  final SessionDetailState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ExpansionTile(
      key: const Key('debug-timeline-expander'),
      leading: Icon(
        Icons.segment_outlined,
        color: theme.colorScheme.onSurfaceVariant,
      ),
      title: Text(
        AppLocalizations.of(context).sessionDebugTimelineHeading,
        style: theme.textTheme.titleSmall,
      ),
      subtitle: Text(
        '${state.events.length} wire events',
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      childrenPadding: EdgeInsets.zero,
      children: [
        if (state.events.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Text(
              'No timeline events yet',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          )
        else
          ListView.separated(
            physics: const NeverScrollableScrollPhysics(),
            shrinkWrap: true,
            itemCount: state.events.length,
            separatorBuilder: (context, index) => const Divider(height: 1),
            itemBuilder: (context, index) {
              return ListTile(
                dense: true,
                leading: _EventIcon(event: state.events[index]),
                title: Text(state.eventSummaries[index]),
                subtitle: Text(state.events[index].runtimeType.toString()),
              );
            },
          ),
      ],
    );
  }
}

class _EventIcon extends StatelessWidget {
  const _EventIcon({required this.event});

  final WireEvent event;

  @override
  Widget build(BuildContext context) {
    final icon = switch (event) {
      HelloWireEvent() => Icons.handshake_outlined,
      SessionWireEvent() => Icons.info_outline,
      HistoryWireEvent() => Icons.history,
      HistoryPageWireEvent() => Icons.history_toggle_off,
      MessageWireEvent() => Icons.message_outlined,
      CommandsWireEvent() => Icons.keyboard_command_key,
      OptionsWireEvent() => Icons.tune,
      NoticeWireEvent() => Icons.notifications_outlined,
      EndedWireEvent() => Icons.stop_circle_outlined,
      ErrorWireEvent() => Icons.error_outline,
      DraftWireEvent() => Icons.drafts,
      AckWireEvent() => Icons.check_circle_outline,
      NackWireEvent() => Icons.cancel_outlined,
      AttachConflictWireEvent() => Icons.lock_person_outlined,
      UnknownWireEvent(:final raw) => switch (raw['sourceKind']) {
        'history' => Icons.history,
        'history-page' => Icons.history_toggle_off,
        'message' => Icons.message_outlined,
        _ => Icons.help_outline,
      },
    };
    return Icon(icon);
  }
}

class _ArtifactMetadataChip extends StatelessWidget {
  const _ArtifactMetadataChip({required this.label, super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    final viewportWidth = MediaQuery.sizeOf(context).width;
    final maxChipWidth = viewportWidth <= 96
        ? viewportWidth
        : viewportWidth - 64;

    return MetadataChip(label: label, maxWidth: maxChipWidth, bordered: true);
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final visibleMessage = switch (message) {
      sessionAttachmentUnsupportedErrorKey =>
        l10n.sessionAttachmentUnsupportedTooltip,
      sessionAttachmentSelectionErrorKey =>
        l10n.sessionAttachmentSelectionError,
      sessionAttachmentIntakeErrorKey => l10n.sessionAttachmentIntakeError,
      sessionAttachmentReplacementErrorKey =>
        l10n.sessionAttachmentReplacementError,
      sessionAttachmentLimitErrorKey => l10n.sessionAttachmentLimitError,
      sessionAttachmentStagingErrorKey => l10n.sessionAttachmentStagingError,
      sessionAttachmentDeliveryErrorKey => l10n.sessionAttachmentDeliveryError,
      _ => l10n.sessionDetailUpdateFailed,
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(
              visibleMessage,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
            if (visibleMessage == l10n.sessionDetailUpdateFailed)
              Material(
                type: MaterialType.transparency,
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: Text(l10n.technicalDetails),
                  children: [SelectableText(message)],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
