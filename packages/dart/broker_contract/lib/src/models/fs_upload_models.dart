// Mirrors broker core exported fs/upload interfaces.
//
// These Dart models mirror the broker's exported TypeScript interfaces in
// `packages/typescript/protocol/src/index.ts` (the W10 typed fs/upload
// exports, plus the W14 MIME metadata): `FsNodeInfo`, `FsDirEntry`,
// `FsDirectoryResult`, `FsReadResult`, `UploadInitResult`, `UploadStatus`,
// `UploadPatchResult`, `UploadCompleteResult`.
//
// The broker wraps successful REST responses as `{ ok: true, ...result }`.
// These models mirror the *result* shapes only and carry no `ok` field; each
// `fromJson` simply ignores an unknown `ok` key (and every other additive
// broker field), so the client stays tolerant of future broker additions
// without a resync. No json_serializable is used.
//
// Governing doc: docs/protocol/contract-sync.md

/// `node:fs` stat info for a session workspace path.
///
/// Mirrors the broker's exported `FsNodeInfo` interface
/// (`packages/typescript/protocol/src/index.ts`).
class FsNodeInfo {
  /// Creates an [FsNodeInfo].
  const FsNodeInfo({
    required this.path,
    required this.type,
    required this.size,
    required this.mtimeMs,
    required this.isDirectory,
    required this.isRegularFile,
    required this.isSymbolicLink,
  });

  /// Creates an [FsNodeInfo] from a JSON map, tolerating unknown fields.
  factory FsNodeInfo.fromJson(Map<String, dynamic> json) {
    return FsNodeInfo(
      path: json['path'] as String? ?? '',
      type: json['type'] as String? ?? 'other',
      size: (json['size'] as num?)?.toInt() ?? 0,
      mtimeMs: (json['mtimeMs'] as num?)?.toDouble() ?? 0,
      isDirectory: json['isDirectory'] as bool? ?? false,
      isRegularFile: json['isRegularFile'] as bool? ?? false,
      isSymbolicLink: json['isSymbolicLink'] as bool? ?? false,
    );
  }

  /// Workspace-relative path.
  final String path;

  /// `'file'`, `'directory'`, or `'other'`.
  final String type;

  /// Size in bytes.
  final int size;

  /// Modification time in epoch milliseconds.
  final double mtimeMs;

  /// Whether the path is a directory.
  final bool isDirectory;

  /// Whether the path is a regular file.
  final bool isRegularFile;

  /// Whether the path is a symbolic link.
  final bool isSymbolicLink;

  /// Converts this [FsNodeInfo] to a JSON map.
  Map<String, dynamic> toJson() => {
    'path': path,
    'type': type,
    'size': size,
    'mtimeMs': mtimeMs,
    'isDirectory': isDirectory,
    'isRegularFile': isRegularFile,
    'isSymbolicLink': isSymbolicLink,
  };
}

/// A single entry in a session directory listing.
///
/// Mirrors the broker's exported `FsDirEntry` interface
/// (`packages/typescript/protocol/src/index.ts`).
class FsDirEntry {
  /// Creates an [FsDirEntry].
  const FsDirEntry({
    required this.name,
    required this.path,
    required this.type,
    required this.size,
    required this.mtimeMs,
  });

  /// Creates an [FsDirEntry] from a JSON map, tolerating unknown fields.
  factory FsDirEntry.fromJson(Map<String, dynamic> json) {
    return FsDirEntry(
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      type: json['type'] as String? ?? 'other',
      size: (json['size'] as num?)?.toInt() ?? 0,
      mtimeMs: (json['mtimeMs'] as num?)?.toDouble() ?? 0,
    );
  }

  /// Basename of the entry.
  final String name;

  /// Workspace-relative path of the entry.
  final String path;

  /// `'file'`, `'directory'`, `'other'`, or `'symlink'`.
  final String type;

  /// Size in bytes.
  final int size;

  /// Modification time in epoch milliseconds.
  final double mtimeMs;

  /// Converts this [FsDirEntry] to a JSON map.
  Map<String, dynamic> toJson() => {
    'name': name,
    'path': path,
    'type': type,
    'size': size,
    'mtimeMs': mtimeMs,
  };
}

/// Result of `GET /api/sessions/:tool/:id/fs/read`.
///
/// Mirrors the broker's exported `FsReadResult` interface
/// (`packages/typescript/protocol/src/index.ts`). The broker's HTTP wrapper prepends
/// `ok: true`; that key is ignored here.
class FsReadResult {
  /// Creates an [FsReadResult].
  const FsReadResult({
    required this.path,
    required this.size,
    required this.limit,
    required this.truncated,
    required this.encoding,
    required this.data,
    this.mimeType,
  });

  /// Creates an [FsReadResult] from a JSON map, tolerating unknown fields
  /// (including the broker's `ok` wrapper).
  factory FsReadResult.fromJson(Map<String, dynamic> json) {
    return FsReadResult(
      path: json['path'] as String? ?? '',
      size: (json['size'] as num?)?.toInt() ?? 0,
      limit: (json['limit'] as num?)?.toInt() ?? 0,
      truncated: json['truncated'] as bool? ?? false,
      encoding: json['encoding'] as String? ?? 'utf8',
      data: json['data'] as String? ?? '',
      mimeType: json['mimeType'] as String?,
    );
  }

  /// Workspace-relative path requested by the client query param `path`.
  final String path;

  /// Full file size in bytes.
  final int size;

  /// Effective byte cap from `maxBytes` or `COSYNCING_FS_READ_MAX_BYTES`.
  final int limit;

  /// Whether [data] was truncated to fit [limit].
  final bool truncated;

  /// Encoding of [data]: `'utf8'` or `'base64'`.
  final String encoding;

  /// File contents (UTF-8 text or base64 depending on [encoding]).
  final String data;

  /// Optional sniffed MIME type.
  ///
  /// Mirrors broker `FsReadResult.mimeType?` added in W14.
  final String? mimeType;

  /// Converts this [FsReadResult] to a JSON map.
  Map<String, dynamic> toJson() => {
    'path': path,
    'size': size,
    'limit': limit,
    'truncated': truncated,
    'encoding': encoding,
    'data': data,
    if (mimeType != null) 'mimeType': mimeType,
  };
}

/// Result of `GET /api/sessions/:tool/:id/fs`.
///
/// Mirrors the broker's exported `FsDirectoryResult` interface
/// (`packages/typescript/protocol/src/index.ts`). The broker's HTTP wrapper prepends
/// `ok: true`; that key is ignored here.
class FsDirectoryResult {
  /// Creates an [FsDirectoryResult].
  const FsDirectoryResult({
    required this.path,
    required this.stat,
    required this.entries,
  });

  /// Creates an [FsDirectoryResult] from a JSON map, tolerating unknown fields
  /// (including the broker's `ok` wrapper).
  factory FsDirectoryResult.fromJson(Map<String, dynamic> json) {
    final entriesJson = json['entries'] as List<dynamic>? ?? [];
    return FsDirectoryResult(
      path: json['path'] as String? ?? '',
      stat: FsNodeInfo.fromJson(
        json['stat'] as Map<String, dynamic>? ?? const <String, dynamic>{},
      ),
      entries: entriesJson
          .map((e) => FsDirEntry.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  /// Workspace-relative path that was listed.
  final String path;

  /// Stat info for the listed directory.
  final FsNodeInfo stat;

  /// Child entries.
  final List<FsDirEntry> entries;

  /// Converts this [FsDirectoryResult] to a JSON map.
  Map<String, dynamic> toJson() => {
    'path': path,
    'stat': stat.toJson(),
    'entries': entries.map((e) => e.toJson()).toList(),
  };
}

/// Result of `POST /api/sessions/:tool/:id/uploads`.
///
/// Mirrors the broker's exported `UploadInitResult` interface
/// (`packages/typescript/protocol/src/index.ts`). The broker's HTTP wrapper prepends
/// `ok: true`; that key is ignored here.
class UploadInitResult {
  /// Creates an [UploadInitResult].
  const UploadInitResult({
    required this.uploadId,
    required this.offset,
    required this.size,
    required this.expiresAt,
  });

  /// Creates an [UploadInitResult] from a JSON map, tolerating unknown fields
  /// (including the broker's `ok` wrapper).
  factory UploadInitResult.fromJson(Map<String, dynamic> json) {
    return UploadInitResult(
      uploadId: json['uploadId'] as String? ?? '',
      offset: (json['offset'] as num?)?.toInt() ?? 0,
      size: (json['size'] as num?)?.toInt() ?? 0,
      expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
    );
  }

  /// Broker-issued upload id (UUID).
  final String uploadId;

  /// Current byte offset (starts at 0).
  final int offset;

  /// Advertised total size (0 if unknown).
  final int size;

  /// Epoch milliseconds when the staging upload expires.
  final int expiresAt;

  /// Converts this [UploadInitResult] to a JSON map.
  Map<String, dynamic> toJson() => {
    'uploadId': uploadId,
    'offset': offset,
    'size': size,
    'expiresAt': expiresAt,
  };
}

/// Result of `GET /api/sessions/:tool/:id/uploads/:uploadId`.
///
/// Mirrors the broker's exported `UploadStatus` interface
/// (`packages/typescript/protocol/src/index.ts`). The broker's HTTP wrapper prepends
/// `ok: true`; that key is ignored here.
class UploadStatus {
  /// Creates an [UploadStatus].
  const UploadStatus({
    required this.uploadId,
    required this.offset,
    required this.size,
    required this.name,
    required this.mimeType,
    required this.expiresAt,
    this.ready = false,
  });

  /// Creates an [UploadStatus] from a JSON map, tolerating unknown fields
  /// (including the broker's `ok` wrapper).
  factory UploadStatus.fromJson(Map<String, dynamic> json) {
    return UploadStatus(
      uploadId: json['uploadId'] as String? ?? '',
      offset: (json['offset'] as num?)?.toInt() ?? 0,
      size: (json['size'] as num?)?.toInt() ?? 0,
      name: json['name'] as String? ?? '',
      mimeType: json['mimeType'] as String? ?? '',
      expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
      ready: json['ready'] as bool? ?? false,
    );
  }

  /// Upload id.
  final String uploadId;

  /// Next byte offset. PATCH must send this as `x-cosyncing-upload-offset`.
  final int offset;

  /// Advertised total size (0 if unknown).
  final int size;

  /// Original client-supplied filename.
  final String name;

  /// Original client-supplied MIME type (required by the broker interface).
  final String mimeType;

  /// Epoch milliseconds when this upload/staged reference expires.
  final int expiresAt;

  /// Whether completion produced a prompt-consumable opaque reference.
  final bool ready;

  /// Converts this [UploadStatus] to a JSON map.
  Map<String, dynamic> toJson() => {
    'uploadId': uploadId,
    'offset': offset,
    'size': size,
    'name': name,
    'mimeType': mimeType,
    'expiresAt': expiresAt,
    if (ready) 'ready': true,
  };
}

/// Result of `PATCH /api/sessions/:tool/:id/uploads/:uploadId`.
///
/// Mirrors the broker's exported `UploadPatchResult` interface
/// (`packages/typescript/protocol/src/index.ts`). The broker's HTTP wrapper prepends
/// `ok: true`; that key is ignored here.
class UploadPatchResult {
  /// Creates an [UploadPatchResult].
  const UploadPatchResult({
    required this.uploadId,
    required this.offset,
    required this.size,
    required this.progress,
  });

  /// Creates an [UploadPatchResult] from a JSON map, tolerating unknown fields
  /// (including the broker's `ok` wrapper).
  factory UploadPatchResult.fromJson(Map<String, dynamic> json) {
    return UploadPatchResult(
      uploadId: json['uploadId'] as String? ?? '',
      offset: (json['offset'] as num?)?.toInt() ?? 0,
      size: (json['size'] as num?)?.toInt() ?? 0,
      progress: (json['progress'] as num?)?.toDouble() ?? 0,
    );
  }

  /// Upload id.
  final String uploadId;

  /// Byte offset after appending the chunk.
  final int offset;

  /// Advertised total size (0 if unknown).
  final int size;

  /// Completion fraction in `[0, 1]` (0 when size is unknown).
  final double progress;

  /// Converts this [UploadPatchResult] to a JSON map.
  Map<String, dynamic> toJson() => {
    'uploadId': uploadId,
    'offset': offset,
    'size': size,
    'progress': progress,
  };
}

/// Result of `POST /api/sessions/:tool/:id/uploads/:uploadId/complete`.
///
/// Mirrors the broker's exported `UploadCompleteResult` interface
/// (`packages/typescript/protocol/src/index.ts`). The broker's HTTP wrapper prepends
/// `ok: true`; that key is ignored here.
class UploadCompleteResult {
  /// Creates an [UploadCompleteResult].
  const UploadCompleteResult({
    required this.uploadId,
    required this.stagedRef,
    required this.name,
    required this.mimeType,
    required this.size,
    required this.expiresAt,
  });

  /// Creates an [UploadCompleteResult] from a JSON map, tolerating unknown
  /// fields (including the broker's `ok` wrapper).
  factory UploadCompleteResult.fromJson(Map<String, dynamic> json) {
    return UploadCompleteResult(
      uploadId: json['uploadId'] as String? ?? '',
      stagedRef: json['stagedRef'] as String? ?? '',
      name: json['name'] as String? ?? '',
      mimeType: json['mimeType'] as String? ?? '',
      size: (json['size'] as num?)?.toInt() ?? 0,
      expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
    );
  }

  /// Broker-issued upload id used for explicit discard.
  final String uploadId;

  /// Opaque prompt reference; never a client-supplied filesystem path.
  final String stagedRef;

  /// Unique filename inside the session inbox.
  final String name;

  /// MIME type.
  final String mimeType;

  /// Final size in bytes.
  final int size;

  /// Epoch milliseconds when the unconsumed staged reference expires.
  final int expiresAt;

  /// Converts this [UploadCompleteResult] to a JSON map.
  Map<String, dynamic> toJson() => {
    'uploadId': uploadId,
    'stagedRef': stagedRef,
    'name': name,
    'mimeType': mimeType,
    'size': size,
    'expiresAt': expiresAt,
  };
}
