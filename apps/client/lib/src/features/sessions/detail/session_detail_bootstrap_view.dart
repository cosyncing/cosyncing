part of 'session_detail_page.dart';

bool _bootstrapBlocksChat(SessionDetailState state) {
  final bootstrap = state.bootstrapState;
  final manuallyDetached =
      bootstrap.readiness == SessionDetailBootstrapReadiness.idle &&
      state.connectionStatus == SessionDetailConnectionStatus.closed;
  return !manuallyDetached &&
      bootstrap.readiness != SessionDetailBootstrapReadiness.ready &&
      !bootstrap.keepShowingMessages;
}

bool _bootstrapHasSettledTranscript(SessionDetailState state) {
  final bootstrap = state.bootstrapState;
  return bootstrap.readiness == SessionDetailBootstrapReadiness.ready ||
      (bootstrap.readiness == SessionDetailBootstrapReadiness.idle &&
          state.connectionStatus == SessionDetailConnectionStatus.closed &&
          (state.transcriptWindow.initialized ||
              state.events.any((event) => event is HistoryWireEvent)));
}

bool _bootstrapShowsInlineStatus(SessionDetailBootstrapState bootstrap) {
  return switch (bootstrap.readiness) {
    SessionDetailBootstrapReadiness.resolvingProfile ||
    SessionDetailBootstrapReadiness.hydratingCachedTranscript ||
    SessionDetailBootstrapReadiness.attachingSocket ||
    SessionDetailBootstrapReadiness.awaitingInitialHistory ||
    SessionDetailBootstrapReadiness.failed ||
    SessionDetailBootstrapReadiness.historyTimeout => true,
    SessionDetailBootstrapReadiness.idle ||
    SessionDetailBootstrapReadiness.ready => false,
  };
}

class _SessionDetailBootstrapSurface extends StatelessWidget {
  const _SessionDetailBootstrapSurface({
    required this.bootstrap,
    required this.retrying,
    required this.onRetry,
  });

  final SessionDetailBootstrapState bootstrap;
  final bool retrying;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final failed = bootstrap.hasFailed;
    final timeout =
        bootstrap.readiness == SessionDetailBootstrapReadiness.historyTimeout;
    final title = timeout
        ? l10n.sessionDetailBootstrapTimeoutTitle
        : failed
        ? l10n.sessionDetailBootstrapFailureTitle
        : l10n.sessionDetailBootstrapLoadingTitle;
    final body = _bootstrapStatusMessage(l10n, bootstrap);

    return SingleChildScrollView(
      child: _ReadableColumn(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 32),
          child: Column(
            key: const Key('session-detail-bootstrap-blocking'),
            mainAxisSize: MainAxisSize.min,
            children: [
              if (failed)
                Icon(
                  Icons.error_outline,
                  size: 32,
                  color: tokens.statusError,
                )
              else
                SizedBox.square(
                  dimension: 32,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: tokens.accent,
                  ),
                ),
              const SizedBox(height: 16),
              SelectionArea(
                child: Column(
                  children: [
                    Text(
                      title,
                      key: const Key('session-detail-bootstrap-title'),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: tokens.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      body,
                      key: const Key('session-detail-bootstrap-message'),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              if (failed) ...[
                const SizedBox(height: 24),
                FilledButton(
                  key: const Key('session-detail-bootstrap-retry'),
                  onPressed: retrying ? null : () => unawaited(onRetry()),
                  child: Text(
                    retrying ? l10n.sessionDetailBootstrapRetrying : l10n.retry,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _SessionDetailBootstrapInlineStatus extends StatelessWidget {
  const _SessionDetailBootstrapInlineStatus({
    required this.bootstrap,
    required this.retrying,
    required this.onRetry,
  });

  final SessionDetailBootstrapState bootstrap;
  final bool retrying;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final failed = bootstrap.hasFailed;

    return _ReadableColumn(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          key: const Key('session-detail-bootstrap-inline'),
          children: [
            if (failed)
              Icon(
                Icons.error_outline,
                size: 16,
                color: tokens.statusError,
              )
            else
              SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: tokens.statusWorking,
                ),
              ),
            const SizedBox(width: 8),
            Expanded(
              child: SelectionArea(
                child: Text(
                  failed
                      ? _bootstrapStatusMessage(l10n, bootstrap)
                      : l10n.sessionDetailBootstrapCachedWaiting,
                  key: const Key('session-detail-bootstrap-inline-message'),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: failed ? tokens.statusError : tokens.textSecondary,
                  ),
                ),
              ),
            ),
            if (failed) ...[
              const SizedBox(width: 8),
              TextButton(
                key: const Key('session-detail-bootstrap-inline-retry'),
                onPressed: retrying ? null : () => unawaited(onRetry()),
                child: Text(
                  retrying ? l10n.sessionDetailBootstrapRetrying : l10n.retry,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _bootstrapStatusMessage(
  AppLocalizations l10n,
  SessionDetailBootstrapState bootstrap,
) {
  if (!bootstrap.hasFailed) return l10n.sessionDetailBootstrapLoadingBody;
  return switch (bootstrap.failureSource) {
    SessionDetailBootstrapFailureSource.noProfile =>
      l10n.sessionDetailBootstrapNoProfileBody,
    SessionDetailBootstrapFailureSource.historyTimeout =>
      l10n.sessionDetailBootstrapTimeoutBody,
    SessionDetailBootstrapFailureSource.attach || null => l10n.failureMessage(
      l10n.sessionDetailBootstrapFailureLead,
      localizedFailureAdvice(
        l10n,
        bootstrap.failureKind ?? FailureKind.unknown,
      ),
    ),
  };
}
