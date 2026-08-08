import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_scheduled_message_controller.dart';

/// Localized copy for an actionable inline-schedule failure.
///
/// The controller keeps the failure typed so this is the only place a sentence
/// is chosen, and so [InlineScheduleActionError.detail] — the raw broker or
/// exception text — stays out of the primary reading path.
String inlineScheduleActionMessage(
  AppLocalizations l10n,
  InlineScheduleActionError error,
) => switch (error.failure) {
  InlineScheduleActionFailure.connectToView => l10n.scheduleInlineConnectToView,
  InlineScheduleActionFailure.connectToChange =>
    l10n.scheduleInlineConnectToChange,
  InlineScheduleActionFailure.missingRow => l10n.scheduleInlineMissingRow,
  InlineScheduleActionFailure.conflict => l10n.scheduleInlineConflict,
  InlineScheduleActionFailure.refreshFailed => l10n.failureMessage(
    l10n.scheduleInlineRefreshFailedLead,
    localizedFailureAdvice(l10n, error.failureKind),
  ),
  InlineScheduleActionFailure.mutationFailed => l10n.failureMessage(
    l10n.scheduleInlineMutationFailedLead,
    localizedFailureAdvice(l10n, error.failureKind),
  ),
};
