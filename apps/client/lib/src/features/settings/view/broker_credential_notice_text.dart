import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';

/// Localized recovery advice for a classified [FailureKind].
///
/// The ARB counterpart of `recoveryAdviceEn`. Kept as a plain function rather
/// than a switch inline at each call site so every surface that reports a
/// credential failure gives the same advice for the same failure.
String failureAdviceText(AppLocalizations l10n, FailureKind kind) {
  return localizedFailureAdvice(l10n, kind);
}

/// Resolves a credential outcome to the sentence a user reads.
///
/// Failures are composed from two parts: a lead naming what failed in the
/// user's terms, and advice chosen from the classified [FailureKind]. The raw
/// exception is never part of this string — it stays in
/// [BrokerCredentialsState.detail] for the "Technical details" disclosure.
///
/// Returns null when there is nothing to report.
String? brokerCredentialNoticeText(
  AppLocalizations l10n,
  BrokerCredentialsState state,
) {
  final notice = state.notice;
  if (notice == null) return null;

  final lead = switch (notice) {
    BrokerCredentialNotice.tokenSaved => l10n.credentialTokenSaved,
    BrokerCredentialNotice.tokenRemoved => l10n.credentialTokenRemoved,
    BrokerCredentialNotice.signedOut => l10n.credentialSignedOut,
    BrokerCredentialNotice.noTokenStored => l10n.credentialNoTokenStored,
    BrokerCredentialNotice.noActiveProfile => l10n.credentialNoActiveProfile,
    BrokerCredentialNotice.noProfileActive => l10n.credentialNoProfileActive,
    BrokerCredentialNotice.noCredentialStored =>
      l10n.credentialNoCredentialStored,
    BrokerCredentialNotice.tokenEmpty => l10n.credentialTokenEmpty,
    BrokerCredentialNotice.saveFailed => l10n.credentialSaveFailed,
    BrokerCredentialNotice.removeFailed => l10n.credentialRemoveFailed,
    BrokerCredentialNotice.signOutFailed => l10n.credentialSignOutFailed,
  };

  final kind = state.failureKind;
  if (kind == null) return lead;
  return l10n.failureMessage(lead, failureAdviceText(l10n, kind));
}
