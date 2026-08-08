import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';

/// Display name for the auto-selected "this server" broker profile.
///
/// Used on web when the app is served directly by the broker, so no operator
/// URL entry is required.
const String sameOriginBrokerDisplayName = 'This server';

/// Builds the same-origin broker profile from the current page [base] URI.
///
/// When the Flutter web app is served by the broker itself (e.g. from
/// `http://127.0.0.1:7734/cosy/`), the broker lives at the page's own origin.
/// This derives a [BrokerProfile] whose [BrokerProfile.baseUri] is that origin
/// (`http://127.0.0.1:7734`), so the app can attach same-origin with no
/// operator entry and no cross-origin request.
///
/// The base URI scheme is preserved (`http` or `https`); the session WebSocket
/// scheme is derived from it downstream (`http` -> `ws`, `https` -> `wss`) by
/// `EndpointResolver`, so nothing extra is needed here.
///
/// Pass [base] explicitly (defaults to [Uri.base]) so this stays pure and
/// unit-testable off the web platform.
BrokerProfile sameOriginBrokerProfile({
  Uri? base,
  DateTime? now,
}) {
  final origin = brokerBaseFromOrigin(base ?? Uri.base);
  final timestamp = now ?? DateTime.now();
  return BrokerProfile(
    id: origin.toString(),
    displayName: sameOriginBrokerDisplayName,
    baseUri: origin,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: timestamp,
  );
}

/// Whether [base] is an origin the app can attach to same-origin.
///
/// Guards against non-web or degenerate contexts (e.g. `about:blank`,
/// `file://`, or an empty host) where deriving a broker origin is meaningless.
bool isAttachableOrigin(Uri base) {
  if (base.host.isEmpty) {
    return false;
  }
  return base.scheme == 'http' || base.scheme == 'https';
}
