import 'package:cosyncing_client/src/platform/update/web_client_update.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Current complete, waiting browser build, if one exists.
final webClientUpdateProvider = StreamProvider<WebClientUpdateState>(
  (ref) => watchWebClientUpdates(),
);
