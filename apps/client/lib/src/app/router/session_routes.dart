import 'package:cosyncing_client/src/app/router/app_routes.dart';

/// Builds a deep-link-safe location for a session detail route.
///
/// Keep session route construction centralized so tool/session ids with `/`,
/// `#`, `?`, `%`, spaces, or non-ASCII text are encoded as path segments.
///
/// Governing design: `docs/architecture/client-ui.md` (Routing).
String sessionDetailLocation({
  required String tool,
  required String sessionId,
}) {
  final uri = Uri(
    pathSegments: ['sessions', tool, sessionId],
  );
  return '/$uri';
}

/// Whether [location] addresses a session detail route.
///
/// The detail route is the only three-segment location under [sessionsRoute]
/// (`/sessions/<tool>/<id>`), so segment shape is enough — and it stays
/// correct for encoded tool/session ids, which a string prefix match would
/// mishandle. Used by the shell to decide whether the compact bottom
/// navigation applies; see `docs/architecture/client-ui.md`.
bool isSessionDetailLocation(String location) {
  final segments = Uri.parse(location).pathSegments;
  return segments.length == 3 && '/${segments.first}' == sessionsRoute;
}
