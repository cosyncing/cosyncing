import 'package:cosyncing_client/src/platform/update/local_desktop_updater.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Local same-user helper, independent of the active server or its connection.
final localDesktopUpdaterProvider = Provider<LocalDesktopUpdater>(
  (_) => createLocalDesktopUpdater(),
);
