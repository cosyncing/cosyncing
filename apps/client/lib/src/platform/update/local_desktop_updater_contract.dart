// This small platform contract names the update operations directly.
// ignore_for_file: public_member_api_docs

abstract interface class LocalDesktopUpdater {
  Future<Map<String, dynamic>> inspect();
  Future<Map<String, dynamic>> prepare(String operationId, String releaseId);
  Future<Map<String, dynamic>> arm(String operationId);
  Future<Map<String, dynamic>> status(String operationId);
  Future<void> cancel(String operationId);
  Future<void> acknowledgeStartup(String version);
}

class DesktopUpdaterUnavailable implements Exception {
  const DesktopUpdaterUnavailable(this.detailCode);
  final String detailCode;
  @override
  String toString() => detailCode;
}
