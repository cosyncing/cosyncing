/// Metadata only; counting storage never reads a file body.
final class LocalFileObservation {
  /// Records one managed file's exact observed version.
  const LocalFileObservation({required this.size, required this.version});

  /// Physical file bytes.
  final int size;

  /// Version determined by the platform's metadata, without content hashing.
  final String version;
}

/// Platform-owned filesystem boundary; UI never receives deletion paths.
abstract interface class LocalStorageFileBackend {
  /// Inspects only a registered file inside an approved app-owned root.
  Future<LocalFileObservation?> inspect(String location);

  /// Rechecks containment and version before unlinking. Null means missing.
  Future<int?> remove(String location, String version);
}

/// Expected admission/version failure, distinct from programming errors.
final class LocalStorageException implements Exception {
  /// A stable code suitable for contextual diagnostics and outcome records.
  const LocalStorageException(this.code);

  /// Why the requested operation could not proceed.
  final String code;

  @override
  String toString() => 'LocalStorageException: $code';
}

/// Optional native measurement of the open database and its WAL. This is
/// informational and deliberately separate from the owned-file deletion API.
// This optional capability is shared by platform backends, not a global I/O
// hook.
// ignore: one_member_abstracts
abstract interface class LocalDatabaseStorageMeasurement {
  /// Null means the physical database could not be measured on this platform.
  Future<int?> databaseBytes(String databasePath);
}

/// One metadata-only entry found inside an app-managed root. Discovery does
/// not establish deletion ownership or adopt the file into the registry.
final class LocalStorageDiscoveredFile {
  /// Unknown bytes preserve an unreadable or unsafe entry as informational.
  const LocalStorageDiscoveredFile(this.location, this.bytes);

  /// Internal path, used only to compare against registered ownership.
  final String location;

  /// Physical file length, without reading its contents.
  final int? bytes;
}

/// Optional native inventory of unregistered files in the app's own roots.
// Keep optional native discovery separate from deletion admission.
// ignore: one_member_abstracts
abstract interface class LocalStorageDiscovery {
  /// Bounded, non-recursive discovery; links and workspace roots are excluded.
  Stream<LocalStorageDiscoveredFile> discover();
}
