// Custom Flutter web bootstrap template (N3).
//
// `flutter build web` expands the two template tokens at the bottom of this
// file and copies the result to build/web/flutter_bootstrap.js. This file is
// the source of truth; the build output is generated and never hand-edited.
//
// NOTE: expansion is a plain textual replacement over the WHOLE file, comments
// included. Never write a template token's literal spelling anywhere above —
// doing so splices the flutter.js bundle into the middle of a comment line and
// the build ships a syntax error.
//
// The only deliberate difference from Flutter's default template is that
// `_flutter.loader.load()` is called with no service-worker settings.
//
// Why: `flutter_service_worker.js` is now an unregister-only stub that Flutter
// has deprecated. The loader registers it whenever any service-worker
// registration already exists at this scope — which is exactly the situation
// once index.html registers `sw.js`. Registering a different script for the
// same scope REPLACES the registration, so the stub would evict our static
// cache worker, unregister itself, and then `client.navigate()` every open
// tab: a reload cycle with no cache and no worker at the end of it.
//
// Service-worker ownership therefore lives entirely in index.html + sw.js.
{{flutter_js}}
{{flutter_build_config}}

_flutter.loader.load();
