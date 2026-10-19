import 'package:cosyncing_client/src/platform/update/local_desktop_updater_contract.dart';

/// Browsers and unsupported hosts never execute a native installation command.
LocalDesktopUpdater createLocalDesktopUpdater() => _UnsupportedUpdater();

class _UnsupportedUpdater implements LocalDesktopUpdater {
  Never _unsupported() =>
      throw const DesktopUpdaterUnavailable('desktop-update-unsupported');
  @override
  Future<Map<String, dynamic>> inspect() async => _unsupported();
  @override
  Future<Map<String, dynamic>> prepare(String id, String release) async =>
      _unsupported();
  @override
  Future<Map<String, dynamic>> arm(String id) async => _unsupported();
  @override
  Future<Map<String, dynamic>> status(String id) async => _unsupported();
  @override
  Future<void> cancel(String id) async => _unsupported();
  @override
  Future<void> acknowledgeStartup(String version) async {}
}
