import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';

/// Localized structured identity for one session-owned Attention event.
String attentionSessionEventTitle(
  AttentionEvent event,
  AppLocalizations l10n,
) {
  final identity = attentionSessionIdentity(event, l10n);
  if (event.isPermissionRequired || event.isQuestionRequired) {
    return l10n.foregroundAttentionSessionNeedsInput(identity);
  }
  if (event.isGoalFinished || event.isRunFinished) {
    return l10n.foregroundAttentionSessionFinished(identity);
  }
  if (event.isRunFailed) {
    return l10n.foregroundAttentionSessionFailed(identity);
  }
  if (event.isSyncDegraded) {
    return l10n.foregroundAttentionSessionDegraded(identity);
  }
  final brokerTitle = event.title.trim();
  return brokerTitle.isEmpty
      ? l10n.foregroundAttentionFallbackTitle
      : brokerTitle;
}

/// `Tool: title` identity built from the broker's title snapshot.
String attentionSessionIdentity(
  AttentionEvent event,
  AppLocalizations l10n,
) {
  final tool = attentionToolDisplayName(
    event.action.tool ?? event.action.agent ?? event.agent,
    l10n,
  );
  final title = event.sessionTitle?.trim();
  final sessionTitle = title == null || title.isEmpty
      ? l10n.foregroundAttentionUntitledSession
      : title;
  return '$tool: $sessionTitle';
}

/// Localized display name for known tools, with a future-tool fallback.
String attentionToolDisplayName(String? value, AppLocalizations l10n) {
  final tool = value?.trim();
  return switch (tool?.toLowerCase()) {
    'claude' => l10n.sessionRosterAgentClaude,
    'codex' => l10n.sessionRosterAgentCodex,
    'opencode' => l10n.sessionRosterAgentOpenCode,
    'pi' => l10n.sessionRosterAgentPi,
    'omp' => l10n.sessionRosterAgentOmp,
    // The backend id and the product name differ here, so the fallback below
    // would name the command (`agy`) in a notification the user reads as prose.
    'agy' => l10n.sessionRosterAgentAntigravity,
    null || '' => l10n.foregroundAttentionUntitledSession,
    _ => tool!,
  };
}
