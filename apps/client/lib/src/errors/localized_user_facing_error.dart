import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';

/// Localized recovery advice for a classified [FailureKind].
String localizedFailureAdvice(
  AppLocalizations l10n,
  FailureKind kind,
) {
  return switch (kind) {
    FailureKind.offline => l10n.failureAdviceOffline,
    FailureKind.unauthorized => l10n.failureAdviceUnauthorized,
    FailureKind.rejected => l10n.failureAdviceRejected,
    FailureKind.brokerFault => l10n.failureAdviceBrokerFault,
    FailureKind.deviceStorage => l10n.failureAdviceDeviceStorage,
    FailureKind.unknown => l10n.failureAdviceUnknown,
  };
}

/// Builds localized primary copy without exposing [error]'s diagnostic text.
String localizedFailureMessage(
  AppLocalizations l10n,
  Object error, {
  required String lead,
}) {
  return l10n.failureMessage(
    lead,
    localizedFailureAdvice(l10n, classifyFailure(error)),
  );
}
