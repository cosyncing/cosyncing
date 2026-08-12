import 'dart:async';

import 'package:broker_contract/broker_contract.dart';

/// Maximum UTF-16 code units retained for one copied technical detail.
const int maxTechnicalDetailLength = 2048;

/// Applies the shared construction-time diagnostic bound.
///
/// The ellipsis is inside [maxTechnicalDetailLength], and applying this to an
/// already bounded value returns it unchanged.
String? boundedTechnicalDetail(String? detail) {
  final value = detail?.trim();
  if (value == null || value.isEmpty) return null;
  if (value.length <= maxTechnicalDetailLength) return value;
  return '${value.substring(0, maxTechnicalDetailLength - 1)}…';
}

/// How a failure reached the app.
///
/// This is the discriminator every user-facing error message is built from. It
/// deliberately describes *where* the failure happened rather than which
/// operation triggered it: the operation supplies the lead sentence ("Couldn't
/// save the token."), and the kind supplies the recovery sentence ("The broker
/// didn't respond…"). Splitting the two keeps the number of strings linear
/// instead of multiplying operations by failure modes.
///
/// Modeled on `userMessageForSessionFileError` and `_transcriptExportFailure`,
/// the two error mappers in the client that already do this correctly: classify
/// first, then map to plain language. See `docs/architecture/client-ui.md`.
enum FailureKind {
  /// The broker was never reached — down, wrong address, DNS, or no network.
  ///
  /// `BrokerClient` funnels every transport failure into a [BrokerException]
  /// with a null `statusCode`, so "we never got an answer" is observable
  /// rather than guessed. See `RealBrokerAuthProbe`, which relies on the same
  /// property.
  offline,

  /// The broker answered, and refused the credential (401/403).
  unauthorized,

  /// The broker answered and rejected the request itself (other 4xx).
  rejected,

  /// The broker answered, and failed on its own side (5xx).
  brokerFault,

  /// This device's secure storage or a platform channel refused the operation.
  deviceStorage,

  /// Anything unclassified. Never assume a cause here.
  unknown,
}

/// Classifies [error] into the coarse failure mode a user can act on.
///
/// Platform failures are matched by runtime type name rather than by `is`
/// checks so this stays free of `dart:io` and platform-channel imports and can
/// run unchanged on web.
FailureKind classifyFailure(Object error) {
  if (error is BrokerException) {
    final status = error.statusCode;
    if (status == null) {
      // No status means no HTTP response was ever parsed: connection refused,
      // DNS failure, TLS handshake failure, or timeout.
      return FailureKind.offline;
    }
    if (status == 401 || status == 403) return FailureKind.unauthorized;
    if (status >= 500) return FailureKind.brokerFault;
    if (status >= 400) return FailureKind.rejected;
    return FailureKind.unknown;
  }

  if (error is TimeoutException) return FailureKind.offline;

  final typeName = error.runtimeType.toString();
  if (typeName.contains('PlatformException') ||
      typeName.contains('MissingPluginException')) {
    return FailureKind.deviceStorage;
  }
  if (typeName.contains('SocketException') ||
      typeName.contains('ClientException') ||
      typeName.contains('HandshakeException')) {
    return FailureKind.offline;
  }

  return FailureKind.unknown;
}

/// Raw, untranslated diagnostic text for a "Technical details" disclosure.
///
/// Never render this in the primary reading path. It exists so a user can copy
/// it into a support request, which is the only reason the raw text is kept at
/// all. Prefers the broker's own structured error over the Dart exception's
/// `toString()`, which is noisier and leaks type names.
String failureDetail(Object error) {
  late final String raw;
  if (error is BrokerException) {
    final structured = error.error?.error;
    final code = error.error?.code;
    final status = error.statusCode;
    final buffer = StringBuffer(structured ?? error.message);
    if (code != null) buffer.write(' [$code]');
    if (status != null) buffer.write(' (status $status)');
    raw = buffer.toString();
  } else {
    raw = error.toString();
  }
  return boundedTechnicalDetail(raw)!;
}

/// English recovery sentence for [kind] — what the user should do next.
///
/// Localized surfaces map [FailureKind] to ARB strings instead of calling this;
/// see the connection gate. This exists for the surfaces that are still
/// hardcoded English, so they at least stop leaking exceptions today.
String recoveryAdviceEn(FailureKind kind) {
  return switch (kind) {
    FailureKind.offline =>
      "The server didn't respond. Check that it's running and that you're on "
          'the right network, then try again.',
    FailureKind.unauthorized =>
      "The server refused this device's access. Pair this device again, or "
          'paste a current server token.',
    FailureKind.rejected => 'The server rejected the request. Try again.',
    FailureKind.brokerFault =>
      'The server ran into a problem on its end. Try again in a moment.',
    FailureKind.deviceStorage =>
      "This device's secure storage refused the change. Try again, or restart "
          'the app.',
    FailureKind.unknown =>
      'Try again. If it keeps happening, the technical details can help '
          'support.',
  };
}

/// A failure translated for a person to read.
///
/// [message] is the whole user-facing sentence: what happened, then what to do.
/// [detail] is the raw diagnostic, kept for a disclosure and never concatenated
/// into [message].
class UserFacingError {
  /// Creates a [UserFacingError].
  const UserFacingError({required this.message, this.detail});

  /// Plain-language message: what failed, and the next step.
  final String message;

  /// Raw diagnostic for a "Technical details" disclosure. Never in [message].
  final String? detail;
}

/// Builds a user-facing error from [error] and an operation-specific [lead].
///
/// [lead] must be a complete sentence naming what failed in the user's terms
/// ("Couldn't save the token."). The recovery sentence is chosen from the
/// classified [FailureKind] so the advice matches the actual failure instead of
/// being a generic "Something went wrong", which would be worse than the raw
/// text it replaces.
UserFacingError describeFailure(Object error, {required String lead}) {
  return UserFacingError(
    message: '$lead ${recoveryAdviceEn(classifyFailure(error))}',
    detail: failureDetail(error),
  );
}

/// Convenience for callers that can only carry a single string today.
///
/// Drops the raw diagnostic rather than appending it — appending is exactly the
/// leak this module exists to remove.
String userFacingMessage(Object error, {required String lead}) =>
    describeFailure(error, lead: lead).message;
