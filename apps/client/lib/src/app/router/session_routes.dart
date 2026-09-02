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

/// Builds a deep-link-safe location for the compact file drill-in route.
///
/// Below the split's width a file cannot be a second pane, so it is a pushed
/// route instead. The path travels as a query parameter rather than as path
/// segments: a file path is arbitrarily deep and its own separators would
/// otherwise be indistinguishable from the route's.
String sessionFileLocation({
  required String tool,
  required String sessionId,
  required String path,
  int? line,
}) {
  final uri = Uri(
    pathSegments: ['sessions', tool, sessionId, 'file'],
    queryParameters: {'path': path, if (line != null) 'line': '$line'},
  );
  return '/$uri';
}

/// Whether [location] addresses the compact file drill-in route.
///
/// Four segments under [sessionsRoute] ending in `file`. Tool and session ids
/// are encoded as single segments, so no id can counterfeit this shape.
bool isSessionFileLocation(String location) {
  final segments = Uri.parse(location).pathSegments;
  return segments.length == 4 &&
      '/${segments.first}' == sessionsRoute &&
      segments.last == 'file';
}

/// Whether [location] is a drilled-in session view rather than a destination.
///
/// Both the detail route and the file route own the full compact viewport, so
/// neither shows the bottom navigation; the AppBar back button is the way out.
bool isDrilledInSessionLocation(String location) =>
    isSessionDetailLocation(location) || isSessionFileLocation(location);
