// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'app_database.dart';

// ignore_for_file: type=lint
class $ArtifactTransferRowsTable extends ArtifactTransferRows
    with TableInfo<$ArtifactTransferRowsTable, ArtifactTransferRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ArtifactTransferRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _toolMeta = const VerificationMeta('tool');
  @override
  late final GeneratedColumn<String> tool = GeneratedColumn<String>(
    'tool',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _actionKeyMeta = const VerificationMeta(
    'actionKey',
  );
  @override
  late final GeneratedColumn<String> actionKey = GeneratedColumn<String>(
    'action_key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _fileNameMeta = const VerificationMeta(
    'fileName',
  );
  @override
  late final GeneratedColumn<String> fileName = GeneratedColumn<String>(
    'file_name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _directionMeta = const VerificationMeta(
    'direction',
  );
  @override
  late final GeneratedColumn<String> direction = GeneratedColumn<String>(
    'direction',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _attemptCountMeta = const VerificationMeta(
    'attemptCount',
  );
  @override
  late final GeneratedColumn<int> attemptCount = GeneratedColumn<int>(
    'attempt_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _artifactKeyMeta = const VerificationMeta(
    'artifactKey',
  );
  @override
  late final GeneratedColumn<String> artifactKey = GeneratedColumn<String>(
    'artifact_key',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sourceUrlMeta = const VerificationMeta(
    'sourceUrl',
  );
  @override
  late final GeneratedColumn<String> sourceUrl = GeneratedColumn<String>(
    'source_url',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _cachedFilePathMeta = const VerificationMeta(
    'cachedFilePath',
  );
  @override
  late final GeneratedColumn<String> cachedFilePath = GeneratedColumn<String>(
    'cached_file_path',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _exportedPathMeta = const VerificationMeta(
    'exportedPath',
  );
  @override
  late final GeneratedColumn<String> exportedPath = GeneratedColumn<String>(
    'exported_path',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _contentTypeMeta = const VerificationMeta(
    'contentType',
  );
  @override
  late final GeneratedColumn<String> contentType = GeneratedColumn<String>(
    'content_type',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _contentHashMeta = const VerificationMeta(
    'contentHash',
  );
  @override
  late final GeneratedColumn<String> contentHash = GeneratedColumn<String>(
    'content_hash',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _uploadIdMeta = const VerificationMeta(
    'uploadId',
  );
  @override
  late final GeneratedColumn<String> uploadId = GeneratedColumn<String>(
    'upload_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _partialFilePathMeta = const VerificationMeta(
    'partialFilePath',
  );
  @override
  late final GeneratedColumn<String> partialFilePath = GeneratedColumn<String>(
    'partial_file_path',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _downloadEtagMeta = const VerificationMeta(
    'downloadEtag',
  );
  @override
  late final GeneratedColumn<String> downloadEtag = GeneratedColumn<String>(
    'download_etag',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _downloadLastModifiedMeta =
      const VerificationMeta('downloadLastModified');
  @override
  late final GeneratedColumn<String> downloadLastModified =
      GeneratedColumn<String>(
        'download_last_modified',
        aliasedName,
        true,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
      );
  static const VerificationMeta _byteLengthMeta = const VerificationMeta(
    'byteLength',
  );
  @override
  late final GeneratedColumn<int> byteLength = GeneratedColumn<int>(
    'byte_length',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _bytesTransferredMeta = const VerificationMeta(
    'bytesTransferred',
  );
  @override
  late final GeneratedColumn<int> bytesTransferred = GeneratedColumn<int>(
    'bytes_transferred',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _totalBytesMeta = const VerificationMeta(
    'totalBytes',
  );
  @override
  late final GeneratedColumn<int> totalBytes = GeneratedColumn<int>(
    'total_bytes',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _errorMeta = const VerificationMeta('error');
  @override
  late final GeneratedColumn<String> error = GeneratedColumn<String>(
    'error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _messageMeta = const VerificationMeta(
    'message',
  );
  @override
  late final GeneratedColumn<String> message = GeneratedColumn<String>(
    'message',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    brokerProfileId,
    tool,
    sessionId,
    actionKey,
    fileName,
    direction,
    status,
    attemptCount,
    artifactKey,
    sourceUrl,
    cachedFilePath,
    exportedPath,
    contentType,
    contentHash,
    uploadId,
    partialFilePath,
    downloadEtag,
    downloadLastModified,
    byteLength,
    bytesTransferred,
    totalBytes,
    error,
    message,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'artifact_transfer_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<ArtifactTransferRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    }
    if (data.containsKey('tool')) {
      context.handle(
        _toolMeta,
        tool.isAcceptableOrUnknown(data['tool']!, _toolMeta),
      );
    } else if (isInserting) {
      context.missing(_toolMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('action_key')) {
      context.handle(
        _actionKeyMeta,
        actionKey.isAcceptableOrUnknown(data['action_key']!, _actionKeyMeta),
      );
    } else if (isInserting) {
      context.missing(_actionKeyMeta);
    }
    if (data.containsKey('file_name')) {
      context.handle(
        _fileNameMeta,
        fileName.isAcceptableOrUnknown(data['file_name']!, _fileNameMeta),
      );
    } else if (isInserting) {
      context.missing(_fileNameMeta);
    }
    if (data.containsKey('direction')) {
      context.handle(
        _directionMeta,
        direction.isAcceptableOrUnknown(data['direction']!, _directionMeta),
      );
    } else if (isInserting) {
      context.missing(_directionMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    } else if (isInserting) {
      context.missing(_statusMeta);
    }
    if (data.containsKey('attempt_count')) {
      context.handle(
        _attemptCountMeta,
        attemptCount.isAcceptableOrUnknown(
          data['attempt_count']!,
          _attemptCountMeta,
        ),
      );
    }
    if (data.containsKey('artifact_key')) {
      context.handle(
        _artifactKeyMeta,
        artifactKey.isAcceptableOrUnknown(
          data['artifact_key']!,
          _artifactKeyMeta,
        ),
      );
    }
    if (data.containsKey('source_url')) {
      context.handle(
        _sourceUrlMeta,
        sourceUrl.isAcceptableOrUnknown(data['source_url']!, _sourceUrlMeta),
      );
    }
    if (data.containsKey('cached_file_path')) {
      context.handle(
        _cachedFilePathMeta,
        cachedFilePath.isAcceptableOrUnknown(
          data['cached_file_path']!,
          _cachedFilePathMeta,
        ),
      );
    }
    if (data.containsKey('exported_path')) {
      context.handle(
        _exportedPathMeta,
        exportedPath.isAcceptableOrUnknown(
          data['exported_path']!,
          _exportedPathMeta,
        ),
      );
    }
    if (data.containsKey('content_type')) {
      context.handle(
        _contentTypeMeta,
        contentType.isAcceptableOrUnknown(
          data['content_type']!,
          _contentTypeMeta,
        ),
      );
    }
    if (data.containsKey('content_hash')) {
      context.handle(
        _contentHashMeta,
        contentHash.isAcceptableOrUnknown(
          data['content_hash']!,
          _contentHashMeta,
        ),
      );
    }
    if (data.containsKey('upload_id')) {
      context.handle(
        _uploadIdMeta,
        uploadId.isAcceptableOrUnknown(data['upload_id']!, _uploadIdMeta),
      );
    }
    if (data.containsKey('partial_file_path')) {
      context.handle(
        _partialFilePathMeta,
        partialFilePath.isAcceptableOrUnknown(
          data['partial_file_path']!,
          _partialFilePathMeta,
        ),
      );
    }
    if (data.containsKey('download_etag')) {
      context.handle(
        _downloadEtagMeta,
        downloadEtag.isAcceptableOrUnknown(
          data['download_etag']!,
          _downloadEtagMeta,
        ),
      );
    }
    if (data.containsKey('download_last_modified')) {
      context.handle(
        _downloadLastModifiedMeta,
        downloadLastModified.isAcceptableOrUnknown(
          data['download_last_modified']!,
          _downloadLastModifiedMeta,
        ),
      );
    }
    if (data.containsKey('byte_length')) {
      context.handle(
        _byteLengthMeta,
        byteLength.isAcceptableOrUnknown(data['byte_length']!, _byteLengthMeta),
      );
    }
    if (data.containsKey('bytes_transferred')) {
      context.handle(
        _bytesTransferredMeta,
        bytesTransferred.isAcceptableOrUnknown(
          data['bytes_transferred']!,
          _bytesTransferredMeta,
        ),
      );
    }
    if (data.containsKey('total_bytes')) {
      context.handle(
        _totalBytesMeta,
        totalBytes.isAcceptableOrUnknown(data['total_bytes']!, _totalBytesMeta),
      );
    }
    if (data.containsKey('error')) {
      context.handle(
        _errorMeta,
        error.isAcceptableOrUnknown(data['error']!, _errorMeta),
      );
    }
    if (data.containsKey('message')) {
      context.handle(
        _messageMeta,
        message.isAcceptableOrUnknown(data['message']!, _messageMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  ArtifactTransferRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ArtifactTransferRow(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      ),
      tool: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tool'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      actionKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}action_key'],
      )!,
      fileName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}file_name'],
      )!,
      direction: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}direction'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      attemptCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempt_count'],
      )!,
      artifactKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}artifact_key'],
      ),
      sourceUrl: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}source_url'],
      ),
      cachedFilePath: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}cached_file_path'],
      ),
      exportedPath: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}exported_path'],
      ),
      contentType: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}content_type'],
      ),
      contentHash: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}content_hash'],
      ),
      uploadId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}upload_id'],
      ),
      partialFilePath: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}partial_file_path'],
      ),
      downloadEtag: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}download_etag'],
      ),
      downloadLastModified: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}download_last_modified'],
      ),
      byteLength: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}byte_length'],
      ),
      bytesTransferred: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}bytes_transferred'],
      ),
      totalBytes: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}total_bytes'],
      ),
      error: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}error'],
      ),
      message: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}message'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $ArtifactTransferRowsTable createAlias(String alias) {
    return $ArtifactTransferRowsTable(attachedDatabase, alias);
  }
}

class ArtifactTransferRow extends DataClass
    implements Insertable<ArtifactTransferRow> {
  /// Stable transfer id.
  final String id;

  /// Owning broker profile. Null is reserved for pre-v12 legacy rows.
  final String? brokerProfileId;

  /// Owning broker tool key.
  final String tool;

  /// Owning broker session id.
  final String sessionId;

  /// Artifact action key from the transcript descriptor.
  final String actionKey;

  /// Display filename.
  final String fileName;

  /// Transfer direction enum name.
  final String direction;

  /// Transfer status enum name.
  final String status;

  /// Number of user-triggered retry attempts.
  final int attemptCount;

  /// Broker artifact key, when available.
  final String? artifactKey;

  /// Source URL, or `data:` marker for inline data URLs.
  final String? sourceUrl;

  /// App cache path once bytes are cached.
  final String? cachedFilePath;

  /// User-selected export path once saved.
  final String? exportedPath;

  /// MIME type, when known.
  final String? contentType;

  /// Broker/content hash, when known.
  final String? contentHash;

  /// Broker resumable upload id, when initialized.
  final String? uploadId;

  /// Durable `.part` path for a resumable workspace download.
  final String? partialFilePath;

  /// Strong ETag bound to [partialFilePath].
  final String? downloadEtag;

  /// HTTP-date validator bound to [partialFilePath].
  final String? downloadLastModified;

  /// Cached byte length, when known.
  final int? byteLength;

  /// Bytes transferred so far, when known.
  final int? bytesTransferred;

  /// Total expected bytes, when known.
  final int? totalBytes;

  /// Error message for failed transfers.
  final String? error;

  /// User-facing status detail.
  final String message;

  /// Transfer creation timestamp.
  final DateTime createdAt;

  /// Last mutation timestamp.
  final DateTime updatedAt;
  const ArtifactTransferRow({
    required this.id,
    this.brokerProfileId,
    required this.tool,
    required this.sessionId,
    required this.actionKey,
    required this.fileName,
    required this.direction,
    required this.status,
    required this.attemptCount,
    this.artifactKey,
    this.sourceUrl,
    this.cachedFilePath,
    this.exportedPath,
    this.contentType,
    this.contentHash,
    this.uploadId,
    this.partialFilePath,
    this.downloadEtag,
    this.downloadLastModified,
    this.byteLength,
    this.bytesTransferred,
    this.totalBytes,
    this.error,
    required this.message,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    if (!nullToAbsent || brokerProfileId != null) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId);
    }
    map['tool'] = Variable<String>(tool);
    map['session_id'] = Variable<String>(sessionId);
    map['action_key'] = Variable<String>(actionKey);
    map['file_name'] = Variable<String>(fileName);
    map['direction'] = Variable<String>(direction);
    map['status'] = Variable<String>(status);
    map['attempt_count'] = Variable<int>(attemptCount);
    if (!nullToAbsent || artifactKey != null) {
      map['artifact_key'] = Variable<String>(artifactKey);
    }
    if (!nullToAbsent || sourceUrl != null) {
      map['source_url'] = Variable<String>(sourceUrl);
    }
    if (!nullToAbsent || cachedFilePath != null) {
      map['cached_file_path'] = Variable<String>(cachedFilePath);
    }
    if (!nullToAbsent || exportedPath != null) {
      map['exported_path'] = Variable<String>(exportedPath);
    }
    if (!nullToAbsent || contentType != null) {
      map['content_type'] = Variable<String>(contentType);
    }
    if (!nullToAbsent || contentHash != null) {
      map['content_hash'] = Variable<String>(contentHash);
    }
    if (!nullToAbsent || uploadId != null) {
      map['upload_id'] = Variable<String>(uploadId);
    }
    if (!nullToAbsent || partialFilePath != null) {
      map['partial_file_path'] = Variable<String>(partialFilePath);
    }
    if (!nullToAbsent || downloadEtag != null) {
      map['download_etag'] = Variable<String>(downloadEtag);
    }
    if (!nullToAbsent || downloadLastModified != null) {
      map['download_last_modified'] = Variable<String>(downloadLastModified);
    }
    if (!nullToAbsent || byteLength != null) {
      map['byte_length'] = Variable<int>(byteLength);
    }
    if (!nullToAbsent || bytesTransferred != null) {
      map['bytes_transferred'] = Variable<int>(bytesTransferred);
    }
    if (!nullToAbsent || totalBytes != null) {
      map['total_bytes'] = Variable<int>(totalBytes);
    }
    if (!nullToAbsent || error != null) {
      map['error'] = Variable<String>(error);
    }
    map['message'] = Variable<String>(message);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  ArtifactTransferRowsCompanion toCompanion(bool nullToAbsent) {
    return ArtifactTransferRowsCompanion(
      id: Value(id),
      brokerProfileId: brokerProfileId == null && nullToAbsent
          ? const Value.absent()
          : Value(brokerProfileId),
      tool: Value(tool),
      sessionId: Value(sessionId),
      actionKey: Value(actionKey),
      fileName: Value(fileName),
      direction: Value(direction),
      status: Value(status),
      attemptCount: Value(attemptCount),
      artifactKey: artifactKey == null && nullToAbsent
          ? const Value.absent()
          : Value(artifactKey),
      sourceUrl: sourceUrl == null && nullToAbsent
          ? const Value.absent()
          : Value(sourceUrl),
      cachedFilePath: cachedFilePath == null && nullToAbsent
          ? const Value.absent()
          : Value(cachedFilePath),
      exportedPath: exportedPath == null && nullToAbsent
          ? const Value.absent()
          : Value(exportedPath),
      contentType: contentType == null && nullToAbsent
          ? const Value.absent()
          : Value(contentType),
      contentHash: contentHash == null && nullToAbsent
          ? const Value.absent()
          : Value(contentHash),
      uploadId: uploadId == null && nullToAbsent
          ? const Value.absent()
          : Value(uploadId),
      partialFilePath: partialFilePath == null && nullToAbsent
          ? const Value.absent()
          : Value(partialFilePath),
      downloadEtag: downloadEtag == null && nullToAbsent
          ? const Value.absent()
          : Value(downloadEtag),
      downloadLastModified: downloadLastModified == null && nullToAbsent
          ? const Value.absent()
          : Value(downloadLastModified),
      byteLength: byteLength == null && nullToAbsent
          ? const Value.absent()
          : Value(byteLength),
      bytesTransferred: bytesTransferred == null && nullToAbsent
          ? const Value.absent()
          : Value(bytesTransferred),
      totalBytes: totalBytes == null && nullToAbsent
          ? const Value.absent()
          : Value(totalBytes),
      error: error == null && nullToAbsent
          ? const Value.absent()
          : Value(error),
      message: Value(message),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory ArtifactTransferRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ArtifactTransferRow(
      id: serializer.fromJson<String>(json['id']),
      brokerProfileId: serializer.fromJson<String?>(json['brokerProfileId']),
      tool: serializer.fromJson<String>(json['tool']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      actionKey: serializer.fromJson<String>(json['actionKey']),
      fileName: serializer.fromJson<String>(json['fileName']),
      direction: serializer.fromJson<String>(json['direction']),
      status: serializer.fromJson<String>(json['status']),
      attemptCount: serializer.fromJson<int>(json['attemptCount']),
      artifactKey: serializer.fromJson<String?>(json['artifactKey']),
      sourceUrl: serializer.fromJson<String?>(json['sourceUrl']),
      cachedFilePath: serializer.fromJson<String?>(json['cachedFilePath']),
      exportedPath: serializer.fromJson<String?>(json['exportedPath']),
      contentType: serializer.fromJson<String?>(json['contentType']),
      contentHash: serializer.fromJson<String?>(json['contentHash']),
      uploadId: serializer.fromJson<String?>(json['uploadId']),
      partialFilePath: serializer.fromJson<String?>(json['partialFilePath']),
      downloadEtag: serializer.fromJson<String?>(json['downloadEtag']),
      downloadLastModified: serializer.fromJson<String?>(
        json['downloadLastModified'],
      ),
      byteLength: serializer.fromJson<int?>(json['byteLength']),
      bytesTransferred: serializer.fromJson<int?>(json['bytesTransferred']),
      totalBytes: serializer.fromJson<int?>(json['totalBytes']),
      error: serializer.fromJson<String?>(json['error']),
      message: serializer.fromJson<String>(json['message']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'brokerProfileId': serializer.toJson<String?>(brokerProfileId),
      'tool': serializer.toJson<String>(tool),
      'sessionId': serializer.toJson<String>(sessionId),
      'actionKey': serializer.toJson<String>(actionKey),
      'fileName': serializer.toJson<String>(fileName),
      'direction': serializer.toJson<String>(direction),
      'status': serializer.toJson<String>(status),
      'attemptCount': serializer.toJson<int>(attemptCount),
      'artifactKey': serializer.toJson<String?>(artifactKey),
      'sourceUrl': serializer.toJson<String?>(sourceUrl),
      'cachedFilePath': serializer.toJson<String?>(cachedFilePath),
      'exportedPath': serializer.toJson<String?>(exportedPath),
      'contentType': serializer.toJson<String?>(contentType),
      'contentHash': serializer.toJson<String?>(contentHash),
      'uploadId': serializer.toJson<String?>(uploadId),
      'partialFilePath': serializer.toJson<String?>(partialFilePath),
      'downloadEtag': serializer.toJson<String?>(downloadEtag),
      'downloadLastModified': serializer.toJson<String?>(downloadLastModified),
      'byteLength': serializer.toJson<int?>(byteLength),
      'bytesTransferred': serializer.toJson<int?>(bytesTransferred),
      'totalBytes': serializer.toJson<int?>(totalBytes),
      'error': serializer.toJson<String?>(error),
      'message': serializer.toJson<String>(message),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  ArtifactTransferRow copyWith({
    String? id,
    Value<String?> brokerProfileId = const Value.absent(),
    String? tool,
    String? sessionId,
    String? actionKey,
    String? fileName,
    String? direction,
    String? status,
    int? attemptCount,
    Value<String?> artifactKey = const Value.absent(),
    Value<String?> sourceUrl = const Value.absent(),
    Value<String?> cachedFilePath = const Value.absent(),
    Value<String?> exportedPath = const Value.absent(),
    Value<String?> contentType = const Value.absent(),
    Value<String?> contentHash = const Value.absent(),
    Value<String?> uploadId = const Value.absent(),
    Value<String?> partialFilePath = const Value.absent(),
    Value<String?> downloadEtag = const Value.absent(),
    Value<String?> downloadLastModified = const Value.absent(),
    Value<int?> byteLength = const Value.absent(),
    Value<int?> bytesTransferred = const Value.absent(),
    Value<int?> totalBytes = const Value.absent(),
    Value<String?> error = const Value.absent(),
    String? message,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => ArtifactTransferRow(
    id: id ?? this.id,
    brokerProfileId: brokerProfileId.present
        ? brokerProfileId.value
        : this.brokerProfileId,
    tool: tool ?? this.tool,
    sessionId: sessionId ?? this.sessionId,
    actionKey: actionKey ?? this.actionKey,
    fileName: fileName ?? this.fileName,
    direction: direction ?? this.direction,
    status: status ?? this.status,
    attemptCount: attemptCount ?? this.attemptCount,
    artifactKey: artifactKey.present ? artifactKey.value : this.artifactKey,
    sourceUrl: sourceUrl.present ? sourceUrl.value : this.sourceUrl,
    cachedFilePath: cachedFilePath.present
        ? cachedFilePath.value
        : this.cachedFilePath,
    exportedPath: exportedPath.present ? exportedPath.value : this.exportedPath,
    contentType: contentType.present ? contentType.value : this.contentType,
    contentHash: contentHash.present ? contentHash.value : this.contentHash,
    uploadId: uploadId.present ? uploadId.value : this.uploadId,
    partialFilePath: partialFilePath.present
        ? partialFilePath.value
        : this.partialFilePath,
    downloadEtag: downloadEtag.present ? downloadEtag.value : this.downloadEtag,
    downloadLastModified: downloadLastModified.present
        ? downloadLastModified.value
        : this.downloadLastModified,
    byteLength: byteLength.present ? byteLength.value : this.byteLength,
    bytesTransferred: bytesTransferred.present
        ? bytesTransferred.value
        : this.bytesTransferred,
    totalBytes: totalBytes.present ? totalBytes.value : this.totalBytes,
    error: error.present ? error.value : this.error,
    message: message ?? this.message,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  ArtifactTransferRow copyWithCompanion(ArtifactTransferRowsCompanion data) {
    return ArtifactTransferRow(
      id: data.id.present ? data.id.value : this.id,
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      tool: data.tool.present ? data.tool.value : this.tool,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      actionKey: data.actionKey.present ? data.actionKey.value : this.actionKey,
      fileName: data.fileName.present ? data.fileName.value : this.fileName,
      direction: data.direction.present ? data.direction.value : this.direction,
      status: data.status.present ? data.status.value : this.status,
      attemptCount: data.attemptCount.present
          ? data.attemptCount.value
          : this.attemptCount,
      artifactKey: data.artifactKey.present
          ? data.artifactKey.value
          : this.artifactKey,
      sourceUrl: data.sourceUrl.present ? data.sourceUrl.value : this.sourceUrl,
      cachedFilePath: data.cachedFilePath.present
          ? data.cachedFilePath.value
          : this.cachedFilePath,
      exportedPath: data.exportedPath.present
          ? data.exportedPath.value
          : this.exportedPath,
      contentType: data.contentType.present
          ? data.contentType.value
          : this.contentType,
      contentHash: data.contentHash.present
          ? data.contentHash.value
          : this.contentHash,
      uploadId: data.uploadId.present ? data.uploadId.value : this.uploadId,
      partialFilePath: data.partialFilePath.present
          ? data.partialFilePath.value
          : this.partialFilePath,
      downloadEtag: data.downloadEtag.present
          ? data.downloadEtag.value
          : this.downloadEtag,
      downloadLastModified: data.downloadLastModified.present
          ? data.downloadLastModified.value
          : this.downloadLastModified,
      byteLength: data.byteLength.present
          ? data.byteLength.value
          : this.byteLength,
      bytesTransferred: data.bytesTransferred.present
          ? data.bytesTransferred.value
          : this.bytesTransferred,
      totalBytes: data.totalBytes.present
          ? data.totalBytes.value
          : this.totalBytes,
      error: data.error.present ? data.error.value : this.error,
      message: data.message.present ? data.message.value : this.message,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ArtifactTransferRow(')
          ..write('id: $id, ')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('actionKey: $actionKey, ')
          ..write('fileName: $fileName, ')
          ..write('direction: $direction, ')
          ..write('status: $status, ')
          ..write('attemptCount: $attemptCount, ')
          ..write('artifactKey: $artifactKey, ')
          ..write('sourceUrl: $sourceUrl, ')
          ..write('cachedFilePath: $cachedFilePath, ')
          ..write('exportedPath: $exportedPath, ')
          ..write('contentType: $contentType, ')
          ..write('contentHash: $contentHash, ')
          ..write('uploadId: $uploadId, ')
          ..write('partialFilePath: $partialFilePath, ')
          ..write('downloadEtag: $downloadEtag, ')
          ..write('downloadLastModified: $downloadLastModified, ')
          ..write('byteLength: $byteLength, ')
          ..write('bytesTransferred: $bytesTransferred, ')
          ..write('totalBytes: $totalBytes, ')
          ..write('error: $error, ')
          ..write('message: $message, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hashAll([
    id,
    brokerProfileId,
    tool,
    sessionId,
    actionKey,
    fileName,
    direction,
    status,
    attemptCount,
    artifactKey,
    sourceUrl,
    cachedFilePath,
    exportedPath,
    contentType,
    contentHash,
    uploadId,
    partialFilePath,
    downloadEtag,
    downloadLastModified,
    byteLength,
    bytesTransferred,
    totalBytes,
    error,
    message,
    createdAt,
    updatedAt,
  ]);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ArtifactTransferRow &&
          other.id == this.id &&
          other.brokerProfileId == this.brokerProfileId &&
          other.tool == this.tool &&
          other.sessionId == this.sessionId &&
          other.actionKey == this.actionKey &&
          other.fileName == this.fileName &&
          other.direction == this.direction &&
          other.status == this.status &&
          other.attemptCount == this.attemptCount &&
          other.artifactKey == this.artifactKey &&
          other.sourceUrl == this.sourceUrl &&
          other.cachedFilePath == this.cachedFilePath &&
          other.exportedPath == this.exportedPath &&
          other.contentType == this.contentType &&
          other.contentHash == this.contentHash &&
          other.uploadId == this.uploadId &&
          other.partialFilePath == this.partialFilePath &&
          other.downloadEtag == this.downloadEtag &&
          other.downloadLastModified == this.downloadLastModified &&
          other.byteLength == this.byteLength &&
          other.bytesTransferred == this.bytesTransferred &&
          other.totalBytes == this.totalBytes &&
          other.error == this.error &&
          other.message == this.message &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class ArtifactTransferRowsCompanion
    extends UpdateCompanion<ArtifactTransferRow> {
  final Value<String> id;
  final Value<String?> brokerProfileId;
  final Value<String> tool;
  final Value<String> sessionId;
  final Value<String> actionKey;
  final Value<String> fileName;
  final Value<String> direction;
  final Value<String> status;
  final Value<int> attemptCount;
  final Value<String?> artifactKey;
  final Value<String?> sourceUrl;
  final Value<String?> cachedFilePath;
  final Value<String?> exportedPath;
  final Value<String?> contentType;
  final Value<String?> contentHash;
  final Value<String?> uploadId;
  final Value<String?> partialFilePath;
  final Value<String?> downloadEtag;
  final Value<String?> downloadLastModified;
  final Value<int?> byteLength;
  final Value<int?> bytesTransferred;
  final Value<int?> totalBytes;
  final Value<String?> error;
  final Value<String> message;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const ArtifactTransferRowsCompanion({
    this.id = const Value.absent(),
    this.brokerProfileId = const Value.absent(),
    this.tool = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.actionKey = const Value.absent(),
    this.fileName = const Value.absent(),
    this.direction = const Value.absent(),
    this.status = const Value.absent(),
    this.attemptCount = const Value.absent(),
    this.artifactKey = const Value.absent(),
    this.sourceUrl = const Value.absent(),
    this.cachedFilePath = const Value.absent(),
    this.exportedPath = const Value.absent(),
    this.contentType = const Value.absent(),
    this.contentHash = const Value.absent(),
    this.uploadId = const Value.absent(),
    this.partialFilePath = const Value.absent(),
    this.downloadEtag = const Value.absent(),
    this.downloadLastModified = const Value.absent(),
    this.byteLength = const Value.absent(),
    this.bytesTransferred = const Value.absent(),
    this.totalBytes = const Value.absent(),
    this.error = const Value.absent(),
    this.message = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ArtifactTransferRowsCompanion.insert({
    required String id,
    this.brokerProfileId = const Value.absent(),
    required String tool,
    required String sessionId,
    required String actionKey,
    required String fileName,
    required String direction,
    required String status,
    this.attemptCount = const Value.absent(),
    this.artifactKey = const Value.absent(),
    this.sourceUrl = const Value.absent(),
    this.cachedFilePath = const Value.absent(),
    this.exportedPath = const Value.absent(),
    this.contentType = const Value.absent(),
    this.contentHash = const Value.absent(),
    this.uploadId = const Value.absent(),
    this.partialFilePath = const Value.absent(),
    this.downloadEtag = const Value.absent(),
    this.downloadLastModified = const Value.absent(),
    this.byteLength = const Value.absent(),
    this.bytesTransferred = const Value.absent(),
    this.totalBytes = const Value.absent(),
    this.error = const Value.absent(),
    this.message = const Value.absent(),
    required DateTime createdAt,
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       tool = Value(tool),
       sessionId = Value(sessionId),
       actionKey = Value(actionKey),
       fileName = Value(fileName),
       direction = Value(direction),
       status = Value(status),
       createdAt = Value(createdAt),
       updatedAt = Value(updatedAt);
  static Insertable<ArtifactTransferRow> custom({
    Expression<String>? id,
    Expression<String>? brokerProfileId,
    Expression<String>? tool,
    Expression<String>? sessionId,
    Expression<String>? actionKey,
    Expression<String>? fileName,
    Expression<String>? direction,
    Expression<String>? status,
    Expression<int>? attemptCount,
    Expression<String>? artifactKey,
    Expression<String>? sourceUrl,
    Expression<String>? cachedFilePath,
    Expression<String>? exportedPath,
    Expression<String>? contentType,
    Expression<String>? contentHash,
    Expression<String>? uploadId,
    Expression<String>? partialFilePath,
    Expression<String>? downloadEtag,
    Expression<String>? downloadLastModified,
    Expression<int>? byteLength,
    Expression<int>? bytesTransferred,
    Expression<int>? totalBytes,
    Expression<String>? error,
    Expression<String>? message,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (tool != null) 'tool': tool,
      if (sessionId != null) 'session_id': sessionId,
      if (actionKey != null) 'action_key': actionKey,
      if (fileName != null) 'file_name': fileName,
      if (direction != null) 'direction': direction,
      if (status != null) 'status': status,
      if (attemptCount != null) 'attempt_count': attemptCount,
      if (artifactKey != null) 'artifact_key': artifactKey,
      if (sourceUrl != null) 'source_url': sourceUrl,
      if (cachedFilePath != null) 'cached_file_path': cachedFilePath,
      if (exportedPath != null) 'exported_path': exportedPath,
      if (contentType != null) 'content_type': contentType,
      if (contentHash != null) 'content_hash': contentHash,
      if (uploadId != null) 'upload_id': uploadId,
      if (partialFilePath != null) 'partial_file_path': partialFilePath,
      if (downloadEtag != null) 'download_etag': downloadEtag,
      if (downloadLastModified != null)
        'download_last_modified': downloadLastModified,
      if (byteLength != null) 'byte_length': byteLength,
      if (bytesTransferred != null) 'bytes_transferred': bytesTransferred,
      if (totalBytes != null) 'total_bytes': totalBytes,
      if (error != null) 'error': error,
      if (message != null) 'message': message,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ArtifactTransferRowsCompanion copyWith({
    Value<String>? id,
    Value<String?>? brokerProfileId,
    Value<String>? tool,
    Value<String>? sessionId,
    Value<String>? actionKey,
    Value<String>? fileName,
    Value<String>? direction,
    Value<String>? status,
    Value<int>? attemptCount,
    Value<String?>? artifactKey,
    Value<String?>? sourceUrl,
    Value<String?>? cachedFilePath,
    Value<String?>? exportedPath,
    Value<String?>? contentType,
    Value<String?>? contentHash,
    Value<String?>? uploadId,
    Value<String?>? partialFilePath,
    Value<String?>? downloadEtag,
    Value<String?>? downloadLastModified,
    Value<int?>? byteLength,
    Value<int?>? bytesTransferred,
    Value<int?>? totalBytes,
    Value<String?>? error,
    Value<String>? message,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return ArtifactTransferRowsCompanion(
      id: id ?? this.id,
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      tool: tool ?? this.tool,
      sessionId: sessionId ?? this.sessionId,
      actionKey: actionKey ?? this.actionKey,
      fileName: fileName ?? this.fileName,
      direction: direction ?? this.direction,
      status: status ?? this.status,
      attemptCount: attemptCount ?? this.attemptCount,
      artifactKey: artifactKey ?? this.artifactKey,
      sourceUrl: sourceUrl ?? this.sourceUrl,
      cachedFilePath: cachedFilePath ?? this.cachedFilePath,
      exportedPath: exportedPath ?? this.exportedPath,
      contentType: contentType ?? this.contentType,
      contentHash: contentHash ?? this.contentHash,
      uploadId: uploadId ?? this.uploadId,
      partialFilePath: partialFilePath ?? this.partialFilePath,
      downloadEtag: downloadEtag ?? this.downloadEtag,
      downloadLastModified: downloadLastModified ?? this.downloadLastModified,
      byteLength: byteLength ?? this.byteLength,
      bytesTransferred: bytesTransferred ?? this.bytesTransferred,
      totalBytes: totalBytes ?? this.totalBytes,
      error: error ?? this.error,
      message: message ?? this.message,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (tool.present) {
      map['tool'] = Variable<String>(tool.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (actionKey.present) {
      map['action_key'] = Variable<String>(actionKey.value);
    }
    if (fileName.present) {
      map['file_name'] = Variable<String>(fileName.value);
    }
    if (direction.present) {
      map['direction'] = Variable<String>(direction.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (attemptCount.present) {
      map['attempt_count'] = Variable<int>(attemptCount.value);
    }
    if (artifactKey.present) {
      map['artifact_key'] = Variable<String>(artifactKey.value);
    }
    if (sourceUrl.present) {
      map['source_url'] = Variable<String>(sourceUrl.value);
    }
    if (cachedFilePath.present) {
      map['cached_file_path'] = Variable<String>(cachedFilePath.value);
    }
    if (exportedPath.present) {
      map['exported_path'] = Variable<String>(exportedPath.value);
    }
    if (contentType.present) {
      map['content_type'] = Variable<String>(contentType.value);
    }
    if (contentHash.present) {
      map['content_hash'] = Variable<String>(contentHash.value);
    }
    if (uploadId.present) {
      map['upload_id'] = Variable<String>(uploadId.value);
    }
    if (partialFilePath.present) {
      map['partial_file_path'] = Variable<String>(partialFilePath.value);
    }
    if (downloadEtag.present) {
      map['download_etag'] = Variable<String>(downloadEtag.value);
    }
    if (downloadLastModified.present) {
      map['download_last_modified'] = Variable<String>(
        downloadLastModified.value,
      );
    }
    if (byteLength.present) {
      map['byte_length'] = Variable<int>(byteLength.value);
    }
    if (bytesTransferred.present) {
      map['bytes_transferred'] = Variable<int>(bytesTransferred.value);
    }
    if (totalBytes.present) {
      map['total_bytes'] = Variable<int>(totalBytes.value);
    }
    if (error.present) {
      map['error'] = Variable<String>(error.value);
    }
    if (message.present) {
      map['message'] = Variable<String>(message.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ArtifactTransferRowsCompanion(')
          ..write('id: $id, ')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('actionKey: $actionKey, ')
          ..write('fileName: $fileName, ')
          ..write('direction: $direction, ')
          ..write('status: $status, ')
          ..write('attemptCount: $attemptCount, ')
          ..write('artifactKey: $artifactKey, ')
          ..write('sourceUrl: $sourceUrl, ')
          ..write('cachedFilePath: $cachedFilePath, ')
          ..write('exportedPath: $exportedPath, ')
          ..write('contentType: $contentType, ')
          ..write('contentHash: $contentHash, ')
          ..write('uploadId: $uploadId, ')
          ..write('partialFilePath: $partialFilePath, ')
          ..write('downloadEtag: $downloadEtag, ')
          ..write('downloadLastModified: $downloadLastModified, ')
          ..write('byteLength: $byteLength, ')
          ..write('bytesTransferred: $bytesTransferred, ')
          ..write('totalBytes: $totalBytes, ')
          ..write('error: $error, ')
          ..write('message: $message, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $BrokerProfileRowsTable extends BrokerProfileRows
    with TableInfo<$BrokerProfileRowsTable, BrokerProfileRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $BrokerProfileRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _displayNameMeta = const VerificationMeta(
    'displayName',
  );
  @override
  late final GeneratedColumn<String> displayName = GeneratedColumn<String>(
    'display_name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _baseUriMeta = const VerificationMeta(
    'baseUri',
  );
  @override
  late final GeneratedColumn<String> baseUri = GeneratedColumn<String>(
    'base_uri',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _incarnationIdMeta = const VerificationMeta(
    'incarnationId',
  );
  @override
  late final GeneratedColumn<String> incarnationId = GeneratedColumn<String>(
    'incarnation_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastUsedAtMeta = const VerificationMeta(
    'lastUsedAt',
  );
  @override
  late final GeneratedColumn<DateTime> lastUsedAt = GeneratedColumn<DateTime>(
    'last_used_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _credentialKeyMeta = const VerificationMeta(
    'credentialKey',
  );
  @override
  late final GeneratedColumn<String> credentialKey = GeneratedColumn<String>(
    'credential_key',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    displayName,
    baseUri,
    createdAt,
    incarnationId,
    updatedAt,
    lastUsedAt,
    credentialKey,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'broker_profile_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<BrokerProfileRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('display_name')) {
      context.handle(
        _displayNameMeta,
        displayName.isAcceptableOrUnknown(
          data['display_name']!,
          _displayNameMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_displayNameMeta);
    }
    if (data.containsKey('base_uri')) {
      context.handle(
        _baseUriMeta,
        baseUri.isAcceptableOrUnknown(data['base_uri']!, _baseUriMeta),
      );
    } else if (isInserting) {
      context.missing(_baseUriMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('incarnation_id')) {
      context.handle(
        _incarnationIdMeta,
        incarnationId.isAcceptableOrUnknown(
          data['incarnation_id']!,
          _incarnationIdMeta,
        ),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    if (data.containsKey('last_used_at')) {
      context.handle(
        _lastUsedAtMeta,
        lastUsedAt.isAcceptableOrUnknown(
          data['last_used_at']!,
          _lastUsedAtMeta,
        ),
      );
    }
    if (data.containsKey('credential_key')) {
      context.handle(
        _credentialKeyMeta,
        credentialKey.isAcceptableOrUnknown(
          data['credential_key']!,
          _credentialKeyMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  BrokerProfileRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return BrokerProfileRow(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      displayName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}display_name'],
      )!,
      baseUri: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}base_uri'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      incarnationId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}incarnation_id'],
      ),
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      ),
      lastUsedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}last_used_at'],
      ),
      credentialKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}credential_key'],
      ),
    );
  }

  @override
  $BrokerProfileRowsTable createAlias(String alias) {
    return $BrokerProfileRowsTable(attachedDatabase, alias);
  }
}

class BrokerProfileRow extends DataClass
    implements Insertable<BrokerProfileRow> {
  /// Stable profile id.
  final String id;

  /// User-facing display name.
  final String displayName;

  /// Normalized broker base URI string.
  final String baseUri;

  /// Creation timestamp.
  final DateTime createdAt;

  /// Opaque saved-row generation, replaced after delete and re-add.
  final String? incarnationId;

  /// Last update timestamp.
  final DateTime? updatedAt;

  /// Last successful connection timestamp.
  final DateTime? lastUsedAt;

  /// Secure/runtime credential slot key.
  final String? credentialKey;
  const BrokerProfileRow({
    required this.id,
    required this.displayName,
    required this.baseUri,
    required this.createdAt,
    this.incarnationId,
    this.updatedAt,
    this.lastUsedAt,
    this.credentialKey,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['display_name'] = Variable<String>(displayName);
    map['base_uri'] = Variable<String>(baseUri);
    map['created_at'] = Variable<DateTime>(createdAt);
    if (!nullToAbsent || incarnationId != null) {
      map['incarnation_id'] = Variable<String>(incarnationId);
    }
    if (!nullToAbsent || updatedAt != null) {
      map['updated_at'] = Variable<DateTime>(updatedAt);
    }
    if (!nullToAbsent || lastUsedAt != null) {
      map['last_used_at'] = Variable<DateTime>(lastUsedAt);
    }
    if (!nullToAbsent || credentialKey != null) {
      map['credential_key'] = Variable<String>(credentialKey);
    }
    return map;
  }

  BrokerProfileRowsCompanion toCompanion(bool nullToAbsent) {
    return BrokerProfileRowsCompanion(
      id: Value(id),
      displayName: Value(displayName),
      baseUri: Value(baseUri),
      createdAt: Value(createdAt),
      incarnationId: incarnationId == null && nullToAbsent
          ? const Value.absent()
          : Value(incarnationId),
      updatedAt: updatedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(updatedAt),
      lastUsedAt: lastUsedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastUsedAt),
      credentialKey: credentialKey == null && nullToAbsent
          ? const Value.absent()
          : Value(credentialKey),
    );
  }

  factory BrokerProfileRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return BrokerProfileRow(
      id: serializer.fromJson<String>(json['id']),
      displayName: serializer.fromJson<String>(json['displayName']),
      baseUri: serializer.fromJson<String>(json['baseUri']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      incarnationId: serializer.fromJson<String?>(json['incarnationId']),
      updatedAt: serializer.fromJson<DateTime?>(json['updatedAt']),
      lastUsedAt: serializer.fromJson<DateTime?>(json['lastUsedAt']),
      credentialKey: serializer.fromJson<String?>(json['credentialKey']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'displayName': serializer.toJson<String>(displayName),
      'baseUri': serializer.toJson<String>(baseUri),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'incarnationId': serializer.toJson<String?>(incarnationId),
      'updatedAt': serializer.toJson<DateTime?>(updatedAt),
      'lastUsedAt': serializer.toJson<DateTime?>(lastUsedAt),
      'credentialKey': serializer.toJson<String?>(credentialKey),
    };
  }

  BrokerProfileRow copyWith({
    String? id,
    String? displayName,
    String? baseUri,
    DateTime? createdAt,
    Value<String?> incarnationId = const Value.absent(),
    Value<DateTime?> updatedAt = const Value.absent(),
    Value<DateTime?> lastUsedAt = const Value.absent(),
    Value<String?> credentialKey = const Value.absent(),
  }) => BrokerProfileRow(
    id: id ?? this.id,
    displayName: displayName ?? this.displayName,
    baseUri: baseUri ?? this.baseUri,
    createdAt: createdAt ?? this.createdAt,
    incarnationId: incarnationId.present
        ? incarnationId.value
        : this.incarnationId,
    updatedAt: updatedAt.present ? updatedAt.value : this.updatedAt,
    lastUsedAt: lastUsedAt.present ? lastUsedAt.value : this.lastUsedAt,
    credentialKey: credentialKey.present
        ? credentialKey.value
        : this.credentialKey,
  );
  BrokerProfileRow copyWithCompanion(BrokerProfileRowsCompanion data) {
    return BrokerProfileRow(
      id: data.id.present ? data.id.value : this.id,
      displayName: data.displayName.present
          ? data.displayName.value
          : this.displayName,
      baseUri: data.baseUri.present ? data.baseUri.value : this.baseUri,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      incarnationId: data.incarnationId.present
          ? data.incarnationId.value
          : this.incarnationId,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
      lastUsedAt: data.lastUsedAt.present
          ? data.lastUsedAt.value
          : this.lastUsedAt,
      credentialKey: data.credentialKey.present
          ? data.credentialKey.value
          : this.credentialKey,
    );
  }

  @override
  String toString() {
    return (StringBuffer('BrokerProfileRow(')
          ..write('id: $id, ')
          ..write('displayName: $displayName, ')
          ..write('baseUri: $baseUri, ')
          ..write('createdAt: $createdAt, ')
          ..write('incarnationId: $incarnationId, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('lastUsedAt: $lastUsedAt, ')
          ..write('credentialKey: $credentialKey')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    displayName,
    baseUri,
    createdAt,
    incarnationId,
    updatedAt,
    lastUsedAt,
    credentialKey,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is BrokerProfileRow &&
          other.id == this.id &&
          other.displayName == this.displayName &&
          other.baseUri == this.baseUri &&
          other.createdAt == this.createdAt &&
          other.incarnationId == this.incarnationId &&
          other.updatedAt == this.updatedAt &&
          other.lastUsedAt == this.lastUsedAt &&
          other.credentialKey == this.credentialKey);
}

class BrokerProfileRowsCompanion extends UpdateCompanion<BrokerProfileRow> {
  final Value<String> id;
  final Value<String> displayName;
  final Value<String> baseUri;
  final Value<DateTime> createdAt;
  final Value<String?> incarnationId;
  final Value<DateTime?> updatedAt;
  final Value<DateTime?> lastUsedAt;
  final Value<String?> credentialKey;
  final Value<int> rowid;
  const BrokerProfileRowsCompanion({
    this.id = const Value.absent(),
    this.displayName = const Value.absent(),
    this.baseUri = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.incarnationId = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.lastUsedAt = const Value.absent(),
    this.credentialKey = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  BrokerProfileRowsCompanion.insert({
    required String id,
    required String displayName,
    required String baseUri,
    required DateTime createdAt,
    this.incarnationId = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.lastUsedAt = const Value.absent(),
    this.credentialKey = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       displayName = Value(displayName),
       baseUri = Value(baseUri),
       createdAt = Value(createdAt);
  static Insertable<BrokerProfileRow> custom({
    Expression<String>? id,
    Expression<String>? displayName,
    Expression<String>? baseUri,
    Expression<DateTime>? createdAt,
    Expression<String>? incarnationId,
    Expression<DateTime>? updatedAt,
    Expression<DateTime>? lastUsedAt,
    Expression<String>? credentialKey,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (displayName != null) 'display_name': displayName,
      if (baseUri != null) 'base_uri': baseUri,
      if (createdAt != null) 'created_at': createdAt,
      if (incarnationId != null) 'incarnation_id': incarnationId,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (lastUsedAt != null) 'last_used_at': lastUsedAt,
      if (credentialKey != null) 'credential_key': credentialKey,
      if (rowid != null) 'rowid': rowid,
    });
  }

  BrokerProfileRowsCompanion copyWith({
    Value<String>? id,
    Value<String>? displayName,
    Value<String>? baseUri,
    Value<DateTime>? createdAt,
    Value<String?>? incarnationId,
    Value<DateTime?>? updatedAt,
    Value<DateTime?>? lastUsedAt,
    Value<String?>? credentialKey,
    Value<int>? rowid,
  }) {
    return BrokerProfileRowsCompanion(
      id: id ?? this.id,
      displayName: displayName ?? this.displayName,
      baseUri: baseUri ?? this.baseUri,
      createdAt: createdAt ?? this.createdAt,
      incarnationId: incarnationId ?? this.incarnationId,
      updatedAt: updatedAt ?? this.updatedAt,
      lastUsedAt: lastUsedAt ?? this.lastUsedAt,
      credentialKey: credentialKey ?? this.credentialKey,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (displayName.present) {
      map['display_name'] = Variable<String>(displayName.value);
    }
    if (baseUri.present) {
      map['base_uri'] = Variable<String>(baseUri.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (incarnationId.present) {
      map['incarnation_id'] = Variable<String>(incarnationId.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (lastUsedAt.present) {
      map['last_used_at'] = Variable<DateTime>(lastUsedAt.value);
    }
    if (credentialKey.present) {
      map['credential_key'] = Variable<String>(credentialKey.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('BrokerProfileRowsCompanion(')
          ..write('id: $id, ')
          ..write('displayName: $displayName, ')
          ..write('baseUri: $baseUri, ')
          ..write('createdAt: $createdAt, ')
          ..write('incarnationId: $incarnationId, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('lastUsedAt: $lastUsedAt, ')
          ..write('credentialKey: $credentialKey, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $AttentionEventRowsTable extends AttentionEventRows
    with TableInfo<$AttentionEventRowsTable, AttentionEventRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $AttentionEventRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _eventIdMeta = const VerificationMeta(
    'eventId',
  );
  @override
  late final GeneratedColumn<String> eventId = GeneratedColumn<String>(
    'event_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _cursorMeta = const VerificationMeta('cursor');
  @override
  late final GeneratedColumn<int> cursor = GeneratedColumn<int>(
    'cursor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _revisionMeta = const VerificationMeta(
    'revision',
  );
  @override
  late final GeneratedColumn<int> revision = GeneratedColumn<int>(
    'revision',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _presentationRevisionMeta =
      const VerificationMeta('presentationRevision');
  @override
  late final GeneratedColumn<int> presentationRevision = GeneratedColumn<int>(
    'presentation_revision',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _presentationStageMeta = const VerificationMeta(
    'presentationStage',
  );
  @override
  late final GeneratedColumn<String> presentationStage =
      GeneratedColumn<String>(
        'presentation_stage',
        aliasedName,
        true,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
      );
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
    'kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _stateMeta = const VerificationMeta('state');
  @override
  late final GeneratedColumn<String> state = GeneratedColumn<String>(
    'state',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _severityMeta = const VerificationMeta(
    'severity',
  );
  @override
  late final GeneratedColumn<String> severity = GeneratedColumn<String>(
    'severity',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _dedupeKeyMeta = const VerificationMeta(
    'dedupeKey',
  );
  @override
  late final GeneratedColumn<String> dedupeKey = GeneratedColumn<String>(
    'dedupe_key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _titleMeta = const VerificationMeta('title');
  @override
  late final GeneratedColumn<String> title = GeneratedColumn<String>(
    'title',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _summaryMeta = const VerificationMeta(
    'summary',
  );
  @override
  late final GeneratedColumn<String> summary = GeneratedColumn<String>(
    'summary',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sessionTitleMeta = const VerificationMeta(
    'sessionTitle',
  );
  @override
  late final GeneratedColumn<String> sessionTitle = GeneratedColumn<String>(
    'session_title',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _requestIdMeta = const VerificationMeta(
    'requestId',
  );
  @override
  late final GeneratedColumn<String> requestId = GeneratedColumn<String>(
    'request_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _turnIdMeta = const VerificationMeta('turnId');
  @override
  late final GeneratedColumn<String> turnId = GeneratedColumn<String>(
    'turn_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _goalKeyMeta = const VerificationMeta(
    'goalKey',
  );
  @override
  late final GeneratedColumn<String> goalKey = GeneratedColumn<String>(
    'goal_key',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _agentMeta = const VerificationMeta('agent');
  @override
  late final GeneratedColumn<String> agent = GeneratedColumn<String>(
    'agent',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _actionKindMeta = const VerificationMeta(
    'actionKind',
  );
  @override
  late final GeneratedColumn<String> actionKind = GeneratedColumn<String>(
    'action_kind',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _actionToolMeta = const VerificationMeta(
    'actionTool',
  );
  @override
  late final GeneratedColumn<String> actionTool = GeneratedColumn<String>(
    'action_tool',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _actionSessionIdMeta = const VerificationMeta(
    'actionSessionId',
  );
  @override
  late final GeneratedColumn<String> actionSessionId = GeneratedColumn<String>(
    'action_session_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _actionAgentMeta = const VerificationMeta(
    'actionAgent',
  );
  @override
  late final GeneratedColumn<String> actionAgent = GeneratedColumn<String>(
    'action_agent',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _brokerReadAtMeta = const VerificationMeta(
    'brokerReadAt',
  );
  @override
  late final GeneratedColumn<int> brokerReadAt = GeneratedColumn<int>(
    'broker_read_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _historicalBaselineMeta =
      const VerificationMeta('historicalBaseline');
  @override
  late final GeneratedColumn<bool> historicalBaseline = GeneratedColumn<bool>(
    'historical_baseline',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("historical_baseline" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _brokerDismissedAtMeta = const VerificationMeta(
    'brokerDismissedAt',
  );
  @override
  late final GeneratedColumn<int> brokerDismissedAt = GeneratedColumn<int>(
    'broker_dismissed_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<int> updatedAt = GeneratedColumn<int>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _resolvedAtMeta = const VerificationMeta(
    'resolvedAt',
  );
  @override
  late final GeneratedColumn<int> resolvedAt = GeneratedColumn<int>(
    'resolved_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _localReadAtMeta = const VerificationMeta(
    'localReadAt',
  );
  @override
  late final GeneratedColumn<int> localReadAt = GeneratedColumn<int>(
    'local_read_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _localDismissedAtMeta = const VerificationMeta(
    'localDismissedAt',
  );
  @override
  late final GeneratedColumn<int> localDismissedAt = GeneratedColumn<int>(
    'local_dismissed_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _localDismissedRevisionMeta =
      const VerificationMeta('localDismissedRevision');
  @override
  late final GeneratedColumn<int> localDismissedRevision = GeneratedColumn<int>(
    'local_dismissed_revision',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _localPresentedRevisionMeta =
      const VerificationMeta('localPresentedRevision');
  @override
  late final GeneratedColumn<int> localPresentedRevision = GeneratedColumn<int>(
    'local_presented_revision',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _rawEventJsonMeta = const VerificationMeta(
    'rawEventJson',
  );
  @override
  late final GeneratedColumn<String> rawEventJson = GeneratedColumn<String>(
    'raw_event_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _persistedAtMeta = const VerificationMeta(
    'persistedAt',
  );
  @override
  late final GeneratedColumn<DateTime> persistedAt = GeneratedColumn<DateTime>(
    'persisted_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    brokerProfileId,
    eventId,
    cursor,
    revision,
    presentationRevision,
    presentationStage,
    kind,
    state,
    severity,
    dedupeKey,
    title,
    summary,
    sessionId,
    sessionTitle,
    requestId,
    turnId,
    goalKey,
    agent,
    actionKind,
    actionTool,
    actionSessionId,
    actionAgent,
    brokerReadAt,
    historicalBaseline,
    brokerDismissedAt,
    createdAt,
    updatedAt,
    resolvedAt,
    localReadAt,
    localDismissedAt,
    localDismissedRevision,
    localPresentedRevision,
    rawEventJson,
    persistedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'attention_event_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<AttentionEventRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_brokerProfileIdMeta);
    }
    if (data.containsKey('event_id')) {
      context.handle(
        _eventIdMeta,
        eventId.isAcceptableOrUnknown(data['event_id']!, _eventIdMeta),
      );
    } else if (isInserting) {
      context.missing(_eventIdMeta);
    }
    if (data.containsKey('cursor')) {
      context.handle(
        _cursorMeta,
        cursor.isAcceptableOrUnknown(data['cursor']!, _cursorMeta),
      );
    } else if (isInserting) {
      context.missing(_cursorMeta);
    }
    if (data.containsKey('revision')) {
      context.handle(
        _revisionMeta,
        revision.isAcceptableOrUnknown(data['revision']!, _revisionMeta),
      );
    } else if (isInserting) {
      context.missing(_revisionMeta);
    }
    if (data.containsKey('presentation_revision')) {
      context.handle(
        _presentationRevisionMeta,
        presentationRevision.isAcceptableOrUnknown(
          data['presentation_revision']!,
          _presentationRevisionMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_presentationRevisionMeta);
    }
    if (data.containsKey('presentation_stage')) {
      context.handle(
        _presentationStageMeta,
        presentationStage.isAcceptableOrUnknown(
          data['presentation_stage']!,
          _presentationStageMeta,
        ),
      );
    }
    if (data.containsKey('kind')) {
      context.handle(
        _kindMeta,
        kind.isAcceptableOrUnknown(data['kind']!, _kindMeta),
      );
    } else if (isInserting) {
      context.missing(_kindMeta);
    }
    if (data.containsKey('state')) {
      context.handle(
        _stateMeta,
        state.isAcceptableOrUnknown(data['state']!, _stateMeta),
      );
    } else if (isInserting) {
      context.missing(_stateMeta);
    }
    if (data.containsKey('severity')) {
      context.handle(
        _severityMeta,
        severity.isAcceptableOrUnknown(data['severity']!, _severityMeta),
      );
    } else if (isInserting) {
      context.missing(_severityMeta);
    }
    if (data.containsKey('dedupe_key')) {
      context.handle(
        _dedupeKeyMeta,
        dedupeKey.isAcceptableOrUnknown(data['dedupe_key']!, _dedupeKeyMeta),
      );
    } else if (isInserting) {
      context.missing(_dedupeKeyMeta);
    }
    if (data.containsKey('title')) {
      context.handle(
        _titleMeta,
        title.isAcceptableOrUnknown(data['title']!, _titleMeta),
      );
    } else if (isInserting) {
      context.missing(_titleMeta);
    }
    if (data.containsKey('summary')) {
      context.handle(
        _summaryMeta,
        summary.isAcceptableOrUnknown(data['summary']!, _summaryMeta),
      );
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    }
    if (data.containsKey('session_title')) {
      context.handle(
        _sessionTitleMeta,
        sessionTitle.isAcceptableOrUnknown(
          data['session_title']!,
          _sessionTitleMeta,
        ),
      );
    }
    if (data.containsKey('request_id')) {
      context.handle(
        _requestIdMeta,
        requestId.isAcceptableOrUnknown(data['request_id']!, _requestIdMeta),
      );
    }
    if (data.containsKey('turn_id')) {
      context.handle(
        _turnIdMeta,
        turnId.isAcceptableOrUnknown(data['turn_id']!, _turnIdMeta),
      );
    }
    if (data.containsKey('goal_key')) {
      context.handle(
        _goalKeyMeta,
        goalKey.isAcceptableOrUnknown(data['goal_key']!, _goalKeyMeta),
      );
    }
    if (data.containsKey('agent')) {
      context.handle(
        _agentMeta,
        agent.isAcceptableOrUnknown(data['agent']!, _agentMeta),
      );
    }
    if (data.containsKey('action_kind')) {
      context.handle(
        _actionKindMeta,
        actionKind.isAcceptableOrUnknown(data['action_kind']!, _actionKindMeta),
      );
    }
    if (data.containsKey('action_tool')) {
      context.handle(
        _actionToolMeta,
        actionTool.isAcceptableOrUnknown(data['action_tool']!, _actionToolMeta),
      );
    }
    if (data.containsKey('action_session_id')) {
      context.handle(
        _actionSessionIdMeta,
        actionSessionId.isAcceptableOrUnknown(
          data['action_session_id']!,
          _actionSessionIdMeta,
        ),
      );
    }
    if (data.containsKey('action_agent')) {
      context.handle(
        _actionAgentMeta,
        actionAgent.isAcceptableOrUnknown(
          data['action_agent']!,
          _actionAgentMeta,
        ),
      );
    }
    if (data.containsKey('broker_read_at')) {
      context.handle(
        _brokerReadAtMeta,
        brokerReadAt.isAcceptableOrUnknown(
          data['broker_read_at']!,
          _brokerReadAtMeta,
        ),
      );
    }
    if (data.containsKey('historical_baseline')) {
      context.handle(
        _historicalBaselineMeta,
        historicalBaseline.isAcceptableOrUnknown(
          data['historical_baseline']!,
          _historicalBaselineMeta,
        ),
      );
    }
    if (data.containsKey('broker_dismissed_at')) {
      context.handle(
        _brokerDismissedAtMeta,
        brokerDismissedAt.isAcceptableOrUnknown(
          data['broker_dismissed_at']!,
          _brokerDismissedAtMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    if (data.containsKey('resolved_at')) {
      context.handle(
        _resolvedAtMeta,
        resolvedAt.isAcceptableOrUnknown(data['resolved_at']!, _resolvedAtMeta),
      );
    }
    if (data.containsKey('local_read_at')) {
      context.handle(
        _localReadAtMeta,
        localReadAt.isAcceptableOrUnknown(
          data['local_read_at']!,
          _localReadAtMeta,
        ),
      );
    }
    if (data.containsKey('local_dismissed_at')) {
      context.handle(
        _localDismissedAtMeta,
        localDismissedAt.isAcceptableOrUnknown(
          data['local_dismissed_at']!,
          _localDismissedAtMeta,
        ),
      );
    }
    if (data.containsKey('local_dismissed_revision')) {
      context.handle(
        _localDismissedRevisionMeta,
        localDismissedRevision.isAcceptableOrUnknown(
          data['local_dismissed_revision']!,
          _localDismissedRevisionMeta,
        ),
      );
    }
    if (data.containsKey('local_presented_revision')) {
      context.handle(
        _localPresentedRevisionMeta,
        localPresentedRevision.isAcceptableOrUnknown(
          data['local_presented_revision']!,
          _localPresentedRevisionMeta,
        ),
      );
    }
    if (data.containsKey('raw_event_json')) {
      context.handle(
        _rawEventJsonMeta,
        rawEventJson.isAcceptableOrUnknown(
          data['raw_event_json']!,
          _rawEventJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_rawEventJsonMeta);
    }
    if (data.containsKey('persisted_at')) {
      context.handle(
        _persistedAtMeta,
        persistedAt.isAcceptableOrUnknown(
          data['persisted_at']!,
          _persistedAtMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_persistedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {brokerProfileId, eventId};
  @override
  AttentionEventRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return AttentionEventRow(
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      )!,
      eventId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}event_id'],
      )!,
      cursor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}cursor'],
      )!,
      revision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}revision'],
      )!,
      presentationRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}presentation_revision'],
      )!,
      presentationStage: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}presentation_stage'],
      ),
      kind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}kind'],
      )!,
      state: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}state'],
      )!,
      severity: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}severity'],
      )!,
      dedupeKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}dedupe_key'],
      )!,
      title: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}title'],
      )!,
      summary: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}summary'],
      ),
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      ),
      sessionTitle: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_title'],
      ),
      requestId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}request_id'],
      ),
      turnId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}turn_id'],
      ),
      goalKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}goal_key'],
      ),
      agent: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}agent'],
      ),
      actionKind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}action_kind'],
      ),
      actionTool: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}action_tool'],
      ),
      actionSessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}action_session_id'],
      ),
      actionAgent: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}action_agent'],
      ),
      brokerReadAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}broker_read_at'],
      ),
      historicalBaseline: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}historical_baseline'],
      )!,
      brokerDismissedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}broker_dismissed_at'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}updated_at'],
      )!,
      resolvedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}resolved_at'],
      ),
      localReadAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}local_read_at'],
      ),
      localDismissedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}local_dismissed_at'],
      ),
      localDismissedRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}local_dismissed_revision'],
      ),
      localPresentedRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}local_presented_revision'],
      )!,
      rawEventJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}raw_event_json'],
      )!,
      persistedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}persisted_at'],
      )!,
    );
  }

  @override
  $AttentionEventRowsTable createAlias(String alias) {
    return $AttentionEventRowsTable(attachedDatabase, alias);
  }
}

class AttentionEventRow extends DataClass
    implements Insertable<AttentionEventRow> {
  /// Owning broker profile id.
  final String brokerProfileId;

  /// Stable event id from the broker.
  final String eventId;

  /// Broker paging cursor.
  final int cursor;

  /// Event revision.
  final int revision;

  /// Broker rendering revision.
  final int presentationRevision;

  /// Action-trigger stage for reminder/retry pipelines.
  final String? presentationStage;

  /// Event kind (non-exhaustive, forward-compatible).
  final String kind;

  /// Event lifecycle state.
  final String state;

  /// Event severity.
  final String severity;

  /// Stable dedupe key.
  final String dedupeKey;

  /// Event headline.
  final String title;

  /// Optional event details.
  final String? summary;

  /// Optional broker event scopes.
  final String? sessionId;

  /// Display-only session name captured with the broker event.
  final String? sessionTitle;

  /// Optional broker request identity.
  final String? requestId;

  /// Optional broker turn identity.
  final String? turnId;

  /// Optional broker goal identity.
  final String? goalKey;

  /// Optional broker agent/tool identity.
  final String? agent;

  /// Attention action kind.
  final String? actionKind;

  /// Optional action tool.
  final String? actionTool;

  /// Optional action session identity.
  final String? actionSessionId;

  /// Optional action agent identity.
  final String? actionAgent;

  /// Broker-side read/dismiss times.
  final int? brokerReadAt;

  /// Marks whether this event belongs to the first synced historical catch-up
  /// floor.
  final bool historicalBaseline;

  /// Broker-side dismiss time.
  final int? brokerDismissedAt;

  /// Broker event timestamps.
  final int createdAt;

  /// Broker event update timestamp.
  final int updatedAt;

  /// Broker event resolution timestamp.
  final int? resolvedAt;

  /// Local read/dismiss/presentation state.
  final int? localReadAt;

  /// Local event dismissal timestamp.
  final int? localDismissedAt;

  /// Exact event revision targeted by a bulk local dismissal.
  final int? localDismissedRevision;

  /// Greatest event presentation revision shown by this client.
  final int localPresentedRevision;

  /// Raw event payload for unknown future fields.
  final String rawEventJson;

  /// Last local persistence mutation.
  final DateTime persistedAt;
  const AttentionEventRow({
    required this.brokerProfileId,
    required this.eventId,
    required this.cursor,
    required this.revision,
    required this.presentationRevision,
    this.presentationStage,
    required this.kind,
    required this.state,
    required this.severity,
    required this.dedupeKey,
    required this.title,
    this.summary,
    this.sessionId,
    this.sessionTitle,
    this.requestId,
    this.turnId,
    this.goalKey,
    this.agent,
    this.actionKind,
    this.actionTool,
    this.actionSessionId,
    this.actionAgent,
    this.brokerReadAt,
    required this.historicalBaseline,
    this.brokerDismissedAt,
    required this.createdAt,
    required this.updatedAt,
    this.resolvedAt,
    this.localReadAt,
    this.localDismissedAt,
    this.localDismissedRevision,
    required this.localPresentedRevision,
    required this.rawEventJson,
    required this.persistedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['broker_profile_id'] = Variable<String>(brokerProfileId);
    map['event_id'] = Variable<String>(eventId);
    map['cursor'] = Variable<int>(cursor);
    map['revision'] = Variable<int>(revision);
    map['presentation_revision'] = Variable<int>(presentationRevision);
    if (!nullToAbsent || presentationStage != null) {
      map['presentation_stage'] = Variable<String>(presentationStage);
    }
    map['kind'] = Variable<String>(kind);
    map['state'] = Variable<String>(state);
    map['severity'] = Variable<String>(severity);
    map['dedupe_key'] = Variable<String>(dedupeKey);
    map['title'] = Variable<String>(title);
    if (!nullToAbsent || summary != null) {
      map['summary'] = Variable<String>(summary);
    }
    if (!nullToAbsent || sessionId != null) {
      map['session_id'] = Variable<String>(sessionId);
    }
    if (!nullToAbsent || sessionTitle != null) {
      map['session_title'] = Variable<String>(sessionTitle);
    }
    if (!nullToAbsent || requestId != null) {
      map['request_id'] = Variable<String>(requestId);
    }
    if (!nullToAbsent || turnId != null) {
      map['turn_id'] = Variable<String>(turnId);
    }
    if (!nullToAbsent || goalKey != null) {
      map['goal_key'] = Variable<String>(goalKey);
    }
    if (!nullToAbsent || agent != null) {
      map['agent'] = Variable<String>(agent);
    }
    if (!nullToAbsent || actionKind != null) {
      map['action_kind'] = Variable<String>(actionKind);
    }
    if (!nullToAbsent || actionTool != null) {
      map['action_tool'] = Variable<String>(actionTool);
    }
    if (!nullToAbsent || actionSessionId != null) {
      map['action_session_id'] = Variable<String>(actionSessionId);
    }
    if (!nullToAbsent || actionAgent != null) {
      map['action_agent'] = Variable<String>(actionAgent);
    }
    if (!nullToAbsent || brokerReadAt != null) {
      map['broker_read_at'] = Variable<int>(brokerReadAt);
    }
    map['historical_baseline'] = Variable<bool>(historicalBaseline);
    if (!nullToAbsent || brokerDismissedAt != null) {
      map['broker_dismissed_at'] = Variable<int>(brokerDismissedAt);
    }
    map['created_at'] = Variable<int>(createdAt);
    map['updated_at'] = Variable<int>(updatedAt);
    if (!nullToAbsent || resolvedAt != null) {
      map['resolved_at'] = Variable<int>(resolvedAt);
    }
    if (!nullToAbsent || localReadAt != null) {
      map['local_read_at'] = Variable<int>(localReadAt);
    }
    if (!nullToAbsent || localDismissedAt != null) {
      map['local_dismissed_at'] = Variable<int>(localDismissedAt);
    }
    if (!nullToAbsent || localDismissedRevision != null) {
      map['local_dismissed_revision'] = Variable<int>(localDismissedRevision);
    }
    map['local_presented_revision'] = Variable<int>(localPresentedRevision);
    map['raw_event_json'] = Variable<String>(rawEventJson);
    map['persisted_at'] = Variable<DateTime>(persistedAt);
    return map;
  }

  AttentionEventRowsCompanion toCompanion(bool nullToAbsent) {
    return AttentionEventRowsCompanion(
      brokerProfileId: Value(brokerProfileId),
      eventId: Value(eventId),
      cursor: Value(cursor),
      revision: Value(revision),
      presentationRevision: Value(presentationRevision),
      presentationStage: presentationStage == null && nullToAbsent
          ? const Value.absent()
          : Value(presentationStage),
      kind: Value(kind),
      state: Value(state),
      severity: Value(severity),
      dedupeKey: Value(dedupeKey),
      title: Value(title),
      summary: summary == null && nullToAbsent
          ? const Value.absent()
          : Value(summary),
      sessionId: sessionId == null && nullToAbsent
          ? const Value.absent()
          : Value(sessionId),
      sessionTitle: sessionTitle == null && nullToAbsent
          ? const Value.absent()
          : Value(sessionTitle),
      requestId: requestId == null && nullToAbsent
          ? const Value.absent()
          : Value(requestId),
      turnId: turnId == null && nullToAbsent
          ? const Value.absent()
          : Value(turnId),
      goalKey: goalKey == null && nullToAbsent
          ? const Value.absent()
          : Value(goalKey),
      agent: agent == null && nullToAbsent
          ? const Value.absent()
          : Value(agent),
      actionKind: actionKind == null && nullToAbsent
          ? const Value.absent()
          : Value(actionKind),
      actionTool: actionTool == null && nullToAbsent
          ? const Value.absent()
          : Value(actionTool),
      actionSessionId: actionSessionId == null && nullToAbsent
          ? const Value.absent()
          : Value(actionSessionId),
      actionAgent: actionAgent == null && nullToAbsent
          ? const Value.absent()
          : Value(actionAgent),
      brokerReadAt: brokerReadAt == null && nullToAbsent
          ? const Value.absent()
          : Value(brokerReadAt),
      historicalBaseline: Value(historicalBaseline),
      brokerDismissedAt: brokerDismissedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(brokerDismissedAt),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
      resolvedAt: resolvedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(resolvedAt),
      localReadAt: localReadAt == null && nullToAbsent
          ? const Value.absent()
          : Value(localReadAt),
      localDismissedAt: localDismissedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(localDismissedAt),
      localDismissedRevision: localDismissedRevision == null && nullToAbsent
          ? const Value.absent()
          : Value(localDismissedRevision),
      localPresentedRevision: Value(localPresentedRevision),
      rawEventJson: Value(rawEventJson),
      persistedAt: Value(persistedAt),
    );
  }

  factory AttentionEventRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return AttentionEventRow(
      brokerProfileId: serializer.fromJson<String>(json['brokerProfileId']),
      eventId: serializer.fromJson<String>(json['eventId']),
      cursor: serializer.fromJson<int>(json['cursor']),
      revision: serializer.fromJson<int>(json['revision']),
      presentationRevision: serializer.fromJson<int>(
        json['presentationRevision'],
      ),
      presentationStage: serializer.fromJson<String?>(
        json['presentationStage'],
      ),
      kind: serializer.fromJson<String>(json['kind']),
      state: serializer.fromJson<String>(json['state']),
      severity: serializer.fromJson<String>(json['severity']),
      dedupeKey: serializer.fromJson<String>(json['dedupeKey']),
      title: serializer.fromJson<String>(json['title']),
      summary: serializer.fromJson<String?>(json['summary']),
      sessionId: serializer.fromJson<String?>(json['sessionId']),
      sessionTitle: serializer.fromJson<String?>(json['sessionTitle']),
      requestId: serializer.fromJson<String?>(json['requestId']),
      turnId: serializer.fromJson<String?>(json['turnId']),
      goalKey: serializer.fromJson<String?>(json['goalKey']),
      agent: serializer.fromJson<String?>(json['agent']),
      actionKind: serializer.fromJson<String?>(json['actionKind']),
      actionTool: serializer.fromJson<String?>(json['actionTool']),
      actionSessionId: serializer.fromJson<String?>(json['actionSessionId']),
      actionAgent: serializer.fromJson<String?>(json['actionAgent']),
      brokerReadAt: serializer.fromJson<int?>(json['brokerReadAt']),
      historicalBaseline: serializer.fromJson<bool>(json['historicalBaseline']),
      brokerDismissedAt: serializer.fromJson<int?>(json['brokerDismissedAt']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
      updatedAt: serializer.fromJson<int>(json['updatedAt']),
      resolvedAt: serializer.fromJson<int?>(json['resolvedAt']),
      localReadAt: serializer.fromJson<int?>(json['localReadAt']),
      localDismissedAt: serializer.fromJson<int?>(json['localDismissedAt']),
      localDismissedRevision: serializer.fromJson<int?>(
        json['localDismissedRevision'],
      ),
      localPresentedRevision: serializer.fromJson<int>(
        json['localPresentedRevision'],
      ),
      rawEventJson: serializer.fromJson<String>(json['rawEventJson']),
      persistedAt: serializer.fromJson<DateTime>(json['persistedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'brokerProfileId': serializer.toJson<String>(brokerProfileId),
      'eventId': serializer.toJson<String>(eventId),
      'cursor': serializer.toJson<int>(cursor),
      'revision': serializer.toJson<int>(revision),
      'presentationRevision': serializer.toJson<int>(presentationRevision),
      'presentationStage': serializer.toJson<String?>(presentationStage),
      'kind': serializer.toJson<String>(kind),
      'state': serializer.toJson<String>(state),
      'severity': serializer.toJson<String>(severity),
      'dedupeKey': serializer.toJson<String>(dedupeKey),
      'title': serializer.toJson<String>(title),
      'summary': serializer.toJson<String?>(summary),
      'sessionId': serializer.toJson<String?>(sessionId),
      'sessionTitle': serializer.toJson<String?>(sessionTitle),
      'requestId': serializer.toJson<String?>(requestId),
      'turnId': serializer.toJson<String?>(turnId),
      'goalKey': serializer.toJson<String?>(goalKey),
      'agent': serializer.toJson<String?>(agent),
      'actionKind': serializer.toJson<String?>(actionKind),
      'actionTool': serializer.toJson<String?>(actionTool),
      'actionSessionId': serializer.toJson<String?>(actionSessionId),
      'actionAgent': serializer.toJson<String?>(actionAgent),
      'brokerReadAt': serializer.toJson<int?>(brokerReadAt),
      'historicalBaseline': serializer.toJson<bool>(historicalBaseline),
      'brokerDismissedAt': serializer.toJson<int?>(brokerDismissedAt),
      'createdAt': serializer.toJson<int>(createdAt),
      'updatedAt': serializer.toJson<int>(updatedAt),
      'resolvedAt': serializer.toJson<int?>(resolvedAt),
      'localReadAt': serializer.toJson<int?>(localReadAt),
      'localDismissedAt': serializer.toJson<int?>(localDismissedAt),
      'localDismissedRevision': serializer.toJson<int?>(localDismissedRevision),
      'localPresentedRevision': serializer.toJson<int>(localPresentedRevision),
      'rawEventJson': serializer.toJson<String>(rawEventJson),
      'persistedAt': serializer.toJson<DateTime>(persistedAt),
    };
  }

  AttentionEventRow copyWith({
    String? brokerProfileId,
    String? eventId,
    int? cursor,
    int? revision,
    int? presentationRevision,
    Value<String?> presentationStage = const Value.absent(),
    String? kind,
    String? state,
    String? severity,
    String? dedupeKey,
    String? title,
    Value<String?> summary = const Value.absent(),
    Value<String?> sessionId = const Value.absent(),
    Value<String?> sessionTitle = const Value.absent(),
    Value<String?> requestId = const Value.absent(),
    Value<String?> turnId = const Value.absent(),
    Value<String?> goalKey = const Value.absent(),
    Value<String?> agent = const Value.absent(),
    Value<String?> actionKind = const Value.absent(),
    Value<String?> actionTool = const Value.absent(),
    Value<String?> actionSessionId = const Value.absent(),
    Value<String?> actionAgent = const Value.absent(),
    Value<int?> brokerReadAt = const Value.absent(),
    bool? historicalBaseline,
    Value<int?> brokerDismissedAt = const Value.absent(),
    int? createdAt,
    int? updatedAt,
    Value<int?> resolvedAt = const Value.absent(),
    Value<int?> localReadAt = const Value.absent(),
    Value<int?> localDismissedAt = const Value.absent(),
    Value<int?> localDismissedRevision = const Value.absent(),
    int? localPresentedRevision,
    String? rawEventJson,
    DateTime? persistedAt,
  }) => AttentionEventRow(
    brokerProfileId: brokerProfileId ?? this.brokerProfileId,
    eventId: eventId ?? this.eventId,
    cursor: cursor ?? this.cursor,
    revision: revision ?? this.revision,
    presentationRevision: presentationRevision ?? this.presentationRevision,
    presentationStage: presentationStage.present
        ? presentationStage.value
        : this.presentationStage,
    kind: kind ?? this.kind,
    state: state ?? this.state,
    severity: severity ?? this.severity,
    dedupeKey: dedupeKey ?? this.dedupeKey,
    title: title ?? this.title,
    summary: summary.present ? summary.value : this.summary,
    sessionId: sessionId.present ? sessionId.value : this.sessionId,
    sessionTitle: sessionTitle.present ? sessionTitle.value : this.sessionTitle,
    requestId: requestId.present ? requestId.value : this.requestId,
    turnId: turnId.present ? turnId.value : this.turnId,
    goalKey: goalKey.present ? goalKey.value : this.goalKey,
    agent: agent.present ? agent.value : this.agent,
    actionKind: actionKind.present ? actionKind.value : this.actionKind,
    actionTool: actionTool.present ? actionTool.value : this.actionTool,
    actionSessionId: actionSessionId.present
        ? actionSessionId.value
        : this.actionSessionId,
    actionAgent: actionAgent.present ? actionAgent.value : this.actionAgent,
    brokerReadAt: brokerReadAt.present ? brokerReadAt.value : this.brokerReadAt,
    historicalBaseline: historicalBaseline ?? this.historicalBaseline,
    brokerDismissedAt: brokerDismissedAt.present
        ? brokerDismissedAt.value
        : this.brokerDismissedAt,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    resolvedAt: resolvedAt.present ? resolvedAt.value : this.resolvedAt,
    localReadAt: localReadAt.present ? localReadAt.value : this.localReadAt,
    localDismissedAt: localDismissedAt.present
        ? localDismissedAt.value
        : this.localDismissedAt,
    localDismissedRevision: localDismissedRevision.present
        ? localDismissedRevision.value
        : this.localDismissedRevision,
    localPresentedRevision:
        localPresentedRevision ?? this.localPresentedRevision,
    rawEventJson: rawEventJson ?? this.rawEventJson,
    persistedAt: persistedAt ?? this.persistedAt,
  );
  AttentionEventRow copyWithCompanion(AttentionEventRowsCompanion data) {
    return AttentionEventRow(
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      eventId: data.eventId.present ? data.eventId.value : this.eventId,
      cursor: data.cursor.present ? data.cursor.value : this.cursor,
      revision: data.revision.present ? data.revision.value : this.revision,
      presentationRevision: data.presentationRevision.present
          ? data.presentationRevision.value
          : this.presentationRevision,
      presentationStage: data.presentationStage.present
          ? data.presentationStage.value
          : this.presentationStage,
      kind: data.kind.present ? data.kind.value : this.kind,
      state: data.state.present ? data.state.value : this.state,
      severity: data.severity.present ? data.severity.value : this.severity,
      dedupeKey: data.dedupeKey.present ? data.dedupeKey.value : this.dedupeKey,
      title: data.title.present ? data.title.value : this.title,
      summary: data.summary.present ? data.summary.value : this.summary,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      sessionTitle: data.sessionTitle.present
          ? data.sessionTitle.value
          : this.sessionTitle,
      requestId: data.requestId.present ? data.requestId.value : this.requestId,
      turnId: data.turnId.present ? data.turnId.value : this.turnId,
      goalKey: data.goalKey.present ? data.goalKey.value : this.goalKey,
      agent: data.agent.present ? data.agent.value : this.agent,
      actionKind: data.actionKind.present
          ? data.actionKind.value
          : this.actionKind,
      actionTool: data.actionTool.present
          ? data.actionTool.value
          : this.actionTool,
      actionSessionId: data.actionSessionId.present
          ? data.actionSessionId.value
          : this.actionSessionId,
      actionAgent: data.actionAgent.present
          ? data.actionAgent.value
          : this.actionAgent,
      brokerReadAt: data.brokerReadAt.present
          ? data.brokerReadAt.value
          : this.brokerReadAt,
      historicalBaseline: data.historicalBaseline.present
          ? data.historicalBaseline.value
          : this.historicalBaseline,
      brokerDismissedAt: data.brokerDismissedAt.present
          ? data.brokerDismissedAt.value
          : this.brokerDismissedAt,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
      resolvedAt: data.resolvedAt.present
          ? data.resolvedAt.value
          : this.resolvedAt,
      localReadAt: data.localReadAt.present
          ? data.localReadAt.value
          : this.localReadAt,
      localDismissedAt: data.localDismissedAt.present
          ? data.localDismissedAt.value
          : this.localDismissedAt,
      localDismissedRevision: data.localDismissedRevision.present
          ? data.localDismissedRevision.value
          : this.localDismissedRevision,
      localPresentedRevision: data.localPresentedRevision.present
          ? data.localPresentedRevision.value
          : this.localPresentedRevision,
      rawEventJson: data.rawEventJson.present
          ? data.rawEventJson.value
          : this.rawEventJson,
      persistedAt: data.persistedAt.present
          ? data.persistedAt.value
          : this.persistedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('AttentionEventRow(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('eventId: $eventId, ')
          ..write('cursor: $cursor, ')
          ..write('revision: $revision, ')
          ..write('presentationRevision: $presentationRevision, ')
          ..write('presentationStage: $presentationStage, ')
          ..write('kind: $kind, ')
          ..write('state: $state, ')
          ..write('severity: $severity, ')
          ..write('dedupeKey: $dedupeKey, ')
          ..write('title: $title, ')
          ..write('summary: $summary, ')
          ..write('sessionId: $sessionId, ')
          ..write('sessionTitle: $sessionTitle, ')
          ..write('requestId: $requestId, ')
          ..write('turnId: $turnId, ')
          ..write('goalKey: $goalKey, ')
          ..write('agent: $agent, ')
          ..write('actionKind: $actionKind, ')
          ..write('actionTool: $actionTool, ')
          ..write('actionSessionId: $actionSessionId, ')
          ..write('actionAgent: $actionAgent, ')
          ..write('brokerReadAt: $brokerReadAt, ')
          ..write('historicalBaseline: $historicalBaseline, ')
          ..write('brokerDismissedAt: $brokerDismissedAt, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('resolvedAt: $resolvedAt, ')
          ..write('localReadAt: $localReadAt, ')
          ..write('localDismissedAt: $localDismissedAt, ')
          ..write('localDismissedRevision: $localDismissedRevision, ')
          ..write('localPresentedRevision: $localPresentedRevision, ')
          ..write('rawEventJson: $rawEventJson, ')
          ..write('persistedAt: $persistedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hashAll([
    brokerProfileId,
    eventId,
    cursor,
    revision,
    presentationRevision,
    presentationStage,
    kind,
    state,
    severity,
    dedupeKey,
    title,
    summary,
    sessionId,
    sessionTitle,
    requestId,
    turnId,
    goalKey,
    agent,
    actionKind,
    actionTool,
    actionSessionId,
    actionAgent,
    brokerReadAt,
    historicalBaseline,
    brokerDismissedAt,
    createdAt,
    updatedAt,
    resolvedAt,
    localReadAt,
    localDismissedAt,
    localDismissedRevision,
    localPresentedRevision,
    rawEventJson,
    persistedAt,
  ]);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is AttentionEventRow &&
          other.brokerProfileId == this.brokerProfileId &&
          other.eventId == this.eventId &&
          other.cursor == this.cursor &&
          other.revision == this.revision &&
          other.presentationRevision == this.presentationRevision &&
          other.presentationStage == this.presentationStage &&
          other.kind == this.kind &&
          other.state == this.state &&
          other.severity == this.severity &&
          other.dedupeKey == this.dedupeKey &&
          other.title == this.title &&
          other.summary == this.summary &&
          other.sessionId == this.sessionId &&
          other.sessionTitle == this.sessionTitle &&
          other.requestId == this.requestId &&
          other.turnId == this.turnId &&
          other.goalKey == this.goalKey &&
          other.agent == this.agent &&
          other.actionKind == this.actionKind &&
          other.actionTool == this.actionTool &&
          other.actionSessionId == this.actionSessionId &&
          other.actionAgent == this.actionAgent &&
          other.brokerReadAt == this.brokerReadAt &&
          other.historicalBaseline == this.historicalBaseline &&
          other.brokerDismissedAt == this.brokerDismissedAt &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt &&
          other.resolvedAt == this.resolvedAt &&
          other.localReadAt == this.localReadAt &&
          other.localDismissedAt == this.localDismissedAt &&
          other.localDismissedRevision == this.localDismissedRevision &&
          other.localPresentedRevision == this.localPresentedRevision &&
          other.rawEventJson == this.rawEventJson &&
          other.persistedAt == this.persistedAt);
}

class AttentionEventRowsCompanion extends UpdateCompanion<AttentionEventRow> {
  final Value<String> brokerProfileId;
  final Value<String> eventId;
  final Value<int> cursor;
  final Value<int> revision;
  final Value<int> presentationRevision;
  final Value<String?> presentationStage;
  final Value<String> kind;
  final Value<String> state;
  final Value<String> severity;
  final Value<String> dedupeKey;
  final Value<String> title;
  final Value<String?> summary;
  final Value<String?> sessionId;
  final Value<String?> sessionTitle;
  final Value<String?> requestId;
  final Value<String?> turnId;
  final Value<String?> goalKey;
  final Value<String?> agent;
  final Value<String?> actionKind;
  final Value<String?> actionTool;
  final Value<String?> actionSessionId;
  final Value<String?> actionAgent;
  final Value<int?> brokerReadAt;
  final Value<bool> historicalBaseline;
  final Value<int?> brokerDismissedAt;
  final Value<int> createdAt;
  final Value<int> updatedAt;
  final Value<int?> resolvedAt;
  final Value<int?> localReadAt;
  final Value<int?> localDismissedAt;
  final Value<int?> localDismissedRevision;
  final Value<int> localPresentedRevision;
  final Value<String> rawEventJson;
  final Value<DateTime> persistedAt;
  final Value<int> rowid;
  const AttentionEventRowsCompanion({
    this.brokerProfileId = const Value.absent(),
    this.eventId = const Value.absent(),
    this.cursor = const Value.absent(),
    this.revision = const Value.absent(),
    this.presentationRevision = const Value.absent(),
    this.presentationStage = const Value.absent(),
    this.kind = const Value.absent(),
    this.state = const Value.absent(),
    this.severity = const Value.absent(),
    this.dedupeKey = const Value.absent(),
    this.title = const Value.absent(),
    this.summary = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.sessionTitle = const Value.absent(),
    this.requestId = const Value.absent(),
    this.turnId = const Value.absent(),
    this.goalKey = const Value.absent(),
    this.agent = const Value.absent(),
    this.actionKind = const Value.absent(),
    this.actionTool = const Value.absent(),
    this.actionSessionId = const Value.absent(),
    this.actionAgent = const Value.absent(),
    this.brokerReadAt = const Value.absent(),
    this.historicalBaseline = const Value.absent(),
    this.brokerDismissedAt = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.resolvedAt = const Value.absent(),
    this.localReadAt = const Value.absent(),
    this.localDismissedAt = const Value.absent(),
    this.localDismissedRevision = const Value.absent(),
    this.localPresentedRevision = const Value.absent(),
    this.rawEventJson = const Value.absent(),
    this.persistedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  AttentionEventRowsCompanion.insert({
    required String brokerProfileId,
    required String eventId,
    required int cursor,
    required int revision,
    required int presentationRevision,
    this.presentationStage = const Value.absent(),
    required String kind,
    required String state,
    required String severity,
    required String dedupeKey,
    required String title,
    this.summary = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.sessionTitle = const Value.absent(),
    this.requestId = const Value.absent(),
    this.turnId = const Value.absent(),
    this.goalKey = const Value.absent(),
    this.agent = const Value.absent(),
    this.actionKind = const Value.absent(),
    this.actionTool = const Value.absent(),
    this.actionSessionId = const Value.absent(),
    this.actionAgent = const Value.absent(),
    this.brokerReadAt = const Value.absent(),
    this.historicalBaseline = const Value.absent(),
    this.brokerDismissedAt = const Value.absent(),
    required int createdAt,
    required int updatedAt,
    this.resolvedAt = const Value.absent(),
    this.localReadAt = const Value.absent(),
    this.localDismissedAt = const Value.absent(),
    this.localDismissedRevision = const Value.absent(),
    this.localPresentedRevision = const Value.absent(),
    required String rawEventJson,
    required DateTime persistedAt,
    this.rowid = const Value.absent(),
  }) : brokerProfileId = Value(brokerProfileId),
       eventId = Value(eventId),
       cursor = Value(cursor),
       revision = Value(revision),
       presentationRevision = Value(presentationRevision),
       kind = Value(kind),
       state = Value(state),
       severity = Value(severity),
       dedupeKey = Value(dedupeKey),
       title = Value(title),
       createdAt = Value(createdAt),
       updatedAt = Value(updatedAt),
       rawEventJson = Value(rawEventJson),
       persistedAt = Value(persistedAt);
  static Insertable<AttentionEventRow> custom({
    Expression<String>? brokerProfileId,
    Expression<String>? eventId,
    Expression<int>? cursor,
    Expression<int>? revision,
    Expression<int>? presentationRevision,
    Expression<String>? presentationStage,
    Expression<String>? kind,
    Expression<String>? state,
    Expression<String>? severity,
    Expression<String>? dedupeKey,
    Expression<String>? title,
    Expression<String>? summary,
    Expression<String>? sessionId,
    Expression<String>? sessionTitle,
    Expression<String>? requestId,
    Expression<String>? turnId,
    Expression<String>? goalKey,
    Expression<String>? agent,
    Expression<String>? actionKind,
    Expression<String>? actionTool,
    Expression<String>? actionSessionId,
    Expression<String>? actionAgent,
    Expression<int>? brokerReadAt,
    Expression<bool>? historicalBaseline,
    Expression<int>? brokerDismissedAt,
    Expression<int>? createdAt,
    Expression<int>? updatedAt,
    Expression<int>? resolvedAt,
    Expression<int>? localReadAt,
    Expression<int>? localDismissedAt,
    Expression<int>? localDismissedRevision,
    Expression<int>? localPresentedRevision,
    Expression<String>? rawEventJson,
    Expression<DateTime>? persistedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (eventId != null) 'event_id': eventId,
      if (cursor != null) 'cursor': cursor,
      if (revision != null) 'revision': revision,
      if (presentationRevision != null)
        'presentation_revision': presentationRevision,
      if (presentationStage != null) 'presentation_stage': presentationStage,
      if (kind != null) 'kind': kind,
      if (state != null) 'state': state,
      if (severity != null) 'severity': severity,
      if (dedupeKey != null) 'dedupe_key': dedupeKey,
      if (title != null) 'title': title,
      if (summary != null) 'summary': summary,
      if (sessionId != null) 'session_id': sessionId,
      if (sessionTitle != null) 'session_title': sessionTitle,
      if (requestId != null) 'request_id': requestId,
      if (turnId != null) 'turn_id': turnId,
      if (goalKey != null) 'goal_key': goalKey,
      if (agent != null) 'agent': agent,
      if (actionKind != null) 'action_kind': actionKind,
      if (actionTool != null) 'action_tool': actionTool,
      if (actionSessionId != null) 'action_session_id': actionSessionId,
      if (actionAgent != null) 'action_agent': actionAgent,
      if (brokerReadAt != null) 'broker_read_at': brokerReadAt,
      if (historicalBaseline != null) 'historical_baseline': historicalBaseline,
      if (brokerDismissedAt != null) 'broker_dismissed_at': brokerDismissedAt,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (resolvedAt != null) 'resolved_at': resolvedAt,
      if (localReadAt != null) 'local_read_at': localReadAt,
      if (localDismissedAt != null) 'local_dismissed_at': localDismissedAt,
      if (localDismissedRevision != null)
        'local_dismissed_revision': localDismissedRevision,
      if (localPresentedRevision != null)
        'local_presented_revision': localPresentedRevision,
      if (rawEventJson != null) 'raw_event_json': rawEventJson,
      if (persistedAt != null) 'persisted_at': persistedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  AttentionEventRowsCompanion copyWith({
    Value<String>? brokerProfileId,
    Value<String>? eventId,
    Value<int>? cursor,
    Value<int>? revision,
    Value<int>? presentationRevision,
    Value<String?>? presentationStage,
    Value<String>? kind,
    Value<String>? state,
    Value<String>? severity,
    Value<String>? dedupeKey,
    Value<String>? title,
    Value<String?>? summary,
    Value<String?>? sessionId,
    Value<String?>? sessionTitle,
    Value<String?>? requestId,
    Value<String?>? turnId,
    Value<String?>? goalKey,
    Value<String?>? agent,
    Value<String?>? actionKind,
    Value<String?>? actionTool,
    Value<String?>? actionSessionId,
    Value<String?>? actionAgent,
    Value<int?>? brokerReadAt,
    Value<bool>? historicalBaseline,
    Value<int?>? brokerDismissedAt,
    Value<int>? createdAt,
    Value<int>? updatedAt,
    Value<int?>? resolvedAt,
    Value<int?>? localReadAt,
    Value<int?>? localDismissedAt,
    Value<int?>? localDismissedRevision,
    Value<int>? localPresentedRevision,
    Value<String>? rawEventJson,
    Value<DateTime>? persistedAt,
    Value<int>? rowid,
  }) {
    return AttentionEventRowsCompanion(
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      eventId: eventId ?? this.eventId,
      cursor: cursor ?? this.cursor,
      revision: revision ?? this.revision,
      presentationRevision: presentationRevision ?? this.presentationRevision,
      presentationStage: presentationStage ?? this.presentationStage,
      kind: kind ?? this.kind,
      state: state ?? this.state,
      severity: severity ?? this.severity,
      dedupeKey: dedupeKey ?? this.dedupeKey,
      title: title ?? this.title,
      summary: summary ?? this.summary,
      sessionId: sessionId ?? this.sessionId,
      sessionTitle: sessionTitle ?? this.sessionTitle,
      requestId: requestId ?? this.requestId,
      turnId: turnId ?? this.turnId,
      goalKey: goalKey ?? this.goalKey,
      agent: agent ?? this.agent,
      actionKind: actionKind ?? this.actionKind,
      actionTool: actionTool ?? this.actionTool,
      actionSessionId: actionSessionId ?? this.actionSessionId,
      actionAgent: actionAgent ?? this.actionAgent,
      brokerReadAt: brokerReadAt ?? this.brokerReadAt,
      historicalBaseline: historicalBaseline ?? this.historicalBaseline,
      brokerDismissedAt: brokerDismissedAt ?? this.brokerDismissedAt,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      resolvedAt: resolvedAt ?? this.resolvedAt,
      localReadAt: localReadAt ?? this.localReadAt,
      localDismissedAt: localDismissedAt ?? this.localDismissedAt,
      localDismissedRevision:
          localDismissedRevision ?? this.localDismissedRevision,
      localPresentedRevision:
          localPresentedRevision ?? this.localPresentedRevision,
      rawEventJson: rawEventJson ?? this.rawEventJson,
      persistedAt: persistedAt ?? this.persistedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (eventId.present) {
      map['event_id'] = Variable<String>(eventId.value);
    }
    if (cursor.present) {
      map['cursor'] = Variable<int>(cursor.value);
    }
    if (revision.present) {
      map['revision'] = Variable<int>(revision.value);
    }
    if (presentationRevision.present) {
      map['presentation_revision'] = Variable<int>(presentationRevision.value);
    }
    if (presentationStage.present) {
      map['presentation_stage'] = Variable<String>(presentationStage.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (state.present) {
      map['state'] = Variable<String>(state.value);
    }
    if (severity.present) {
      map['severity'] = Variable<String>(severity.value);
    }
    if (dedupeKey.present) {
      map['dedupe_key'] = Variable<String>(dedupeKey.value);
    }
    if (title.present) {
      map['title'] = Variable<String>(title.value);
    }
    if (summary.present) {
      map['summary'] = Variable<String>(summary.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (sessionTitle.present) {
      map['session_title'] = Variable<String>(sessionTitle.value);
    }
    if (requestId.present) {
      map['request_id'] = Variable<String>(requestId.value);
    }
    if (turnId.present) {
      map['turn_id'] = Variable<String>(turnId.value);
    }
    if (goalKey.present) {
      map['goal_key'] = Variable<String>(goalKey.value);
    }
    if (agent.present) {
      map['agent'] = Variable<String>(agent.value);
    }
    if (actionKind.present) {
      map['action_kind'] = Variable<String>(actionKind.value);
    }
    if (actionTool.present) {
      map['action_tool'] = Variable<String>(actionTool.value);
    }
    if (actionSessionId.present) {
      map['action_session_id'] = Variable<String>(actionSessionId.value);
    }
    if (actionAgent.present) {
      map['action_agent'] = Variable<String>(actionAgent.value);
    }
    if (brokerReadAt.present) {
      map['broker_read_at'] = Variable<int>(brokerReadAt.value);
    }
    if (historicalBaseline.present) {
      map['historical_baseline'] = Variable<bool>(historicalBaseline.value);
    }
    if (brokerDismissedAt.present) {
      map['broker_dismissed_at'] = Variable<int>(brokerDismissedAt.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<int>(updatedAt.value);
    }
    if (resolvedAt.present) {
      map['resolved_at'] = Variable<int>(resolvedAt.value);
    }
    if (localReadAt.present) {
      map['local_read_at'] = Variable<int>(localReadAt.value);
    }
    if (localDismissedAt.present) {
      map['local_dismissed_at'] = Variable<int>(localDismissedAt.value);
    }
    if (localDismissedRevision.present) {
      map['local_dismissed_revision'] = Variable<int>(
        localDismissedRevision.value,
      );
    }
    if (localPresentedRevision.present) {
      map['local_presented_revision'] = Variable<int>(
        localPresentedRevision.value,
      );
    }
    if (rawEventJson.present) {
      map['raw_event_json'] = Variable<String>(rawEventJson.value);
    }
    if (persistedAt.present) {
      map['persisted_at'] = Variable<DateTime>(persistedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('AttentionEventRowsCompanion(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('eventId: $eventId, ')
          ..write('cursor: $cursor, ')
          ..write('revision: $revision, ')
          ..write('presentationRevision: $presentationRevision, ')
          ..write('presentationStage: $presentationStage, ')
          ..write('kind: $kind, ')
          ..write('state: $state, ')
          ..write('severity: $severity, ')
          ..write('dedupeKey: $dedupeKey, ')
          ..write('title: $title, ')
          ..write('summary: $summary, ')
          ..write('sessionId: $sessionId, ')
          ..write('sessionTitle: $sessionTitle, ')
          ..write('requestId: $requestId, ')
          ..write('turnId: $turnId, ')
          ..write('goalKey: $goalKey, ')
          ..write('agent: $agent, ')
          ..write('actionKind: $actionKind, ')
          ..write('actionTool: $actionTool, ')
          ..write('actionSessionId: $actionSessionId, ')
          ..write('actionAgent: $actionAgent, ')
          ..write('brokerReadAt: $brokerReadAt, ')
          ..write('historicalBaseline: $historicalBaseline, ')
          ..write('brokerDismissedAt: $brokerDismissedAt, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('resolvedAt: $resolvedAt, ')
          ..write('localReadAt: $localReadAt, ')
          ..write('localDismissedAt: $localDismissedAt, ')
          ..write('localDismissedRevision: $localDismissedRevision, ')
          ..write('localPresentedRevision: $localPresentedRevision, ')
          ..write('rawEventJson: $rawEventJson, ')
          ..write('persistedAt: $persistedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $AttentionCursorRowsTable extends AttentionCursorRows
    with TableInfo<$AttentionCursorRowsTable, AttentionCursorRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $AttentionCursorRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _cursorMeta = const VerificationMeta('cursor');
  @override
  late final GeneratedColumn<int> cursor = GeneratedColumn<int>(
    'cursor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _baselineThroughCursorMeta =
      const VerificationMeta('baselineThroughCursor');
  @override
  late final GeneratedColumn<int> baselineThroughCursor = GeneratedColumn<int>(
    'baseline_through_cursor',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _initialSyncCompleteMeta =
      const VerificationMeta('initialSyncComplete');
  @override
  late final GeneratedColumn<bool> initialSyncComplete = GeneratedColumn<bool>(
    'initial_sync_complete',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("initial_sync_complete" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _persistedAtMeta = const VerificationMeta(
    'persistedAt',
  );
  @override
  late final GeneratedColumn<DateTime> persistedAt = GeneratedColumn<DateTime>(
    'persisted_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    brokerProfileId,
    cursor,
    baselineThroughCursor,
    initialSyncComplete,
    persistedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'attention_cursor_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<AttentionCursorRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_brokerProfileIdMeta);
    }
    if (data.containsKey('cursor')) {
      context.handle(
        _cursorMeta,
        cursor.isAcceptableOrUnknown(data['cursor']!, _cursorMeta),
      );
    } else if (isInserting) {
      context.missing(_cursorMeta);
    }
    if (data.containsKey('baseline_through_cursor')) {
      context.handle(
        _baselineThroughCursorMeta,
        baselineThroughCursor.isAcceptableOrUnknown(
          data['baseline_through_cursor']!,
          _baselineThroughCursorMeta,
        ),
      );
    }
    if (data.containsKey('initial_sync_complete')) {
      context.handle(
        _initialSyncCompleteMeta,
        initialSyncComplete.isAcceptableOrUnknown(
          data['initial_sync_complete']!,
          _initialSyncCompleteMeta,
        ),
      );
    }
    if (data.containsKey('persisted_at')) {
      context.handle(
        _persistedAtMeta,
        persistedAt.isAcceptableOrUnknown(
          data['persisted_at']!,
          _persistedAtMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_persistedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {brokerProfileId};
  @override
  AttentionCursorRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return AttentionCursorRow(
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      )!,
      cursor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}cursor'],
      )!,
      baselineThroughCursor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}baseline_through_cursor'],
      ),
      initialSyncComplete: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}initial_sync_complete'],
      )!,
      persistedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}persisted_at'],
      )!,
    );
  }

  @override
  $AttentionCursorRowsTable createAlias(String alias) {
    return $AttentionCursorRowsTable(attachedDatabase, alias);
  }
}

class AttentionCursorRow extends DataClass
    implements Insertable<AttentionCursorRow> {
  /// Owning broker profile id.
  final String brokerProfileId;

  /// Last durable cursor returned by the broker.
  final int cursor;

  /// First non-null durable history floor retained for deterministic baseline.
  final int? baselineThroughCursor;

  /// Whether every page from the installation's initial catch-up is durable.
  final bool initialSyncComplete;

  /// Local storage mutation time.
  final DateTime persistedAt;
  const AttentionCursorRow({
    required this.brokerProfileId,
    required this.cursor,
    this.baselineThroughCursor,
    required this.initialSyncComplete,
    required this.persistedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['broker_profile_id'] = Variable<String>(brokerProfileId);
    map['cursor'] = Variable<int>(cursor);
    if (!nullToAbsent || baselineThroughCursor != null) {
      map['baseline_through_cursor'] = Variable<int>(baselineThroughCursor);
    }
    map['initial_sync_complete'] = Variable<bool>(initialSyncComplete);
    map['persisted_at'] = Variable<DateTime>(persistedAt);
    return map;
  }

  AttentionCursorRowsCompanion toCompanion(bool nullToAbsent) {
    return AttentionCursorRowsCompanion(
      brokerProfileId: Value(brokerProfileId),
      cursor: Value(cursor),
      baselineThroughCursor: baselineThroughCursor == null && nullToAbsent
          ? const Value.absent()
          : Value(baselineThroughCursor),
      initialSyncComplete: Value(initialSyncComplete),
      persistedAt: Value(persistedAt),
    );
  }

  factory AttentionCursorRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return AttentionCursorRow(
      brokerProfileId: serializer.fromJson<String>(json['brokerProfileId']),
      cursor: serializer.fromJson<int>(json['cursor']),
      baselineThroughCursor: serializer.fromJson<int?>(
        json['baselineThroughCursor'],
      ),
      initialSyncComplete: serializer.fromJson<bool>(
        json['initialSyncComplete'],
      ),
      persistedAt: serializer.fromJson<DateTime>(json['persistedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'brokerProfileId': serializer.toJson<String>(brokerProfileId),
      'cursor': serializer.toJson<int>(cursor),
      'baselineThroughCursor': serializer.toJson<int?>(baselineThroughCursor),
      'initialSyncComplete': serializer.toJson<bool>(initialSyncComplete),
      'persistedAt': serializer.toJson<DateTime>(persistedAt),
    };
  }

  AttentionCursorRow copyWith({
    String? brokerProfileId,
    int? cursor,
    Value<int?> baselineThroughCursor = const Value.absent(),
    bool? initialSyncComplete,
    DateTime? persistedAt,
  }) => AttentionCursorRow(
    brokerProfileId: brokerProfileId ?? this.brokerProfileId,
    cursor: cursor ?? this.cursor,
    baselineThroughCursor: baselineThroughCursor.present
        ? baselineThroughCursor.value
        : this.baselineThroughCursor,
    initialSyncComplete: initialSyncComplete ?? this.initialSyncComplete,
    persistedAt: persistedAt ?? this.persistedAt,
  );
  AttentionCursorRow copyWithCompanion(AttentionCursorRowsCompanion data) {
    return AttentionCursorRow(
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      cursor: data.cursor.present ? data.cursor.value : this.cursor,
      baselineThroughCursor: data.baselineThroughCursor.present
          ? data.baselineThroughCursor.value
          : this.baselineThroughCursor,
      initialSyncComplete: data.initialSyncComplete.present
          ? data.initialSyncComplete.value
          : this.initialSyncComplete,
      persistedAt: data.persistedAt.present
          ? data.persistedAt.value
          : this.persistedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('AttentionCursorRow(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('cursor: $cursor, ')
          ..write('baselineThroughCursor: $baselineThroughCursor, ')
          ..write('initialSyncComplete: $initialSyncComplete, ')
          ..write('persistedAt: $persistedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    brokerProfileId,
    cursor,
    baselineThroughCursor,
    initialSyncComplete,
    persistedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is AttentionCursorRow &&
          other.brokerProfileId == this.brokerProfileId &&
          other.cursor == this.cursor &&
          other.baselineThroughCursor == this.baselineThroughCursor &&
          other.initialSyncComplete == this.initialSyncComplete &&
          other.persistedAt == this.persistedAt);
}

class AttentionCursorRowsCompanion extends UpdateCompanion<AttentionCursorRow> {
  final Value<String> brokerProfileId;
  final Value<int> cursor;
  final Value<int?> baselineThroughCursor;
  final Value<bool> initialSyncComplete;
  final Value<DateTime> persistedAt;
  final Value<int> rowid;
  const AttentionCursorRowsCompanion({
    this.brokerProfileId = const Value.absent(),
    this.cursor = const Value.absent(),
    this.baselineThroughCursor = const Value.absent(),
    this.initialSyncComplete = const Value.absent(),
    this.persistedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  AttentionCursorRowsCompanion.insert({
    required String brokerProfileId,
    required int cursor,
    this.baselineThroughCursor = const Value.absent(),
    this.initialSyncComplete = const Value.absent(),
    required DateTime persistedAt,
    this.rowid = const Value.absent(),
  }) : brokerProfileId = Value(brokerProfileId),
       cursor = Value(cursor),
       persistedAt = Value(persistedAt);
  static Insertable<AttentionCursorRow> custom({
    Expression<String>? brokerProfileId,
    Expression<int>? cursor,
    Expression<int>? baselineThroughCursor,
    Expression<bool>? initialSyncComplete,
    Expression<DateTime>? persistedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (cursor != null) 'cursor': cursor,
      if (baselineThroughCursor != null)
        'baseline_through_cursor': baselineThroughCursor,
      if (initialSyncComplete != null)
        'initial_sync_complete': initialSyncComplete,
      if (persistedAt != null) 'persisted_at': persistedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  AttentionCursorRowsCompanion copyWith({
    Value<String>? brokerProfileId,
    Value<int>? cursor,
    Value<int?>? baselineThroughCursor,
    Value<bool>? initialSyncComplete,
    Value<DateTime>? persistedAt,
    Value<int>? rowid,
  }) {
    return AttentionCursorRowsCompanion(
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      cursor: cursor ?? this.cursor,
      baselineThroughCursor:
          baselineThroughCursor ?? this.baselineThroughCursor,
      initialSyncComplete: initialSyncComplete ?? this.initialSyncComplete,
      persistedAt: persistedAt ?? this.persistedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (cursor.present) {
      map['cursor'] = Variable<int>(cursor.value);
    }
    if (baselineThroughCursor.present) {
      map['baseline_through_cursor'] = Variable<int>(
        baselineThroughCursor.value,
      );
    }
    if (initialSyncComplete.present) {
      map['initial_sync_complete'] = Variable<bool>(initialSyncComplete.value);
    }
    if (persistedAt.present) {
      map['persisted_at'] = Variable<DateTime>(persistedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('AttentionCursorRowsCompanion(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('cursor: $cursor, ')
          ..write('baselineThroughCursor: $baselineThroughCursor, ')
          ..write('initialSyncComplete: $initialSyncComplete, ')
          ..write('persistedAt: $persistedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $AppSettingRowsTable extends AppSettingRows
    with TableInfo<$AppSettingRowsTable, AppSettingRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $AppSettingRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _keyMeta = const VerificationMeta('key');
  @override
  late final GeneratedColumn<String> key = GeneratedColumn<String>(
    'key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _valueMeta = const VerificationMeta('value');
  @override
  late final GeneratedColumn<String> value = GeneratedColumn<String>(
    'value',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [key, value, updatedAt];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'app_setting_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<AppSettingRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('key')) {
      context.handle(
        _keyMeta,
        key.isAcceptableOrUnknown(data['key']!, _keyMeta),
      );
    } else if (isInserting) {
      context.missing(_keyMeta);
    }
    if (data.containsKey('value')) {
      context.handle(
        _valueMeta,
        value.isAcceptableOrUnknown(data['value']!, _valueMeta),
      );
    } else if (isInserting) {
      context.missing(_valueMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {key};
  @override
  AppSettingRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return AppSettingRow(
      key: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}key'],
      )!,
      value: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}value'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $AppSettingRowsTable createAlias(String alias) {
    return $AppSettingRowsTable(attachedDatabase, alias);
  }
}

class AppSettingRow extends DataClass implements Insertable<AppSettingRow> {
  /// Unique setting key.
  final String key;

  /// Setting value.
  final String value;

  /// Timestamp when the setting was last updated.
  final DateTime updatedAt;
  const AppSettingRow({
    required this.key,
    required this.value,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['key'] = Variable<String>(key);
    map['value'] = Variable<String>(value);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  AppSettingRowsCompanion toCompanion(bool nullToAbsent) {
    return AppSettingRowsCompanion(
      key: Value(key),
      value: Value(value),
      updatedAt: Value(updatedAt),
    );
  }

  factory AppSettingRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return AppSettingRow(
      key: serializer.fromJson<String>(json['key']),
      value: serializer.fromJson<String>(json['value']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'key': serializer.toJson<String>(key),
      'value': serializer.toJson<String>(value),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  AppSettingRow copyWith({String? key, String? value, DateTime? updatedAt}) =>
      AppSettingRow(
        key: key ?? this.key,
        value: value ?? this.value,
        updatedAt: updatedAt ?? this.updatedAt,
      );
  AppSettingRow copyWithCompanion(AppSettingRowsCompanion data) {
    return AppSettingRow(
      key: data.key.present ? data.key.value : this.key,
      value: data.value.present ? data.value.value : this.value,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('AppSettingRow(')
          ..write('key: $key, ')
          ..write('value: $value, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(key, value, updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is AppSettingRow &&
          other.key == this.key &&
          other.value == this.value &&
          other.updatedAt == this.updatedAt);
}

class AppSettingRowsCompanion extends UpdateCompanion<AppSettingRow> {
  final Value<String> key;
  final Value<String> value;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const AppSettingRowsCompanion({
    this.key = const Value.absent(),
    this.value = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  AppSettingRowsCompanion.insert({
    required String key,
    required String value,
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : key = Value(key),
       value = Value(value),
       updatedAt = Value(updatedAt);
  static Insertable<AppSettingRow> custom({
    Expression<String>? key,
    Expression<String>? value,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (key != null) 'key': key,
      if (value != null) 'value': value,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  AppSettingRowsCompanion copyWith({
    Value<String>? key,
    Value<String>? value,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return AppSettingRowsCompanion(
      key: key ?? this.key,
      value: value ?? this.value,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (key.present) {
      map['key'] = Variable<String>(key.value);
    }
    if (value.present) {
      map['value'] = Variable<String>(value.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('AppSettingRowsCompanion(')
          ..write('key: $key, ')
          ..write('value: $value, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SessionOutboxRowsTable extends SessionOutboxRows
    with TableInfo<$SessionOutboxRowsTable, SessionOutboxRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionOutboxRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _clientMessageIdMeta = const VerificationMeta(
    'clientMessageId',
  );
  @override
  late final GeneratedColumn<String> clientMessageId = GeneratedColumn<String>(
    'client_message_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _toolMeta = const VerificationMeta('tool');
  @override
  late final GeneratedColumn<String> tool = GeneratedColumn<String>(
    'tool',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
    'kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadJsonMeta = const VerificationMeta(
    'payloadJson',
  );
  @override
  late final GeneratedColumn<String> payloadJson = GeneratedColumn<String>(
    'payload_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _attemptCountMeta = const VerificationMeta(
    'attemptCount',
  );
  @override
  late final GeneratedColumn<int> attemptCount = GeneratedColumn<int>(
    'attempt_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _lastErrorMeta = const VerificationMeta(
    'lastError',
  );
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
    'last_error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    clientMessageId,
    brokerProfileId,
    tool,
    sessionId,
    kind,
    payloadJson,
    status,
    attemptCount,
    lastError,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_outbox_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionOutboxRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('client_message_id')) {
      context.handle(
        _clientMessageIdMeta,
        clientMessageId.isAcceptableOrUnknown(
          data['client_message_id']!,
          _clientMessageIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_clientMessageIdMeta);
    }
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    }
    if (data.containsKey('tool')) {
      context.handle(
        _toolMeta,
        tool.isAcceptableOrUnknown(data['tool']!, _toolMeta),
      );
    } else if (isInserting) {
      context.missing(_toolMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('kind')) {
      context.handle(
        _kindMeta,
        kind.isAcceptableOrUnknown(data['kind']!, _kindMeta),
      );
    } else if (isInserting) {
      context.missing(_kindMeta);
    }
    if (data.containsKey('payload_json')) {
      context.handle(
        _payloadJsonMeta,
        payloadJson.isAcceptableOrUnknown(
          data['payload_json']!,
          _payloadJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadJsonMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    } else if (isInserting) {
      context.missing(_statusMeta);
    }
    if (data.containsKey('attempt_count')) {
      context.handle(
        _attemptCountMeta,
        attemptCount.isAcceptableOrUnknown(
          data['attempt_count']!,
          _attemptCountMeta,
        ),
      );
    }
    if (data.containsKey('last_error')) {
      context.handle(
        _lastErrorMeta,
        lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {clientMessageId};
  @override
  SessionOutboxRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionOutboxRow(
      clientMessageId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}client_message_id'],
      )!,
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      ),
      tool: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tool'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      kind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}kind'],
      )!,
      payloadJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload_json'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      attemptCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempt_count'],
      )!,
      lastError: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $SessionOutboxRowsTable createAlias(String alias) {
    return $SessionOutboxRowsTable(attachedDatabase, alias);
  }
}

class SessionOutboxRow extends DataClass
    implements Insertable<SessionOutboxRow> {
  /// Stable broker client message id.
  final String clientMessageId;

  /// Owning broker profile. Null is reserved for pre-v12 legacy rows.
  final String? brokerProfileId;

  /// Owning broker tool key.
  final String tool;

  /// Owning broker session id.
  final String sessionId;

  /// Outbound message kind enum name.
  final String kind;

  /// JSON payload needed to replay the message.
  final String payloadJson;

  /// Outbox status enum name.
  final String status;

  /// Number of transport send attempts.
  final int attemptCount;

  /// Last transport or broker error, when any.
  final String? lastError;

  /// Creation timestamp.
  final DateTime createdAt;

  /// Last mutation timestamp.
  final DateTime updatedAt;
  const SessionOutboxRow({
    required this.clientMessageId,
    this.brokerProfileId,
    required this.tool,
    required this.sessionId,
    required this.kind,
    required this.payloadJson,
    required this.status,
    required this.attemptCount,
    this.lastError,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['client_message_id'] = Variable<String>(clientMessageId);
    if (!nullToAbsent || brokerProfileId != null) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId);
    }
    map['tool'] = Variable<String>(tool);
    map['session_id'] = Variable<String>(sessionId);
    map['kind'] = Variable<String>(kind);
    map['payload_json'] = Variable<String>(payloadJson);
    map['status'] = Variable<String>(status);
    map['attempt_count'] = Variable<int>(attemptCount);
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  SessionOutboxRowsCompanion toCompanion(bool nullToAbsent) {
    return SessionOutboxRowsCompanion(
      clientMessageId: Value(clientMessageId),
      brokerProfileId: brokerProfileId == null && nullToAbsent
          ? const Value.absent()
          : Value(brokerProfileId),
      tool: Value(tool),
      sessionId: Value(sessionId),
      kind: Value(kind),
      payloadJson: Value(payloadJson),
      status: Value(status),
      attemptCount: Value(attemptCount),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory SessionOutboxRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionOutboxRow(
      clientMessageId: serializer.fromJson<String>(json['clientMessageId']),
      brokerProfileId: serializer.fromJson<String?>(json['brokerProfileId']),
      tool: serializer.fromJson<String>(json['tool']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      kind: serializer.fromJson<String>(json['kind']),
      payloadJson: serializer.fromJson<String>(json['payloadJson']),
      status: serializer.fromJson<String>(json['status']),
      attemptCount: serializer.fromJson<int>(json['attemptCount']),
      lastError: serializer.fromJson<String?>(json['lastError']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'clientMessageId': serializer.toJson<String>(clientMessageId),
      'brokerProfileId': serializer.toJson<String?>(brokerProfileId),
      'tool': serializer.toJson<String>(tool),
      'sessionId': serializer.toJson<String>(sessionId),
      'kind': serializer.toJson<String>(kind),
      'payloadJson': serializer.toJson<String>(payloadJson),
      'status': serializer.toJson<String>(status),
      'attemptCount': serializer.toJson<int>(attemptCount),
      'lastError': serializer.toJson<String?>(lastError),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  SessionOutboxRow copyWith({
    String? clientMessageId,
    Value<String?> brokerProfileId = const Value.absent(),
    String? tool,
    String? sessionId,
    String? kind,
    String? payloadJson,
    String? status,
    int? attemptCount,
    Value<String?> lastError = const Value.absent(),
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => SessionOutboxRow(
    clientMessageId: clientMessageId ?? this.clientMessageId,
    brokerProfileId: brokerProfileId.present
        ? brokerProfileId.value
        : this.brokerProfileId,
    tool: tool ?? this.tool,
    sessionId: sessionId ?? this.sessionId,
    kind: kind ?? this.kind,
    payloadJson: payloadJson ?? this.payloadJson,
    status: status ?? this.status,
    attemptCount: attemptCount ?? this.attemptCount,
    lastError: lastError.present ? lastError.value : this.lastError,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  SessionOutboxRow copyWithCompanion(SessionOutboxRowsCompanion data) {
    return SessionOutboxRow(
      clientMessageId: data.clientMessageId.present
          ? data.clientMessageId.value
          : this.clientMessageId,
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      tool: data.tool.present ? data.tool.value : this.tool,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      kind: data.kind.present ? data.kind.value : this.kind,
      payloadJson: data.payloadJson.present
          ? data.payloadJson.value
          : this.payloadJson,
      status: data.status.present ? data.status.value : this.status,
      attemptCount: data.attemptCount.present
          ? data.attemptCount.value
          : this.attemptCount,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionOutboxRow(')
          ..write('clientMessageId: $clientMessageId, ')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('kind: $kind, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('status: $status, ')
          ..write('attemptCount: $attemptCount, ')
          ..write('lastError: $lastError, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    clientMessageId,
    brokerProfileId,
    tool,
    sessionId,
    kind,
    payloadJson,
    status,
    attemptCount,
    lastError,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionOutboxRow &&
          other.clientMessageId == this.clientMessageId &&
          other.brokerProfileId == this.brokerProfileId &&
          other.tool == this.tool &&
          other.sessionId == this.sessionId &&
          other.kind == this.kind &&
          other.payloadJson == this.payloadJson &&
          other.status == this.status &&
          other.attemptCount == this.attemptCount &&
          other.lastError == this.lastError &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class SessionOutboxRowsCompanion extends UpdateCompanion<SessionOutboxRow> {
  final Value<String> clientMessageId;
  final Value<String?> brokerProfileId;
  final Value<String> tool;
  final Value<String> sessionId;
  final Value<String> kind;
  final Value<String> payloadJson;
  final Value<String> status;
  final Value<int> attemptCount;
  final Value<String?> lastError;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const SessionOutboxRowsCompanion({
    this.clientMessageId = const Value.absent(),
    this.brokerProfileId = const Value.absent(),
    this.tool = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.kind = const Value.absent(),
    this.payloadJson = const Value.absent(),
    this.status = const Value.absent(),
    this.attemptCount = const Value.absent(),
    this.lastError = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionOutboxRowsCompanion.insert({
    required String clientMessageId,
    this.brokerProfileId = const Value.absent(),
    required String tool,
    required String sessionId,
    required String kind,
    required String payloadJson,
    required String status,
    this.attemptCount = const Value.absent(),
    this.lastError = const Value.absent(),
    required DateTime createdAt,
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : clientMessageId = Value(clientMessageId),
       tool = Value(tool),
       sessionId = Value(sessionId),
       kind = Value(kind),
       payloadJson = Value(payloadJson),
       status = Value(status),
       createdAt = Value(createdAt),
       updatedAt = Value(updatedAt);
  static Insertable<SessionOutboxRow> custom({
    Expression<String>? clientMessageId,
    Expression<String>? brokerProfileId,
    Expression<String>? tool,
    Expression<String>? sessionId,
    Expression<String>? kind,
    Expression<String>? payloadJson,
    Expression<String>? status,
    Expression<int>? attemptCount,
    Expression<String>? lastError,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (clientMessageId != null) 'client_message_id': clientMessageId,
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (tool != null) 'tool': tool,
      if (sessionId != null) 'session_id': sessionId,
      if (kind != null) 'kind': kind,
      if (payloadJson != null) 'payload_json': payloadJson,
      if (status != null) 'status': status,
      if (attemptCount != null) 'attempt_count': attemptCount,
      if (lastError != null) 'last_error': lastError,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionOutboxRowsCompanion copyWith({
    Value<String>? clientMessageId,
    Value<String?>? brokerProfileId,
    Value<String>? tool,
    Value<String>? sessionId,
    Value<String>? kind,
    Value<String>? payloadJson,
    Value<String>? status,
    Value<int>? attemptCount,
    Value<String?>? lastError,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return SessionOutboxRowsCompanion(
      clientMessageId: clientMessageId ?? this.clientMessageId,
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      tool: tool ?? this.tool,
      sessionId: sessionId ?? this.sessionId,
      kind: kind ?? this.kind,
      payloadJson: payloadJson ?? this.payloadJson,
      status: status ?? this.status,
      attemptCount: attemptCount ?? this.attemptCount,
      lastError: lastError ?? this.lastError,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (clientMessageId.present) {
      map['client_message_id'] = Variable<String>(clientMessageId.value);
    }
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (tool.present) {
      map['tool'] = Variable<String>(tool.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (payloadJson.present) {
      map['payload_json'] = Variable<String>(payloadJson.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (attemptCount.present) {
      map['attempt_count'] = Variable<int>(attemptCount.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionOutboxRowsCompanion(')
          ..write('clientMessageId: $clientMessageId, ')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('kind: $kind, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('status: $status, ')
          ..write('attemptCount: $attemptCount, ')
          ..write('lastError: $lastError, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SessionTranscriptRowsTable extends SessionTranscriptRows
    with TableInfo<$SessionTranscriptRowsTable, SessionTranscriptRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionTranscriptRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _toolMeta = const VerificationMeta('tool');
  @override
  late final GeneratedColumn<String> tool = GeneratedColumn<String>(
    'tool',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _messagesJsonMeta = const VerificationMeta(
    'messagesJson',
  );
  @override
  late final GeneratedColumn<String> messagesJson = GeneratedColumn<String>(
    'messages_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _cursorMeta = const VerificationMeta('cursor');
  @override
  late final GeneratedColumn<String> cursor = GeneratedColumn<String>(
    'cursor',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _olderCursorMeta = const VerificationMeta(
    'olderCursor',
  );
  @override
  late final GeneratedColumn<String> olderCursor = GeneratedColumn<String>(
    'older_cursor',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _hasEarlierMeta = const VerificationMeta(
    'hasEarlier',
  );
  @override
  late final GeneratedColumn<bool> hasEarlier = GeneratedColumn<bool>(
    'has_earlier',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("has_earlier" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _gapJsonMeta = const VerificationMeta(
    'gapJson',
  );
  @override
  late final GeneratedColumn<String> gapJson = GeneratedColumn<String>(
    'gap_json',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _truncationJsonMeta = const VerificationMeta(
    'truncationJson',
  );
  @override
  late final GeneratedColumn<String> truncationJson = GeneratedColumn<String>(
    'truncation_json',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    brokerProfileId,
    tool,
    sessionId,
    messagesJson,
    cursor,
    olderCursor,
    hasEarlier,
    gapJson,
    truncationJson,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_transcript_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionTranscriptRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_brokerProfileIdMeta);
    }
    if (data.containsKey('tool')) {
      context.handle(
        _toolMeta,
        tool.isAcceptableOrUnknown(data['tool']!, _toolMeta),
      );
    } else if (isInserting) {
      context.missing(_toolMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('messages_json')) {
      context.handle(
        _messagesJsonMeta,
        messagesJson.isAcceptableOrUnknown(
          data['messages_json']!,
          _messagesJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_messagesJsonMeta);
    }
    if (data.containsKey('cursor')) {
      context.handle(
        _cursorMeta,
        cursor.isAcceptableOrUnknown(data['cursor']!, _cursorMeta),
      );
    }
    if (data.containsKey('older_cursor')) {
      context.handle(
        _olderCursorMeta,
        olderCursor.isAcceptableOrUnknown(
          data['older_cursor']!,
          _olderCursorMeta,
        ),
      );
    }
    if (data.containsKey('has_earlier')) {
      context.handle(
        _hasEarlierMeta,
        hasEarlier.isAcceptableOrUnknown(data['has_earlier']!, _hasEarlierMeta),
      );
    }
    if (data.containsKey('gap_json')) {
      context.handle(
        _gapJsonMeta,
        gapJson.isAcceptableOrUnknown(data['gap_json']!, _gapJsonMeta),
      );
    }
    if (data.containsKey('truncation_json')) {
      context.handle(
        _truncationJsonMeta,
        truncationJson.isAcceptableOrUnknown(
          data['truncation_json']!,
          _truncationJsonMeta,
        ),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {brokerProfileId, tool, sessionId};
  @override
  SessionTranscriptRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionTranscriptRow(
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      )!,
      tool: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tool'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      messagesJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}messages_json'],
      )!,
      cursor: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}cursor'],
      ),
      olderCursor: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}older_cursor'],
      ),
      hasEarlier: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}has_earlier'],
      )!,
      gapJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}gap_json'],
      ),
      truncationJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}truncation_json'],
      ),
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $SessionTranscriptRowsTable createAlias(String alias) {
    return $SessionTranscriptRowsTable(attachedDatabase, alias);
  }
}

class SessionTranscriptRow extends DataClass
    implements Insertable<SessionTranscriptRow> {
  /// Owning broker profile, preventing cross-profile transcript leakage.
  final String brokerProfileId;

  /// Broker tool key.
  final String tool;

  /// Broker session id.
  final String sessionId;

  /// Canonical reduced messages as JSON.
  final String messagesJson;

  /// Latest reconnect cursor committed with [messagesJson].
  final String? cursor;

  /// Cursor for the next older page.
  final String? olderCursor;

  /// Whether another retained older page exists.
  final bool hasEarlier;

  /// Latest honest gap metadata as JSON.
  final String? gapJson;

  /// Latest tail-window metadata as JSON.
  final String? truncationJson;

  /// Last successful local transcript transaction.
  final DateTime updatedAt;
  const SessionTranscriptRow({
    required this.brokerProfileId,
    required this.tool,
    required this.sessionId,
    required this.messagesJson,
    this.cursor,
    this.olderCursor,
    required this.hasEarlier,
    this.gapJson,
    this.truncationJson,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['broker_profile_id'] = Variable<String>(brokerProfileId);
    map['tool'] = Variable<String>(tool);
    map['session_id'] = Variable<String>(sessionId);
    map['messages_json'] = Variable<String>(messagesJson);
    if (!nullToAbsent || cursor != null) {
      map['cursor'] = Variable<String>(cursor);
    }
    if (!nullToAbsent || olderCursor != null) {
      map['older_cursor'] = Variable<String>(olderCursor);
    }
    map['has_earlier'] = Variable<bool>(hasEarlier);
    if (!nullToAbsent || gapJson != null) {
      map['gap_json'] = Variable<String>(gapJson);
    }
    if (!nullToAbsent || truncationJson != null) {
      map['truncation_json'] = Variable<String>(truncationJson);
    }
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  SessionTranscriptRowsCompanion toCompanion(bool nullToAbsent) {
    return SessionTranscriptRowsCompanion(
      brokerProfileId: Value(brokerProfileId),
      tool: Value(tool),
      sessionId: Value(sessionId),
      messagesJson: Value(messagesJson),
      cursor: cursor == null && nullToAbsent
          ? const Value.absent()
          : Value(cursor),
      olderCursor: olderCursor == null && nullToAbsent
          ? const Value.absent()
          : Value(olderCursor),
      hasEarlier: Value(hasEarlier),
      gapJson: gapJson == null && nullToAbsent
          ? const Value.absent()
          : Value(gapJson),
      truncationJson: truncationJson == null && nullToAbsent
          ? const Value.absent()
          : Value(truncationJson),
      updatedAt: Value(updatedAt),
    );
  }

  factory SessionTranscriptRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionTranscriptRow(
      brokerProfileId: serializer.fromJson<String>(json['brokerProfileId']),
      tool: serializer.fromJson<String>(json['tool']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      messagesJson: serializer.fromJson<String>(json['messagesJson']),
      cursor: serializer.fromJson<String?>(json['cursor']),
      olderCursor: serializer.fromJson<String?>(json['olderCursor']),
      hasEarlier: serializer.fromJson<bool>(json['hasEarlier']),
      gapJson: serializer.fromJson<String?>(json['gapJson']),
      truncationJson: serializer.fromJson<String?>(json['truncationJson']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'brokerProfileId': serializer.toJson<String>(brokerProfileId),
      'tool': serializer.toJson<String>(tool),
      'sessionId': serializer.toJson<String>(sessionId),
      'messagesJson': serializer.toJson<String>(messagesJson),
      'cursor': serializer.toJson<String?>(cursor),
      'olderCursor': serializer.toJson<String?>(olderCursor),
      'hasEarlier': serializer.toJson<bool>(hasEarlier),
      'gapJson': serializer.toJson<String?>(gapJson),
      'truncationJson': serializer.toJson<String?>(truncationJson),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  SessionTranscriptRow copyWith({
    String? brokerProfileId,
    String? tool,
    String? sessionId,
    String? messagesJson,
    Value<String?> cursor = const Value.absent(),
    Value<String?> olderCursor = const Value.absent(),
    bool? hasEarlier,
    Value<String?> gapJson = const Value.absent(),
    Value<String?> truncationJson = const Value.absent(),
    DateTime? updatedAt,
  }) => SessionTranscriptRow(
    brokerProfileId: brokerProfileId ?? this.brokerProfileId,
    tool: tool ?? this.tool,
    sessionId: sessionId ?? this.sessionId,
    messagesJson: messagesJson ?? this.messagesJson,
    cursor: cursor.present ? cursor.value : this.cursor,
    olderCursor: olderCursor.present ? olderCursor.value : this.olderCursor,
    hasEarlier: hasEarlier ?? this.hasEarlier,
    gapJson: gapJson.present ? gapJson.value : this.gapJson,
    truncationJson: truncationJson.present
        ? truncationJson.value
        : this.truncationJson,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  SessionTranscriptRow copyWithCompanion(SessionTranscriptRowsCompanion data) {
    return SessionTranscriptRow(
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      tool: data.tool.present ? data.tool.value : this.tool,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      messagesJson: data.messagesJson.present
          ? data.messagesJson.value
          : this.messagesJson,
      cursor: data.cursor.present ? data.cursor.value : this.cursor,
      olderCursor: data.olderCursor.present
          ? data.olderCursor.value
          : this.olderCursor,
      hasEarlier: data.hasEarlier.present
          ? data.hasEarlier.value
          : this.hasEarlier,
      gapJson: data.gapJson.present ? data.gapJson.value : this.gapJson,
      truncationJson: data.truncationJson.present
          ? data.truncationJson.value
          : this.truncationJson,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionTranscriptRow(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('messagesJson: $messagesJson, ')
          ..write('cursor: $cursor, ')
          ..write('olderCursor: $olderCursor, ')
          ..write('hasEarlier: $hasEarlier, ')
          ..write('gapJson: $gapJson, ')
          ..write('truncationJson: $truncationJson, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    brokerProfileId,
    tool,
    sessionId,
    messagesJson,
    cursor,
    olderCursor,
    hasEarlier,
    gapJson,
    truncationJson,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionTranscriptRow &&
          other.brokerProfileId == this.brokerProfileId &&
          other.tool == this.tool &&
          other.sessionId == this.sessionId &&
          other.messagesJson == this.messagesJson &&
          other.cursor == this.cursor &&
          other.olderCursor == this.olderCursor &&
          other.hasEarlier == this.hasEarlier &&
          other.gapJson == this.gapJson &&
          other.truncationJson == this.truncationJson &&
          other.updatedAt == this.updatedAt);
}

class SessionTranscriptRowsCompanion
    extends UpdateCompanion<SessionTranscriptRow> {
  final Value<String> brokerProfileId;
  final Value<String> tool;
  final Value<String> sessionId;
  final Value<String> messagesJson;
  final Value<String?> cursor;
  final Value<String?> olderCursor;
  final Value<bool> hasEarlier;
  final Value<String?> gapJson;
  final Value<String?> truncationJson;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const SessionTranscriptRowsCompanion({
    this.brokerProfileId = const Value.absent(),
    this.tool = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.messagesJson = const Value.absent(),
    this.cursor = const Value.absent(),
    this.olderCursor = const Value.absent(),
    this.hasEarlier = const Value.absent(),
    this.gapJson = const Value.absent(),
    this.truncationJson = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionTranscriptRowsCompanion.insert({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
    required String messagesJson,
    this.cursor = const Value.absent(),
    this.olderCursor = const Value.absent(),
    this.hasEarlier = const Value.absent(),
    this.gapJson = const Value.absent(),
    this.truncationJson = const Value.absent(),
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : brokerProfileId = Value(brokerProfileId),
       tool = Value(tool),
       sessionId = Value(sessionId),
       messagesJson = Value(messagesJson),
       updatedAt = Value(updatedAt);
  static Insertable<SessionTranscriptRow> custom({
    Expression<String>? brokerProfileId,
    Expression<String>? tool,
    Expression<String>? sessionId,
    Expression<String>? messagesJson,
    Expression<String>? cursor,
    Expression<String>? olderCursor,
    Expression<bool>? hasEarlier,
    Expression<String>? gapJson,
    Expression<String>? truncationJson,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (tool != null) 'tool': tool,
      if (sessionId != null) 'session_id': sessionId,
      if (messagesJson != null) 'messages_json': messagesJson,
      if (cursor != null) 'cursor': cursor,
      if (olderCursor != null) 'older_cursor': olderCursor,
      if (hasEarlier != null) 'has_earlier': hasEarlier,
      if (gapJson != null) 'gap_json': gapJson,
      if (truncationJson != null) 'truncation_json': truncationJson,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionTranscriptRowsCompanion copyWith({
    Value<String>? brokerProfileId,
    Value<String>? tool,
    Value<String>? sessionId,
    Value<String>? messagesJson,
    Value<String?>? cursor,
    Value<String?>? olderCursor,
    Value<bool>? hasEarlier,
    Value<String?>? gapJson,
    Value<String?>? truncationJson,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return SessionTranscriptRowsCompanion(
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      tool: tool ?? this.tool,
      sessionId: sessionId ?? this.sessionId,
      messagesJson: messagesJson ?? this.messagesJson,
      cursor: cursor ?? this.cursor,
      olderCursor: olderCursor ?? this.olderCursor,
      hasEarlier: hasEarlier ?? this.hasEarlier,
      gapJson: gapJson ?? this.gapJson,
      truncationJson: truncationJson ?? this.truncationJson,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (tool.present) {
      map['tool'] = Variable<String>(tool.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (messagesJson.present) {
      map['messages_json'] = Variable<String>(messagesJson.value);
    }
    if (cursor.present) {
      map['cursor'] = Variable<String>(cursor.value);
    }
    if (olderCursor.present) {
      map['older_cursor'] = Variable<String>(olderCursor.value);
    }
    if (hasEarlier.present) {
      map['has_earlier'] = Variable<bool>(hasEarlier.value);
    }
    if (gapJson.present) {
      map['gap_json'] = Variable<String>(gapJson.value);
    }
    if (truncationJson.present) {
      map['truncation_json'] = Variable<String>(truncationJson.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionTranscriptRowsCompanion(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('messagesJson: $messagesJson, ')
          ..write('cursor: $cursor, ')
          ..write('olderCursor: $olderCursor, ')
          ..write('hasEarlier: $hasEarlier, ')
          ..write('gapJson: $gapJson, ')
          ..write('truncationJson: $truncationJson, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SessionDraftRowsTable extends SessionDraftRows
    with TableInfo<$SessionDraftRowsTable, SessionDraftRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SessionDraftRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _toolMeta = const VerificationMeta('tool');
  @override
  late final GeneratedColumn<String> tool = GeneratedColumn<String>(
    'tool',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _draftTextMeta = const VerificationMeta(
    'draftText',
  );
  @override
  late final GeneratedColumn<String> draftText = GeneratedColumn<String>(
    'draft_text',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _localRevisionMeta = const VerificationMeta(
    'localRevision',
  );
  @override
  late final GeneratedColumn<int> localRevision = GeneratedColumn<int>(
    'local_revision',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _baseBrokerRevisionMeta =
      const VerificationMeta('baseBrokerRevision');
  @override
  late final GeneratedColumn<int> baseBrokerRevision = GeneratedColumn<int>(
    'base_broker_revision',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _dirtyMeta = const VerificationMeta('dirty');
  @override
  late final GeneratedColumn<bool> dirty = GeneratedColumn<bool>(
    'dirty',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("dirty" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _submittedClientMessageIdMeta =
      const VerificationMeta('submittedClientMessageId');
  @override
  late final GeneratedColumn<String> submittedClientMessageId =
      GeneratedColumn<String>(
        'submitted_client_message_id',
        aliasedName,
        true,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
      );
  static const VerificationMeta _mutationVersionMeta = const VerificationMeta(
    'mutationVersion',
  );
  @override
  late final GeneratedColumn<int> mutationVersion = GeneratedColumn<int>(
    'mutation_version',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _pendingClearRevisionMeta =
      const VerificationMeta('pendingClearRevision');
  @override
  late final GeneratedColumn<int> pendingClearRevision = GeneratedColumn<int>(
    'pending_clear_revision',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _conflictTextMeta = const VerificationMeta(
    'conflictText',
  );
  @override
  late final GeneratedColumn<String> conflictText = GeneratedColumn<String>(
    'conflict_text',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _conflictBrokerRevisionMeta =
      const VerificationMeta('conflictBrokerRevision');
  @override
  late final GeneratedColumn<int> conflictBrokerRevision = GeneratedColumn<int>(
    'conflict_broker_revision',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    brokerProfileId,
    tool,
    sessionId,
    draftText,
    localRevision,
    baseBrokerRevision,
    dirty,
    submittedClientMessageId,
    mutationVersion,
    pendingClearRevision,
    conflictText,
    conflictBrokerRevision,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'session_draft_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<SessionDraftRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_brokerProfileIdMeta);
    }
    if (data.containsKey('tool')) {
      context.handle(
        _toolMeta,
        tool.isAcceptableOrUnknown(data['tool']!, _toolMeta),
      );
    } else if (isInserting) {
      context.missing(_toolMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('draft_text')) {
      context.handle(
        _draftTextMeta,
        draftText.isAcceptableOrUnknown(data['draft_text']!, _draftTextMeta),
      );
    } else if (isInserting) {
      context.missing(_draftTextMeta);
    }
    if (data.containsKey('local_revision')) {
      context.handle(
        _localRevisionMeta,
        localRevision.isAcceptableOrUnknown(
          data['local_revision']!,
          _localRevisionMeta,
        ),
      );
    }
    if (data.containsKey('base_broker_revision')) {
      context.handle(
        _baseBrokerRevisionMeta,
        baseBrokerRevision.isAcceptableOrUnknown(
          data['base_broker_revision']!,
          _baseBrokerRevisionMeta,
        ),
      );
    }
    if (data.containsKey('dirty')) {
      context.handle(
        _dirtyMeta,
        dirty.isAcceptableOrUnknown(data['dirty']!, _dirtyMeta),
      );
    }
    if (data.containsKey('submitted_client_message_id')) {
      context.handle(
        _submittedClientMessageIdMeta,
        submittedClientMessageId.isAcceptableOrUnknown(
          data['submitted_client_message_id']!,
          _submittedClientMessageIdMeta,
        ),
      );
    }
    if (data.containsKey('mutation_version')) {
      context.handle(
        _mutationVersionMeta,
        mutationVersion.isAcceptableOrUnknown(
          data['mutation_version']!,
          _mutationVersionMeta,
        ),
      );
    }
    if (data.containsKey('pending_clear_revision')) {
      context.handle(
        _pendingClearRevisionMeta,
        pendingClearRevision.isAcceptableOrUnknown(
          data['pending_clear_revision']!,
          _pendingClearRevisionMeta,
        ),
      );
    }
    if (data.containsKey('conflict_text')) {
      context.handle(
        _conflictTextMeta,
        conflictText.isAcceptableOrUnknown(
          data['conflict_text']!,
          _conflictTextMeta,
        ),
      );
    }
    if (data.containsKey('conflict_broker_revision')) {
      context.handle(
        _conflictBrokerRevisionMeta,
        conflictBrokerRevision.isAcceptableOrUnknown(
          data['conflict_broker_revision']!,
          _conflictBrokerRevisionMeta,
        ),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {brokerProfileId, tool, sessionId};
  @override
  SessionDraftRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return SessionDraftRow(
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      )!,
      tool: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tool'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      draftText: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}draft_text'],
      )!,
      localRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}local_revision'],
      )!,
      baseBrokerRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}base_broker_revision'],
      )!,
      dirty: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}dirty'],
      )!,
      submittedClientMessageId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}submitted_client_message_id'],
      ),
      mutationVersion: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}mutation_version'],
      )!,
      pendingClearRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}pending_clear_revision'],
      ),
      conflictText: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}conflict_text'],
      ),
      conflictBrokerRevision: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}conflict_broker_revision'],
      ),
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $SessionDraftRowsTable createAlias(String alias) {
    return $SessionDraftRowsTable(attachedDatabase, alias);
  }
}

class SessionDraftRow extends DataClass implements Insertable<SessionDraftRow> {
  /// Owning broker profile, preventing cross-profile draft leakage.
  final String brokerProfileId;

  /// Broker tool key.
  final String tool;

  /// Broker session id.
  final String sessionId;

  /// Current local draft text ('' rows represent a pending clear).
  final String draftText;

  /// Local monotone revision, incremented per coalesced local edit flush.
  final int localRevision;

  /// Last broker draft revision the local value is based on / was
  /// acknowledged at. Ordering across clients uses broker revisions only,
  /// never client wall clocks.
  final int baseBrokerRevision;

  /// Whether the local value has edits the broker has not acknowledged.
  final bool dirty;

  /// Outbox handoff association while a send awaits broker delivery.
  final String? submittedClientMessageId;

  /// Monotone version of this row, bumped on EVERY accepted write.
  ///
  /// A conditional update on this value is what makes concurrent writers safe:
  /// the in-process mutation chain covers one controller and a transaction
  /// covers one connection, but a second browser tab is neither. `localRevision`
  /// cannot serve — it tracks coalesced user edits, so state-only writes
  /// (binding a send, adopting a revision, clearing a conflict) leave it
  /// unchanged and would look like no mutation at all.
  final int mutationVersion;

  /// Shared revision an unfinished post-send clear targets, when the broker
  /// accepted the prompt but could not durably clear the draft it contained.
  ///
  /// The retry is conditional on this exact revision. Once the shared record
  /// moves past it, the text this device sent is no longer the shared draft
  /// and the clear retires instead of overwriting whatever replaced it.
  final int? pendingClearRevision;

  /// Preserved shared-draft text for an unresolved conflict.
  final String? conflictText;

  /// Broker revision of [conflictText].
  final int? conflictBrokerRevision;

  /// Last mutation timestamp; drives TTL and LRU retention.
  final DateTime updatedAt;
  const SessionDraftRow({
    required this.brokerProfileId,
    required this.tool,
    required this.sessionId,
    required this.draftText,
    required this.localRevision,
    required this.baseBrokerRevision,
    required this.dirty,
    this.submittedClientMessageId,
    required this.mutationVersion,
    this.pendingClearRevision,
    this.conflictText,
    this.conflictBrokerRevision,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['broker_profile_id'] = Variable<String>(brokerProfileId);
    map['tool'] = Variable<String>(tool);
    map['session_id'] = Variable<String>(sessionId);
    map['draft_text'] = Variable<String>(draftText);
    map['local_revision'] = Variable<int>(localRevision);
    map['base_broker_revision'] = Variable<int>(baseBrokerRevision);
    map['dirty'] = Variable<bool>(dirty);
    if (!nullToAbsent || submittedClientMessageId != null) {
      map['submitted_client_message_id'] = Variable<String>(
        submittedClientMessageId,
      );
    }
    map['mutation_version'] = Variable<int>(mutationVersion);
    if (!nullToAbsent || pendingClearRevision != null) {
      map['pending_clear_revision'] = Variable<int>(pendingClearRevision);
    }
    if (!nullToAbsent || conflictText != null) {
      map['conflict_text'] = Variable<String>(conflictText);
    }
    if (!nullToAbsent || conflictBrokerRevision != null) {
      map['conflict_broker_revision'] = Variable<int>(conflictBrokerRevision);
    }
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  SessionDraftRowsCompanion toCompanion(bool nullToAbsent) {
    return SessionDraftRowsCompanion(
      brokerProfileId: Value(brokerProfileId),
      tool: Value(tool),
      sessionId: Value(sessionId),
      draftText: Value(draftText),
      localRevision: Value(localRevision),
      baseBrokerRevision: Value(baseBrokerRevision),
      dirty: Value(dirty),
      submittedClientMessageId: submittedClientMessageId == null && nullToAbsent
          ? const Value.absent()
          : Value(submittedClientMessageId),
      mutationVersion: Value(mutationVersion),
      pendingClearRevision: pendingClearRevision == null && nullToAbsent
          ? const Value.absent()
          : Value(pendingClearRevision),
      conflictText: conflictText == null && nullToAbsent
          ? const Value.absent()
          : Value(conflictText),
      conflictBrokerRevision: conflictBrokerRevision == null && nullToAbsent
          ? const Value.absent()
          : Value(conflictBrokerRevision),
      updatedAt: Value(updatedAt),
    );
  }

  factory SessionDraftRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return SessionDraftRow(
      brokerProfileId: serializer.fromJson<String>(json['brokerProfileId']),
      tool: serializer.fromJson<String>(json['tool']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      draftText: serializer.fromJson<String>(json['draftText']),
      localRevision: serializer.fromJson<int>(json['localRevision']),
      baseBrokerRevision: serializer.fromJson<int>(json['baseBrokerRevision']),
      dirty: serializer.fromJson<bool>(json['dirty']),
      submittedClientMessageId: serializer.fromJson<String?>(
        json['submittedClientMessageId'],
      ),
      mutationVersion: serializer.fromJson<int>(json['mutationVersion']),
      pendingClearRevision: serializer.fromJson<int?>(
        json['pendingClearRevision'],
      ),
      conflictText: serializer.fromJson<String?>(json['conflictText']),
      conflictBrokerRevision: serializer.fromJson<int?>(
        json['conflictBrokerRevision'],
      ),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'brokerProfileId': serializer.toJson<String>(brokerProfileId),
      'tool': serializer.toJson<String>(tool),
      'sessionId': serializer.toJson<String>(sessionId),
      'draftText': serializer.toJson<String>(draftText),
      'localRevision': serializer.toJson<int>(localRevision),
      'baseBrokerRevision': serializer.toJson<int>(baseBrokerRevision),
      'dirty': serializer.toJson<bool>(dirty),
      'submittedClientMessageId': serializer.toJson<String?>(
        submittedClientMessageId,
      ),
      'mutationVersion': serializer.toJson<int>(mutationVersion),
      'pendingClearRevision': serializer.toJson<int?>(pendingClearRevision),
      'conflictText': serializer.toJson<String?>(conflictText),
      'conflictBrokerRevision': serializer.toJson<int?>(conflictBrokerRevision),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  SessionDraftRow copyWith({
    String? brokerProfileId,
    String? tool,
    String? sessionId,
    String? draftText,
    int? localRevision,
    int? baseBrokerRevision,
    bool? dirty,
    Value<String?> submittedClientMessageId = const Value.absent(),
    int? mutationVersion,
    Value<int?> pendingClearRevision = const Value.absent(),
    Value<String?> conflictText = const Value.absent(),
    Value<int?> conflictBrokerRevision = const Value.absent(),
    DateTime? updatedAt,
  }) => SessionDraftRow(
    brokerProfileId: brokerProfileId ?? this.brokerProfileId,
    tool: tool ?? this.tool,
    sessionId: sessionId ?? this.sessionId,
    draftText: draftText ?? this.draftText,
    localRevision: localRevision ?? this.localRevision,
    baseBrokerRevision: baseBrokerRevision ?? this.baseBrokerRevision,
    dirty: dirty ?? this.dirty,
    submittedClientMessageId: submittedClientMessageId.present
        ? submittedClientMessageId.value
        : this.submittedClientMessageId,
    mutationVersion: mutationVersion ?? this.mutationVersion,
    pendingClearRevision: pendingClearRevision.present
        ? pendingClearRevision.value
        : this.pendingClearRevision,
    conflictText: conflictText.present ? conflictText.value : this.conflictText,
    conflictBrokerRevision: conflictBrokerRevision.present
        ? conflictBrokerRevision.value
        : this.conflictBrokerRevision,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  SessionDraftRow copyWithCompanion(SessionDraftRowsCompanion data) {
    return SessionDraftRow(
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      tool: data.tool.present ? data.tool.value : this.tool,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      draftText: data.draftText.present ? data.draftText.value : this.draftText,
      localRevision: data.localRevision.present
          ? data.localRevision.value
          : this.localRevision,
      baseBrokerRevision: data.baseBrokerRevision.present
          ? data.baseBrokerRevision.value
          : this.baseBrokerRevision,
      dirty: data.dirty.present ? data.dirty.value : this.dirty,
      submittedClientMessageId: data.submittedClientMessageId.present
          ? data.submittedClientMessageId.value
          : this.submittedClientMessageId,
      mutationVersion: data.mutationVersion.present
          ? data.mutationVersion.value
          : this.mutationVersion,
      pendingClearRevision: data.pendingClearRevision.present
          ? data.pendingClearRevision.value
          : this.pendingClearRevision,
      conflictText: data.conflictText.present
          ? data.conflictText.value
          : this.conflictText,
      conflictBrokerRevision: data.conflictBrokerRevision.present
          ? data.conflictBrokerRevision.value
          : this.conflictBrokerRevision,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('SessionDraftRow(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('draftText: $draftText, ')
          ..write('localRevision: $localRevision, ')
          ..write('baseBrokerRevision: $baseBrokerRevision, ')
          ..write('dirty: $dirty, ')
          ..write('submittedClientMessageId: $submittedClientMessageId, ')
          ..write('mutationVersion: $mutationVersion, ')
          ..write('pendingClearRevision: $pendingClearRevision, ')
          ..write('conflictText: $conflictText, ')
          ..write('conflictBrokerRevision: $conflictBrokerRevision, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    brokerProfileId,
    tool,
    sessionId,
    draftText,
    localRevision,
    baseBrokerRevision,
    dirty,
    submittedClientMessageId,
    mutationVersion,
    pendingClearRevision,
    conflictText,
    conflictBrokerRevision,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is SessionDraftRow &&
          other.brokerProfileId == this.brokerProfileId &&
          other.tool == this.tool &&
          other.sessionId == this.sessionId &&
          other.draftText == this.draftText &&
          other.localRevision == this.localRevision &&
          other.baseBrokerRevision == this.baseBrokerRevision &&
          other.dirty == this.dirty &&
          other.submittedClientMessageId == this.submittedClientMessageId &&
          other.mutationVersion == this.mutationVersion &&
          other.pendingClearRevision == this.pendingClearRevision &&
          other.conflictText == this.conflictText &&
          other.conflictBrokerRevision == this.conflictBrokerRevision &&
          other.updatedAt == this.updatedAt);
}

class SessionDraftRowsCompanion extends UpdateCompanion<SessionDraftRow> {
  final Value<String> brokerProfileId;
  final Value<String> tool;
  final Value<String> sessionId;
  final Value<String> draftText;
  final Value<int> localRevision;
  final Value<int> baseBrokerRevision;
  final Value<bool> dirty;
  final Value<String?> submittedClientMessageId;
  final Value<int> mutationVersion;
  final Value<int?> pendingClearRevision;
  final Value<String?> conflictText;
  final Value<int?> conflictBrokerRevision;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const SessionDraftRowsCompanion({
    this.brokerProfileId = const Value.absent(),
    this.tool = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.draftText = const Value.absent(),
    this.localRevision = const Value.absent(),
    this.baseBrokerRevision = const Value.absent(),
    this.dirty = const Value.absent(),
    this.submittedClientMessageId = const Value.absent(),
    this.mutationVersion = const Value.absent(),
    this.pendingClearRevision = const Value.absent(),
    this.conflictText = const Value.absent(),
    this.conflictBrokerRevision = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SessionDraftRowsCompanion.insert({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
    required String draftText,
    this.localRevision = const Value.absent(),
    this.baseBrokerRevision = const Value.absent(),
    this.dirty = const Value.absent(),
    this.submittedClientMessageId = const Value.absent(),
    this.mutationVersion = const Value.absent(),
    this.pendingClearRevision = const Value.absent(),
    this.conflictText = const Value.absent(),
    this.conflictBrokerRevision = const Value.absent(),
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : brokerProfileId = Value(brokerProfileId),
       tool = Value(tool),
       sessionId = Value(sessionId),
       draftText = Value(draftText),
       updatedAt = Value(updatedAt);
  static Insertable<SessionDraftRow> custom({
    Expression<String>? brokerProfileId,
    Expression<String>? tool,
    Expression<String>? sessionId,
    Expression<String>? draftText,
    Expression<int>? localRevision,
    Expression<int>? baseBrokerRevision,
    Expression<bool>? dirty,
    Expression<String>? submittedClientMessageId,
    Expression<int>? mutationVersion,
    Expression<int>? pendingClearRevision,
    Expression<String>? conflictText,
    Expression<int>? conflictBrokerRevision,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (tool != null) 'tool': tool,
      if (sessionId != null) 'session_id': sessionId,
      if (draftText != null) 'draft_text': draftText,
      if (localRevision != null) 'local_revision': localRevision,
      if (baseBrokerRevision != null)
        'base_broker_revision': baseBrokerRevision,
      if (dirty != null) 'dirty': dirty,
      if (submittedClientMessageId != null)
        'submitted_client_message_id': submittedClientMessageId,
      if (mutationVersion != null) 'mutation_version': mutationVersion,
      if (pendingClearRevision != null)
        'pending_clear_revision': pendingClearRevision,
      if (conflictText != null) 'conflict_text': conflictText,
      if (conflictBrokerRevision != null)
        'conflict_broker_revision': conflictBrokerRevision,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SessionDraftRowsCompanion copyWith({
    Value<String>? brokerProfileId,
    Value<String>? tool,
    Value<String>? sessionId,
    Value<String>? draftText,
    Value<int>? localRevision,
    Value<int>? baseBrokerRevision,
    Value<bool>? dirty,
    Value<String?>? submittedClientMessageId,
    Value<int>? mutationVersion,
    Value<int?>? pendingClearRevision,
    Value<String?>? conflictText,
    Value<int?>? conflictBrokerRevision,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return SessionDraftRowsCompanion(
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      tool: tool ?? this.tool,
      sessionId: sessionId ?? this.sessionId,
      draftText: draftText ?? this.draftText,
      localRevision: localRevision ?? this.localRevision,
      baseBrokerRevision: baseBrokerRevision ?? this.baseBrokerRevision,
      dirty: dirty ?? this.dirty,
      submittedClientMessageId:
          submittedClientMessageId ?? this.submittedClientMessageId,
      mutationVersion: mutationVersion ?? this.mutationVersion,
      pendingClearRevision: pendingClearRevision ?? this.pendingClearRevision,
      conflictText: conflictText ?? this.conflictText,
      conflictBrokerRevision:
          conflictBrokerRevision ?? this.conflictBrokerRevision,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (tool.present) {
      map['tool'] = Variable<String>(tool.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (draftText.present) {
      map['draft_text'] = Variable<String>(draftText.value);
    }
    if (localRevision.present) {
      map['local_revision'] = Variable<int>(localRevision.value);
    }
    if (baseBrokerRevision.present) {
      map['base_broker_revision'] = Variable<int>(baseBrokerRevision.value);
    }
    if (dirty.present) {
      map['dirty'] = Variable<bool>(dirty.value);
    }
    if (submittedClientMessageId.present) {
      map['submitted_client_message_id'] = Variable<String>(
        submittedClientMessageId.value,
      );
    }
    if (mutationVersion.present) {
      map['mutation_version'] = Variable<int>(mutationVersion.value);
    }
    if (pendingClearRevision.present) {
      map['pending_clear_revision'] = Variable<int>(pendingClearRevision.value);
    }
    if (conflictText.present) {
      map['conflict_text'] = Variable<String>(conflictText.value);
    }
    if (conflictBrokerRevision.present) {
      map['conflict_broker_revision'] = Variable<int>(
        conflictBrokerRevision.value,
      );
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SessionDraftRowsCompanion(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('tool: $tool, ')
          ..write('sessionId: $sessionId, ')
          ..write('draftText: $draftText, ')
          ..write('localRevision: $localRevision, ')
          ..write('baseBrokerRevision: $baseBrokerRevision, ')
          ..write('dirty: $dirty, ')
          ..write('submittedClientMessageId: $submittedClientMessageId, ')
          ..write('mutationVersion: $mutationVersion, ')
          ..write('pendingClearRevision: $pendingClearRevision, ')
          ..write('conflictText: $conflictText, ')
          ..write('conflictBrokerRevision: $conflictBrokerRevision, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $RosterSnapshotRowsTable extends RosterSnapshotRows
    with TableInfo<$RosterSnapshotRowsTable, RosterSnapshotRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $RosterSnapshotRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _brokerProfileIdMeta = const VerificationMeta(
    'brokerProfileId',
  );
  @override
  late final GeneratedColumn<String> brokerProfileId = GeneratedColumn<String>(
    'broker_profile_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _endpointMeta = const VerificationMeta(
    'endpoint',
  );
  @override
  late final GeneratedColumn<String> endpoint = GeneratedColumn<String>(
    'endpoint',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadVersionMeta = const VerificationMeta(
    'payloadVersion',
  );
  @override
  late final GeneratedColumn<int> payloadVersion = GeneratedColumn<int>(
    'payload_version',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _rowsJsonMeta = const VerificationMeta(
    'rowsJson',
  );
  @override
  late final GeneratedColumn<String> rowsJson = GeneratedColumn<String>(
    'rows_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _rowCountMeta = const VerificationMeta(
    'rowCount',
  );
  @override
  late final GeneratedColumn<int> rowCount = GeneratedColumn<int>(
    'row_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _newestSessionUpdatedAtMeta =
      const VerificationMeta('newestSessionUpdatedAt');
  @override
  late final GeneratedColumn<int> newestSessionUpdatedAt = GeneratedColumn<int>(
    'newest_session_updated_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _capturedAtMeta = const VerificationMeta(
    'capturedAt',
  );
  @override
  late final GeneratedColumn<DateTime> capturedAt = GeneratedColumn<DateTime>(
    'captured_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    brokerProfileId,
    endpoint,
    payloadVersion,
    rowsJson,
    rowCount,
    newestSessionUpdatedAt,
    capturedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'roster_snapshot_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<RosterSnapshotRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('broker_profile_id')) {
      context.handle(
        _brokerProfileIdMeta,
        brokerProfileId.isAcceptableOrUnknown(
          data['broker_profile_id']!,
          _brokerProfileIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_brokerProfileIdMeta);
    }
    if (data.containsKey('endpoint')) {
      context.handle(
        _endpointMeta,
        endpoint.isAcceptableOrUnknown(data['endpoint']!, _endpointMeta),
      );
    } else if (isInserting) {
      context.missing(_endpointMeta);
    }
    if (data.containsKey('payload_version')) {
      context.handle(
        _payloadVersionMeta,
        payloadVersion.isAcceptableOrUnknown(
          data['payload_version']!,
          _payloadVersionMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadVersionMeta);
    }
    if (data.containsKey('rows_json')) {
      context.handle(
        _rowsJsonMeta,
        rowsJson.isAcceptableOrUnknown(data['rows_json']!, _rowsJsonMeta),
      );
    } else if (isInserting) {
      context.missing(_rowsJsonMeta);
    }
    if (data.containsKey('row_count')) {
      context.handle(
        _rowCountMeta,
        rowCount.isAcceptableOrUnknown(data['row_count']!, _rowCountMeta),
      );
    }
    if (data.containsKey('newest_session_updated_at')) {
      context.handle(
        _newestSessionUpdatedAtMeta,
        newestSessionUpdatedAt.isAcceptableOrUnknown(
          data['newest_session_updated_at']!,
          _newestSessionUpdatedAtMeta,
        ),
      );
    }
    if (data.containsKey('captured_at')) {
      context.handle(
        _capturedAtMeta,
        capturedAt.isAcceptableOrUnknown(data['captured_at']!, _capturedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_capturedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {brokerProfileId};
  @override
  RosterSnapshotRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return RosterSnapshotRow(
      brokerProfileId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}broker_profile_id'],
      )!,
      endpoint: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}endpoint'],
      )!,
      payloadVersion: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}payload_version'],
      )!,
      rowsJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}rows_json'],
      )!,
      rowCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}row_count'],
      )!,
      newestSessionUpdatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}newest_session_updated_at'],
      ),
      capturedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}captured_at'],
      )!,
    );
  }

  @override
  $RosterSnapshotRowsTable createAlias(String alias) {
    return $RosterSnapshotRowsTable(attachedDatabase, alias);
  }
}

class RosterSnapshotRow extends DataClass
    implements Insertable<RosterSnapshotRow> {
  /// Owning broker profile; the snapshot is scoped to this exact profile so a
  /// switch can never show another broker's rows.
  final String brokerProfileId;

  /// Normalized broker endpoint these identities were captured from.
  ///
  /// A profile keeps its id when its URL is edited, so the id alone does not
  /// identify the roster source: pointing the same profile at a different
  /// broker would otherwise inherit the previous broker's session identities.
  /// The reader compares this against the profile's current endpoint and
  /// discards the row on any difference.
  final String endpoint;

  /// Encoded identity payload version, so a future or corrupt shape can fail
  /// open to normal loading instead of being misread.
  final int payloadVersion;

  /// Bounded JSON array of identity rows.
  final String rowsJson;

  /// Number of identity rows encoded in [rowsJson], for cheap bound checks.
  final int rowCount;

  /// Newest `updatedAt` the authoritative roster reported, in epoch ms.
  ///
  /// Display-only provenance for the "last seen" line; never a freshness claim
  /// about the session's current activity.
  final int? newestSessionUpdatedAt;

  /// When this client last wrote the snapshot from an authoritative response.
  final DateTime capturedAt;
  const RosterSnapshotRow({
    required this.brokerProfileId,
    required this.endpoint,
    required this.payloadVersion,
    required this.rowsJson,
    required this.rowCount,
    this.newestSessionUpdatedAt,
    required this.capturedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['broker_profile_id'] = Variable<String>(brokerProfileId);
    map['endpoint'] = Variable<String>(endpoint);
    map['payload_version'] = Variable<int>(payloadVersion);
    map['rows_json'] = Variable<String>(rowsJson);
    map['row_count'] = Variable<int>(rowCount);
    if (!nullToAbsent || newestSessionUpdatedAt != null) {
      map['newest_session_updated_at'] = Variable<int>(newestSessionUpdatedAt);
    }
    map['captured_at'] = Variable<DateTime>(capturedAt);
    return map;
  }

  RosterSnapshotRowsCompanion toCompanion(bool nullToAbsent) {
    return RosterSnapshotRowsCompanion(
      brokerProfileId: Value(brokerProfileId),
      endpoint: Value(endpoint),
      payloadVersion: Value(payloadVersion),
      rowsJson: Value(rowsJson),
      rowCount: Value(rowCount),
      newestSessionUpdatedAt: newestSessionUpdatedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(newestSessionUpdatedAt),
      capturedAt: Value(capturedAt),
    );
  }

  factory RosterSnapshotRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return RosterSnapshotRow(
      brokerProfileId: serializer.fromJson<String>(json['brokerProfileId']),
      endpoint: serializer.fromJson<String>(json['endpoint']),
      payloadVersion: serializer.fromJson<int>(json['payloadVersion']),
      rowsJson: serializer.fromJson<String>(json['rowsJson']),
      rowCount: serializer.fromJson<int>(json['rowCount']),
      newestSessionUpdatedAt: serializer.fromJson<int?>(
        json['newestSessionUpdatedAt'],
      ),
      capturedAt: serializer.fromJson<DateTime>(json['capturedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'brokerProfileId': serializer.toJson<String>(brokerProfileId),
      'endpoint': serializer.toJson<String>(endpoint),
      'payloadVersion': serializer.toJson<int>(payloadVersion),
      'rowsJson': serializer.toJson<String>(rowsJson),
      'rowCount': serializer.toJson<int>(rowCount),
      'newestSessionUpdatedAt': serializer.toJson<int?>(newestSessionUpdatedAt),
      'capturedAt': serializer.toJson<DateTime>(capturedAt),
    };
  }

  RosterSnapshotRow copyWith({
    String? brokerProfileId,
    String? endpoint,
    int? payloadVersion,
    String? rowsJson,
    int? rowCount,
    Value<int?> newestSessionUpdatedAt = const Value.absent(),
    DateTime? capturedAt,
  }) => RosterSnapshotRow(
    brokerProfileId: brokerProfileId ?? this.brokerProfileId,
    endpoint: endpoint ?? this.endpoint,
    payloadVersion: payloadVersion ?? this.payloadVersion,
    rowsJson: rowsJson ?? this.rowsJson,
    rowCount: rowCount ?? this.rowCount,
    newestSessionUpdatedAt: newestSessionUpdatedAt.present
        ? newestSessionUpdatedAt.value
        : this.newestSessionUpdatedAt,
    capturedAt: capturedAt ?? this.capturedAt,
  );
  RosterSnapshotRow copyWithCompanion(RosterSnapshotRowsCompanion data) {
    return RosterSnapshotRow(
      brokerProfileId: data.brokerProfileId.present
          ? data.brokerProfileId.value
          : this.brokerProfileId,
      endpoint: data.endpoint.present ? data.endpoint.value : this.endpoint,
      payloadVersion: data.payloadVersion.present
          ? data.payloadVersion.value
          : this.payloadVersion,
      rowsJson: data.rowsJson.present ? data.rowsJson.value : this.rowsJson,
      rowCount: data.rowCount.present ? data.rowCount.value : this.rowCount,
      newestSessionUpdatedAt: data.newestSessionUpdatedAt.present
          ? data.newestSessionUpdatedAt.value
          : this.newestSessionUpdatedAt,
      capturedAt: data.capturedAt.present
          ? data.capturedAt.value
          : this.capturedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('RosterSnapshotRow(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('endpoint: $endpoint, ')
          ..write('payloadVersion: $payloadVersion, ')
          ..write('rowsJson: $rowsJson, ')
          ..write('rowCount: $rowCount, ')
          ..write('newestSessionUpdatedAt: $newestSessionUpdatedAt, ')
          ..write('capturedAt: $capturedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    brokerProfileId,
    endpoint,
    payloadVersion,
    rowsJson,
    rowCount,
    newestSessionUpdatedAt,
    capturedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is RosterSnapshotRow &&
          other.brokerProfileId == this.brokerProfileId &&
          other.endpoint == this.endpoint &&
          other.payloadVersion == this.payloadVersion &&
          other.rowsJson == this.rowsJson &&
          other.rowCount == this.rowCount &&
          other.newestSessionUpdatedAt == this.newestSessionUpdatedAt &&
          other.capturedAt == this.capturedAt);
}

class RosterSnapshotRowsCompanion extends UpdateCompanion<RosterSnapshotRow> {
  final Value<String> brokerProfileId;
  final Value<String> endpoint;
  final Value<int> payloadVersion;
  final Value<String> rowsJson;
  final Value<int> rowCount;
  final Value<int?> newestSessionUpdatedAt;
  final Value<DateTime> capturedAt;
  final Value<int> rowid;
  const RosterSnapshotRowsCompanion({
    this.brokerProfileId = const Value.absent(),
    this.endpoint = const Value.absent(),
    this.payloadVersion = const Value.absent(),
    this.rowsJson = const Value.absent(),
    this.rowCount = const Value.absent(),
    this.newestSessionUpdatedAt = const Value.absent(),
    this.capturedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  RosterSnapshotRowsCompanion.insert({
    required String brokerProfileId,
    required String endpoint,
    required int payloadVersion,
    required String rowsJson,
    this.rowCount = const Value.absent(),
    this.newestSessionUpdatedAt = const Value.absent(),
    required DateTime capturedAt,
    this.rowid = const Value.absent(),
  }) : brokerProfileId = Value(brokerProfileId),
       endpoint = Value(endpoint),
       payloadVersion = Value(payloadVersion),
       rowsJson = Value(rowsJson),
       capturedAt = Value(capturedAt);
  static Insertable<RosterSnapshotRow> custom({
    Expression<String>? brokerProfileId,
    Expression<String>? endpoint,
    Expression<int>? payloadVersion,
    Expression<String>? rowsJson,
    Expression<int>? rowCount,
    Expression<int>? newestSessionUpdatedAt,
    Expression<DateTime>? capturedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (brokerProfileId != null) 'broker_profile_id': brokerProfileId,
      if (endpoint != null) 'endpoint': endpoint,
      if (payloadVersion != null) 'payload_version': payloadVersion,
      if (rowsJson != null) 'rows_json': rowsJson,
      if (rowCount != null) 'row_count': rowCount,
      if (newestSessionUpdatedAt != null)
        'newest_session_updated_at': newestSessionUpdatedAt,
      if (capturedAt != null) 'captured_at': capturedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  RosterSnapshotRowsCompanion copyWith({
    Value<String>? brokerProfileId,
    Value<String>? endpoint,
    Value<int>? payloadVersion,
    Value<String>? rowsJson,
    Value<int>? rowCount,
    Value<int?>? newestSessionUpdatedAt,
    Value<DateTime>? capturedAt,
    Value<int>? rowid,
  }) {
    return RosterSnapshotRowsCompanion(
      brokerProfileId: brokerProfileId ?? this.brokerProfileId,
      endpoint: endpoint ?? this.endpoint,
      payloadVersion: payloadVersion ?? this.payloadVersion,
      rowsJson: rowsJson ?? this.rowsJson,
      rowCount: rowCount ?? this.rowCount,
      newestSessionUpdatedAt:
          newestSessionUpdatedAt ?? this.newestSessionUpdatedAt,
      capturedAt: capturedAt ?? this.capturedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (brokerProfileId.present) {
      map['broker_profile_id'] = Variable<String>(brokerProfileId.value);
    }
    if (endpoint.present) {
      map['endpoint'] = Variable<String>(endpoint.value);
    }
    if (payloadVersion.present) {
      map['payload_version'] = Variable<int>(payloadVersion.value);
    }
    if (rowsJson.present) {
      map['rows_json'] = Variable<String>(rowsJson.value);
    }
    if (rowCount.present) {
      map['row_count'] = Variable<int>(rowCount.value);
    }
    if (newestSessionUpdatedAt.present) {
      map['newest_session_updated_at'] = Variable<int>(
        newestSessionUpdatedAt.value,
      );
    }
    if (capturedAt.present) {
      map['captured_at'] = Variable<DateTime>(capturedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('RosterSnapshotRowsCompanion(')
          ..write('brokerProfileId: $brokerProfileId, ')
          ..write('endpoint: $endpoint, ')
          ..write('payloadVersion: $payloadVersion, ')
          ..write('rowsJson: $rowsJson, ')
          ..write('rowCount: $rowCount, ')
          ..write('newestSessionUpdatedAt: $newestSessionUpdatedAt, ')
          ..write('capturedAt: $capturedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDatabase extends GeneratedDatabase {
  _$AppDatabase(QueryExecutor e) : super(e);
  $AppDatabaseManager get managers => $AppDatabaseManager(this);
  late final $ArtifactTransferRowsTable artifactTransferRows =
      $ArtifactTransferRowsTable(this);
  late final $BrokerProfileRowsTable brokerProfileRows =
      $BrokerProfileRowsTable(this);
  late final $AttentionEventRowsTable attentionEventRows =
      $AttentionEventRowsTable(this);
  late final $AttentionCursorRowsTable attentionCursorRows =
      $AttentionCursorRowsTable(this);
  late final $AppSettingRowsTable appSettingRows = $AppSettingRowsTable(this);
  late final $SessionOutboxRowsTable sessionOutboxRows =
      $SessionOutboxRowsTable(this);
  late final $SessionTranscriptRowsTable sessionTranscriptRows =
      $SessionTranscriptRowsTable(this);
  late final $SessionDraftRowsTable sessionDraftRows = $SessionDraftRowsTable(
    this,
  );
  late final $RosterSnapshotRowsTable rosterSnapshotRows =
      $RosterSnapshotRowsTable(this);
  late final Index idxSessionOutboxStatusUpdated = Index(
    'idx_session_outbox_status_updated',
    'CREATE INDEX idx_session_outbox_status_updated ON session_outbox_rows (status, updated_at)',
  );
  late final Index idxSessionTranscriptProfileUpdated = Index(
    'idx_session_transcript_profile_updated',
    'CREATE INDEX idx_session_transcript_profile_updated ON session_transcript_rows (broker_profile_id, updated_at)',
  );
  late final Index idxSessionDraftProfileUpdated = Index(
    'idx_session_draft_profile_updated',
    'CREATE INDEX idx_session_draft_profile_updated ON session_draft_rows (broker_profile_id, updated_at)',
  );
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    artifactTransferRows,
    brokerProfileRows,
    attentionEventRows,
    attentionCursorRows,
    appSettingRows,
    sessionOutboxRows,
    sessionTranscriptRows,
    sessionDraftRows,
    rosterSnapshotRows,
    idxSessionOutboxStatusUpdated,
    idxSessionTranscriptProfileUpdated,
    idxSessionDraftProfileUpdated,
  ];
}

typedef $$ArtifactTransferRowsTableCreateCompanionBuilder =
    ArtifactTransferRowsCompanion Function({
      required String id,
      Value<String?> brokerProfileId,
      required String tool,
      required String sessionId,
      required String actionKey,
      required String fileName,
      required String direction,
      required String status,
      Value<int> attemptCount,
      Value<String?> artifactKey,
      Value<String?> sourceUrl,
      Value<String?> cachedFilePath,
      Value<String?> exportedPath,
      Value<String?> contentType,
      Value<String?> contentHash,
      Value<String?> uploadId,
      Value<String?> partialFilePath,
      Value<String?> downloadEtag,
      Value<String?> downloadLastModified,
      Value<int?> byteLength,
      Value<int?> bytesTransferred,
      Value<int?> totalBytes,
      Value<String?> error,
      Value<String> message,
      required DateTime createdAt,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$ArtifactTransferRowsTableUpdateCompanionBuilder =
    ArtifactTransferRowsCompanion Function({
      Value<String> id,
      Value<String?> brokerProfileId,
      Value<String> tool,
      Value<String> sessionId,
      Value<String> actionKey,
      Value<String> fileName,
      Value<String> direction,
      Value<String> status,
      Value<int> attemptCount,
      Value<String?> artifactKey,
      Value<String?> sourceUrl,
      Value<String?> cachedFilePath,
      Value<String?> exportedPath,
      Value<String?> contentType,
      Value<String?> contentHash,
      Value<String?> uploadId,
      Value<String?> partialFilePath,
      Value<String?> downloadEtag,
      Value<String?> downloadLastModified,
      Value<int?> byteLength,
      Value<int?> bytesTransferred,
      Value<int?> totalBytes,
      Value<String?> error,
      Value<String> message,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$ArtifactTransferRowsTableFilterComposer
    extends Composer<_$AppDatabase, $ArtifactTransferRowsTable> {
  $$ArtifactTransferRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get actionKey => $composableBuilder(
    column: $table.actionKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get fileName => $composableBuilder(
    column: $table.fileName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get direction => $composableBuilder(
    column: $table.direction,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attemptCount => $composableBuilder(
    column: $table.attemptCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get artifactKey => $composableBuilder(
    column: $table.artifactKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sourceUrl => $composableBuilder(
    column: $table.sourceUrl,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get cachedFilePath => $composableBuilder(
    column: $table.cachedFilePath,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get exportedPath => $composableBuilder(
    column: $table.exportedPath,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get contentType => $composableBuilder(
    column: $table.contentType,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get contentHash => $composableBuilder(
    column: $table.contentHash,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get uploadId => $composableBuilder(
    column: $table.uploadId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get partialFilePath => $composableBuilder(
    column: $table.partialFilePath,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get downloadEtag => $composableBuilder(
    column: $table.downloadEtag,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get downloadLastModified => $composableBuilder(
    column: $table.downloadLastModified,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get byteLength => $composableBuilder(
    column: $table.byteLength,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get bytesTransferred => $composableBuilder(
    column: $table.bytesTransferred,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get totalBytes => $composableBuilder(
    column: $table.totalBytes,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get error => $composableBuilder(
    column: $table.error,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get message => $composableBuilder(
    column: $table.message,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ArtifactTransferRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $ArtifactTransferRowsTable> {
  $$ArtifactTransferRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get actionKey => $composableBuilder(
    column: $table.actionKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get fileName => $composableBuilder(
    column: $table.fileName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get direction => $composableBuilder(
    column: $table.direction,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attemptCount => $composableBuilder(
    column: $table.attemptCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get artifactKey => $composableBuilder(
    column: $table.artifactKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sourceUrl => $composableBuilder(
    column: $table.sourceUrl,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get cachedFilePath => $composableBuilder(
    column: $table.cachedFilePath,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get exportedPath => $composableBuilder(
    column: $table.exportedPath,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get contentType => $composableBuilder(
    column: $table.contentType,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get contentHash => $composableBuilder(
    column: $table.contentHash,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get uploadId => $composableBuilder(
    column: $table.uploadId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get partialFilePath => $composableBuilder(
    column: $table.partialFilePath,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get downloadEtag => $composableBuilder(
    column: $table.downloadEtag,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get downloadLastModified => $composableBuilder(
    column: $table.downloadLastModified,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get byteLength => $composableBuilder(
    column: $table.byteLength,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get bytesTransferred => $composableBuilder(
    column: $table.bytesTransferred,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get totalBytes => $composableBuilder(
    column: $table.totalBytes,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get error => $composableBuilder(
    column: $table.error,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get message => $composableBuilder(
    column: $table.message,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ArtifactTransferRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $ArtifactTransferRowsTable> {
  $$ArtifactTransferRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get tool =>
      $composableBuilder(column: $table.tool, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get actionKey =>
      $composableBuilder(column: $table.actionKey, builder: (column) => column);

  GeneratedColumn<String> get fileName =>
      $composableBuilder(column: $table.fileName, builder: (column) => column);

  GeneratedColumn<String> get direction =>
      $composableBuilder(column: $table.direction, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<int> get attemptCount => $composableBuilder(
    column: $table.attemptCount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get artifactKey => $composableBuilder(
    column: $table.artifactKey,
    builder: (column) => column,
  );

  GeneratedColumn<String> get sourceUrl =>
      $composableBuilder(column: $table.sourceUrl, builder: (column) => column);

  GeneratedColumn<String> get cachedFilePath => $composableBuilder(
    column: $table.cachedFilePath,
    builder: (column) => column,
  );

  GeneratedColumn<String> get exportedPath => $composableBuilder(
    column: $table.exportedPath,
    builder: (column) => column,
  );

  GeneratedColumn<String> get contentType => $composableBuilder(
    column: $table.contentType,
    builder: (column) => column,
  );

  GeneratedColumn<String> get contentHash => $composableBuilder(
    column: $table.contentHash,
    builder: (column) => column,
  );

  GeneratedColumn<String> get uploadId =>
      $composableBuilder(column: $table.uploadId, builder: (column) => column);

  GeneratedColumn<String> get partialFilePath => $composableBuilder(
    column: $table.partialFilePath,
    builder: (column) => column,
  );

  GeneratedColumn<String> get downloadEtag => $composableBuilder(
    column: $table.downloadEtag,
    builder: (column) => column,
  );

  GeneratedColumn<String> get downloadLastModified => $composableBuilder(
    column: $table.downloadLastModified,
    builder: (column) => column,
  );

  GeneratedColumn<int> get byteLength => $composableBuilder(
    column: $table.byteLength,
    builder: (column) => column,
  );

  GeneratedColumn<int> get bytesTransferred => $composableBuilder(
    column: $table.bytesTransferred,
    builder: (column) => column,
  );

  GeneratedColumn<int> get totalBytes => $composableBuilder(
    column: $table.totalBytes,
    builder: (column) => column,
  );

  GeneratedColumn<String> get error =>
      $composableBuilder(column: $table.error, builder: (column) => column);

  GeneratedColumn<String> get message =>
      $composableBuilder(column: $table.message, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$ArtifactTransferRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ArtifactTransferRowsTable,
          ArtifactTransferRow,
          $$ArtifactTransferRowsTableFilterComposer,
          $$ArtifactTransferRowsTableOrderingComposer,
          $$ArtifactTransferRowsTableAnnotationComposer,
          $$ArtifactTransferRowsTableCreateCompanionBuilder,
          $$ArtifactTransferRowsTableUpdateCompanionBuilder,
          (
            ArtifactTransferRow,
            BaseReferences<
              _$AppDatabase,
              $ArtifactTransferRowsTable,
              ArtifactTransferRow
            >,
          ),
          ArtifactTransferRow,
          PrefetchHooks Function()
        > {
  $$ArtifactTransferRowsTableTableManager(
    _$AppDatabase db,
    $ArtifactTransferRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ArtifactTransferRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ArtifactTransferRowsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$ArtifactTransferRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String?> brokerProfileId = const Value.absent(),
                Value<String> tool = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> actionKey = const Value.absent(),
                Value<String> fileName = const Value.absent(),
                Value<String> direction = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> attemptCount = const Value.absent(),
                Value<String?> artifactKey = const Value.absent(),
                Value<String?> sourceUrl = const Value.absent(),
                Value<String?> cachedFilePath = const Value.absent(),
                Value<String?> exportedPath = const Value.absent(),
                Value<String?> contentType = const Value.absent(),
                Value<String?> contentHash = const Value.absent(),
                Value<String?> uploadId = const Value.absent(),
                Value<String?> partialFilePath = const Value.absent(),
                Value<String?> downloadEtag = const Value.absent(),
                Value<String?> downloadLastModified = const Value.absent(),
                Value<int?> byteLength = const Value.absent(),
                Value<int?> bytesTransferred = const Value.absent(),
                Value<int?> totalBytes = const Value.absent(),
                Value<String?> error = const Value.absent(),
                Value<String> message = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ArtifactTransferRowsCompanion(
                id: id,
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                actionKey: actionKey,
                fileName: fileName,
                direction: direction,
                status: status,
                attemptCount: attemptCount,
                artifactKey: artifactKey,
                sourceUrl: sourceUrl,
                cachedFilePath: cachedFilePath,
                exportedPath: exportedPath,
                contentType: contentType,
                contentHash: contentHash,
                uploadId: uploadId,
                partialFilePath: partialFilePath,
                downloadEtag: downloadEtag,
                downloadLastModified: downloadLastModified,
                byteLength: byteLength,
                bytesTransferred: bytesTransferred,
                totalBytes: totalBytes,
                error: error,
                message: message,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                Value<String?> brokerProfileId = const Value.absent(),
                required String tool,
                required String sessionId,
                required String actionKey,
                required String fileName,
                required String direction,
                required String status,
                Value<int> attemptCount = const Value.absent(),
                Value<String?> artifactKey = const Value.absent(),
                Value<String?> sourceUrl = const Value.absent(),
                Value<String?> cachedFilePath = const Value.absent(),
                Value<String?> exportedPath = const Value.absent(),
                Value<String?> contentType = const Value.absent(),
                Value<String?> contentHash = const Value.absent(),
                Value<String?> uploadId = const Value.absent(),
                Value<String?> partialFilePath = const Value.absent(),
                Value<String?> downloadEtag = const Value.absent(),
                Value<String?> downloadLastModified = const Value.absent(),
                Value<int?> byteLength = const Value.absent(),
                Value<int?> bytesTransferred = const Value.absent(),
                Value<int?> totalBytes = const Value.absent(),
                Value<String?> error = const Value.absent(),
                Value<String> message = const Value.absent(),
                required DateTime createdAt,
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => ArtifactTransferRowsCompanion.insert(
                id: id,
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                actionKey: actionKey,
                fileName: fileName,
                direction: direction,
                status: status,
                attemptCount: attemptCount,
                artifactKey: artifactKey,
                sourceUrl: sourceUrl,
                cachedFilePath: cachedFilePath,
                exportedPath: exportedPath,
                contentType: contentType,
                contentHash: contentHash,
                uploadId: uploadId,
                partialFilePath: partialFilePath,
                downloadEtag: downloadEtag,
                downloadLastModified: downloadLastModified,
                byteLength: byteLength,
                bytesTransferred: bytesTransferred,
                totalBytes: totalBytes,
                error: error,
                message: message,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ArtifactTransferRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ArtifactTransferRowsTable,
      ArtifactTransferRow,
      $$ArtifactTransferRowsTableFilterComposer,
      $$ArtifactTransferRowsTableOrderingComposer,
      $$ArtifactTransferRowsTableAnnotationComposer,
      $$ArtifactTransferRowsTableCreateCompanionBuilder,
      $$ArtifactTransferRowsTableUpdateCompanionBuilder,
      (
        ArtifactTransferRow,
        BaseReferences<
          _$AppDatabase,
          $ArtifactTransferRowsTable,
          ArtifactTransferRow
        >,
      ),
      ArtifactTransferRow,
      PrefetchHooks Function()
    >;
typedef $$BrokerProfileRowsTableCreateCompanionBuilder =
    BrokerProfileRowsCompanion Function({
      required String id,
      required String displayName,
      required String baseUri,
      required DateTime createdAt,
      Value<String?> incarnationId,
      Value<DateTime?> updatedAt,
      Value<DateTime?> lastUsedAt,
      Value<String?> credentialKey,
      Value<int> rowid,
    });
typedef $$BrokerProfileRowsTableUpdateCompanionBuilder =
    BrokerProfileRowsCompanion Function({
      Value<String> id,
      Value<String> displayName,
      Value<String> baseUri,
      Value<DateTime> createdAt,
      Value<String?> incarnationId,
      Value<DateTime?> updatedAt,
      Value<DateTime?> lastUsedAt,
      Value<String?> credentialKey,
      Value<int> rowid,
    });

class $$BrokerProfileRowsTableFilterComposer
    extends Composer<_$AppDatabase, $BrokerProfileRowsTable> {
  $$BrokerProfileRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get displayName => $composableBuilder(
    column: $table.displayName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get baseUri => $composableBuilder(
    column: $table.baseUri,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get incarnationId => $composableBuilder(
    column: $table.incarnationId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get lastUsedAt => $composableBuilder(
    column: $table.lastUsedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get credentialKey => $composableBuilder(
    column: $table.credentialKey,
    builder: (column) => ColumnFilters(column),
  );
}

class $$BrokerProfileRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $BrokerProfileRowsTable> {
  $$BrokerProfileRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get displayName => $composableBuilder(
    column: $table.displayName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get baseUri => $composableBuilder(
    column: $table.baseUri,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get incarnationId => $composableBuilder(
    column: $table.incarnationId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get lastUsedAt => $composableBuilder(
    column: $table.lastUsedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get credentialKey => $composableBuilder(
    column: $table.credentialKey,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$BrokerProfileRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $BrokerProfileRowsTable> {
  $$BrokerProfileRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get displayName => $composableBuilder(
    column: $table.displayName,
    builder: (column) => column,
  );

  GeneratedColumn<String> get baseUri =>
      $composableBuilder(column: $table.baseUri, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<String> get incarnationId => $composableBuilder(
    column: $table.incarnationId,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  GeneratedColumn<DateTime> get lastUsedAt => $composableBuilder(
    column: $table.lastUsedAt,
    builder: (column) => column,
  );

  GeneratedColumn<String> get credentialKey => $composableBuilder(
    column: $table.credentialKey,
    builder: (column) => column,
  );
}

class $$BrokerProfileRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $BrokerProfileRowsTable,
          BrokerProfileRow,
          $$BrokerProfileRowsTableFilterComposer,
          $$BrokerProfileRowsTableOrderingComposer,
          $$BrokerProfileRowsTableAnnotationComposer,
          $$BrokerProfileRowsTableCreateCompanionBuilder,
          $$BrokerProfileRowsTableUpdateCompanionBuilder,
          (
            BrokerProfileRow,
            BaseReferences<
              _$AppDatabase,
              $BrokerProfileRowsTable,
              BrokerProfileRow
            >,
          ),
          BrokerProfileRow,
          PrefetchHooks Function()
        > {
  $$BrokerProfileRowsTableTableManager(
    _$AppDatabase db,
    $BrokerProfileRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$BrokerProfileRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$BrokerProfileRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$BrokerProfileRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> displayName = const Value.absent(),
                Value<String> baseUri = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<String?> incarnationId = const Value.absent(),
                Value<DateTime?> updatedAt = const Value.absent(),
                Value<DateTime?> lastUsedAt = const Value.absent(),
                Value<String?> credentialKey = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => BrokerProfileRowsCompanion(
                id: id,
                displayName: displayName,
                baseUri: baseUri,
                createdAt: createdAt,
                incarnationId: incarnationId,
                updatedAt: updatedAt,
                lastUsedAt: lastUsedAt,
                credentialKey: credentialKey,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String displayName,
                required String baseUri,
                required DateTime createdAt,
                Value<String?> incarnationId = const Value.absent(),
                Value<DateTime?> updatedAt = const Value.absent(),
                Value<DateTime?> lastUsedAt = const Value.absent(),
                Value<String?> credentialKey = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => BrokerProfileRowsCompanion.insert(
                id: id,
                displayName: displayName,
                baseUri: baseUri,
                createdAt: createdAt,
                incarnationId: incarnationId,
                updatedAt: updatedAt,
                lastUsedAt: lastUsedAt,
                credentialKey: credentialKey,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$BrokerProfileRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $BrokerProfileRowsTable,
      BrokerProfileRow,
      $$BrokerProfileRowsTableFilterComposer,
      $$BrokerProfileRowsTableOrderingComposer,
      $$BrokerProfileRowsTableAnnotationComposer,
      $$BrokerProfileRowsTableCreateCompanionBuilder,
      $$BrokerProfileRowsTableUpdateCompanionBuilder,
      (
        BrokerProfileRow,
        BaseReferences<
          _$AppDatabase,
          $BrokerProfileRowsTable,
          BrokerProfileRow
        >,
      ),
      BrokerProfileRow,
      PrefetchHooks Function()
    >;
typedef $$AttentionEventRowsTableCreateCompanionBuilder =
    AttentionEventRowsCompanion Function({
      required String brokerProfileId,
      required String eventId,
      required int cursor,
      required int revision,
      required int presentationRevision,
      Value<String?> presentationStage,
      required String kind,
      required String state,
      required String severity,
      required String dedupeKey,
      required String title,
      Value<String?> summary,
      Value<String?> sessionId,
      Value<String?> sessionTitle,
      Value<String?> requestId,
      Value<String?> turnId,
      Value<String?> goalKey,
      Value<String?> agent,
      Value<String?> actionKind,
      Value<String?> actionTool,
      Value<String?> actionSessionId,
      Value<String?> actionAgent,
      Value<int?> brokerReadAt,
      Value<bool> historicalBaseline,
      Value<int?> brokerDismissedAt,
      required int createdAt,
      required int updatedAt,
      Value<int?> resolvedAt,
      Value<int?> localReadAt,
      Value<int?> localDismissedAt,
      Value<int?> localDismissedRevision,
      Value<int> localPresentedRevision,
      required String rawEventJson,
      required DateTime persistedAt,
      Value<int> rowid,
    });
typedef $$AttentionEventRowsTableUpdateCompanionBuilder =
    AttentionEventRowsCompanion Function({
      Value<String> brokerProfileId,
      Value<String> eventId,
      Value<int> cursor,
      Value<int> revision,
      Value<int> presentationRevision,
      Value<String?> presentationStage,
      Value<String> kind,
      Value<String> state,
      Value<String> severity,
      Value<String> dedupeKey,
      Value<String> title,
      Value<String?> summary,
      Value<String?> sessionId,
      Value<String?> sessionTitle,
      Value<String?> requestId,
      Value<String?> turnId,
      Value<String?> goalKey,
      Value<String?> agent,
      Value<String?> actionKind,
      Value<String?> actionTool,
      Value<String?> actionSessionId,
      Value<String?> actionAgent,
      Value<int?> brokerReadAt,
      Value<bool> historicalBaseline,
      Value<int?> brokerDismissedAt,
      Value<int> createdAt,
      Value<int> updatedAt,
      Value<int?> resolvedAt,
      Value<int?> localReadAt,
      Value<int?> localDismissedAt,
      Value<int?> localDismissedRevision,
      Value<int> localPresentedRevision,
      Value<String> rawEventJson,
      Value<DateTime> persistedAt,
      Value<int> rowid,
    });

class $$AttentionEventRowsTableFilterComposer
    extends Composer<_$AppDatabase, $AttentionEventRowsTable> {
  $$AttentionEventRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get eventId => $composableBuilder(
    column: $table.eventId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get revision => $composableBuilder(
    column: $table.revision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get presentationRevision => $composableBuilder(
    column: $table.presentationRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get presentationStage => $composableBuilder(
    column: $table.presentationStage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get state => $composableBuilder(
    column: $table.state,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get severity => $composableBuilder(
    column: $table.severity,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get dedupeKey => $composableBuilder(
    column: $table.dedupeKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get summary => $composableBuilder(
    column: $table.summary,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionTitle => $composableBuilder(
    column: $table.sessionTitle,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get requestId => $composableBuilder(
    column: $table.requestId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get turnId => $composableBuilder(
    column: $table.turnId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get goalKey => $composableBuilder(
    column: $table.goalKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get agent => $composableBuilder(
    column: $table.agent,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get actionKind => $composableBuilder(
    column: $table.actionKind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get actionTool => $composableBuilder(
    column: $table.actionTool,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get actionSessionId => $composableBuilder(
    column: $table.actionSessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get actionAgent => $composableBuilder(
    column: $table.actionAgent,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get brokerReadAt => $composableBuilder(
    column: $table.brokerReadAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get historicalBaseline => $composableBuilder(
    column: $table.historicalBaseline,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get brokerDismissedAt => $composableBuilder(
    column: $table.brokerDismissedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get resolvedAt => $composableBuilder(
    column: $table.resolvedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get localReadAt => $composableBuilder(
    column: $table.localReadAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get localDismissedAt => $composableBuilder(
    column: $table.localDismissedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get localDismissedRevision => $composableBuilder(
    column: $table.localDismissedRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get localPresentedRevision => $composableBuilder(
    column: $table.localPresentedRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rawEventJson => $composableBuilder(
    column: $table.rawEventJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get persistedAt => $composableBuilder(
    column: $table.persistedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$AttentionEventRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $AttentionEventRowsTable> {
  $$AttentionEventRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get eventId => $composableBuilder(
    column: $table.eventId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get revision => $composableBuilder(
    column: $table.revision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get presentationRevision => $composableBuilder(
    column: $table.presentationRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get presentationStage => $composableBuilder(
    column: $table.presentationStage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get state => $composableBuilder(
    column: $table.state,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get severity => $composableBuilder(
    column: $table.severity,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get dedupeKey => $composableBuilder(
    column: $table.dedupeKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get summary => $composableBuilder(
    column: $table.summary,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionTitle => $composableBuilder(
    column: $table.sessionTitle,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get requestId => $composableBuilder(
    column: $table.requestId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get turnId => $composableBuilder(
    column: $table.turnId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get goalKey => $composableBuilder(
    column: $table.goalKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get agent => $composableBuilder(
    column: $table.agent,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get actionKind => $composableBuilder(
    column: $table.actionKind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get actionTool => $composableBuilder(
    column: $table.actionTool,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get actionSessionId => $composableBuilder(
    column: $table.actionSessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get actionAgent => $composableBuilder(
    column: $table.actionAgent,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get brokerReadAt => $composableBuilder(
    column: $table.brokerReadAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get historicalBaseline => $composableBuilder(
    column: $table.historicalBaseline,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get brokerDismissedAt => $composableBuilder(
    column: $table.brokerDismissedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get resolvedAt => $composableBuilder(
    column: $table.resolvedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get localReadAt => $composableBuilder(
    column: $table.localReadAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get localDismissedAt => $composableBuilder(
    column: $table.localDismissedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get localDismissedRevision => $composableBuilder(
    column: $table.localDismissedRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get localPresentedRevision => $composableBuilder(
    column: $table.localPresentedRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rawEventJson => $composableBuilder(
    column: $table.rawEventJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get persistedAt => $composableBuilder(
    column: $table.persistedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$AttentionEventRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $AttentionEventRowsTable> {
  $$AttentionEventRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get eventId =>
      $composableBuilder(column: $table.eventId, builder: (column) => column);

  GeneratedColumn<int> get cursor =>
      $composableBuilder(column: $table.cursor, builder: (column) => column);

  GeneratedColumn<int> get revision =>
      $composableBuilder(column: $table.revision, builder: (column) => column);

  GeneratedColumn<int> get presentationRevision => $composableBuilder(
    column: $table.presentationRevision,
    builder: (column) => column,
  );

  GeneratedColumn<String> get presentationStage => $composableBuilder(
    column: $table.presentationStage,
    builder: (column) => column,
  );

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get state =>
      $composableBuilder(column: $table.state, builder: (column) => column);

  GeneratedColumn<String> get severity =>
      $composableBuilder(column: $table.severity, builder: (column) => column);

  GeneratedColumn<String> get dedupeKey =>
      $composableBuilder(column: $table.dedupeKey, builder: (column) => column);

  GeneratedColumn<String> get title =>
      $composableBuilder(column: $table.title, builder: (column) => column);

  GeneratedColumn<String> get summary =>
      $composableBuilder(column: $table.summary, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get sessionTitle => $composableBuilder(
    column: $table.sessionTitle,
    builder: (column) => column,
  );

  GeneratedColumn<String> get requestId =>
      $composableBuilder(column: $table.requestId, builder: (column) => column);

  GeneratedColumn<String> get turnId =>
      $composableBuilder(column: $table.turnId, builder: (column) => column);

  GeneratedColumn<String> get goalKey =>
      $composableBuilder(column: $table.goalKey, builder: (column) => column);

  GeneratedColumn<String> get agent =>
      $composableBuilder(column: $table.agent, builder: (column) => column);

  GeneratedColumn<String> get actionKind => $composableBuilder(
    column: $table.actionKind,
    builder: (column) => column,
  );

  GeneratedColumn<String> get actionTool => $composableBuilder(
    column: $table.actionTool,
    builder: (column) => column,
  );

  GeneratedColumn<String> get actionSessionId => $composableBuilder(
    column: $table.actionSessionId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get actionAgent => $composableBuilder(
    column: $table.actionAgent,
    builder: (column) => column,
  );

  GeneratedColumn<int> get brokerReadAt => $composableBuilder(
    column: $table.brokerReadAt,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get historicalBaseline => $composableBuilder(
    column: $table.historicalBaseline,
    builder: (column) => column,
  );

  GeneratedColumn<int> get brokerDismissedAt => $composableBuilder(
    column: $table.brokerDismissedAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<int> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  GeneratedColumn<int> get resolvedAt => $composableBuilder(
    column: $table.resolvedAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get localReadAt => $composableBuilder(
    column: $table.localReadAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get localDismissedAt => $composableBuilder(
    column: $table.localDismissedAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get localDismissedRevision => $composableBuilder(
    column: $table.localDismissedRevision,
    builder: (column) => column,
  );

  GeneratedColumn<int> get localPresentedRevision => $composableBuilder(
    column: $table.localPresentedRevision,
    builder: (column) => column,
  );

  GeneratedColumn<String> get rawEventJson => $composableBuilder(
    column: $table.rawEventJson,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get persistedAt => $composableBuilder(
    column: $table.persistedAt,
    builder: (column) => column,
  );
}

class $$AttentionEventRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $AttentionEventRowsTable,
          AttentionEventRow,
          $$AttentionEventRowsTableFilterComposer,
          $$AttentionEventRowsTableOrderingComposer,
          $$AttentionEventRowsTableAnnotationComposer,
          $$AttentionEventRowsTableCreateCompanionBuilder,
          $$AttentionEventRowsTableUpdateCompanionBuilder,
          (
            AttentionEventRow,
            BaseReferences<
              _$AppDatabase,
              $AttentionEventRowsTable,
              AttentionEventRow
            >,
          ),
          AttentionEventRow,
          PrefetchHooks Function()
        > {
  $$AttentionEventRowsTableTableManager(
    _$AppDatabase db,
    $AttentionEventRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$AttentionEventRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$AttentionEventRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$AttentionEventRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> brokerProfileId = const Value.absent(),
                Value<String> eventId = const Value.absent(),
                Value<int> cursor = const Value.absent(),
                Value<int> revision = const Value.absent(),
                Value<int> presentationRevision = const Value.absent(),
                Value<String?> presentationStage = const Value.absent(),
                Value<String> kind = const Value.absent(),
                Value<String> state = const Value.absent(),
                Value<String> severity = const Value.absent(),
                Value<String> dedupeKey = const Value.absent(),
                Value<String> title = const Value.absent(),
                Value<String?> summary = const Value.absent(),
                Value<String?> sessionId = const Value.absent(),
                Value<String?> sessionTitle = const Value.absent(),
                Value<String?> requestId = const Value.absent(),
                Value<String?> turnId = const Value.absent(),
                Value<String?> goalKey = const Value.absent(),
                Value<String?> agent = const Value.absent(),
                Value<String?> actionKind = const Value.absent(),
                Value<String?> actionTool = const Value.absent(),
                Value<String?> actionSessionId = const Value.absent(),
                Value<String?> actionAgent = const Value.absent(),
                Value<int?> brokerReadAt = const Value.absent(),
                Value<bool> historicalBaseline = const Value.absent(),
                Value<int?> brokerDismissedAt = const Value.absent(),
                Value<int> createdAt = const Value.absent(),
                Value<int> updatedAt = const Value.absent(),
                Value<int?> resolvedAt = const Value.absent(),
                Value<int?> localReadAt = const Value.absent(),
                Value<int?> localDismissedAt = const Value.absent(),
                Value<int?> localDismissedRevision = const Value.absent(),
                Value<int> localPresentedRevision = const Value.absent(),
                Value<String> rawEventJson = const Value.absent(),
                Value<DateTime> persistedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => AttentionEventRowsCompanion(
                brokerProfileId: brokerProfileId,
                eventId: eventId,
                cursor: cursor,
                revision: revision,
                presentationRevision: presentationRevision,
                presentationStage: presentationStage,
                kind: kind,
                state: state,
                severity: severity,
                dedupeKey: dedupeKey,
                title: title,
                summary: summary,
                sessionId: sessionId,
                sessionTitle: sessionTitle,
                requestId: requestId,
                turnId: turnId,
                goalKey: goalKey,
                agent: agent,
                actionKind: actionKind,
                actionTool: actionTool,
                actionSessionId: actionSessionId,
                actionAgent: actionAgent,
                brokerReadAt: brokerReadAt,
                historicalBaseline: historicalBaseline,
                brokerDismissedAt: brokerDismissedAt,
                createdAt: createdAt,
                updatedAt: updatedAt,
                resolvedAt: resolvedAt,
                localReadAt: localReadAt,
                localDismissedAt: localDismissedAt,
                localDismissedRevision: localDismissedRevision,
                localPresentedRevision: localPresentedRevision,
                rawEventJson: rawEventJson,
                persistedAt: persistedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String brokerProfileId,
                required String eventId,
                required int cursor,
                required int revision,
                required int presentationRevision,
                Value<String?> presentationStage = const Value.absent(),
                required String kind,
                required String state,
                required String severity,
                required String dedupeKey,
                required String title,
                Value<String?> summary = const Value.absent(),
                Value<String?> sessionId = const Value.absent(),
                Value<String?> sessionTitle = const Value.absent(),
                Value<String?> requestId = const Value.absent(),
                Value<String?> turnId = const Value.absent(),
                Value<String?> goalKey = const Value.absent(),
                Value<String?> agent = const Value.absent(),
                Value<String?> actionKind = const Value.absent(),
                Value<String?> actionTool = const Value.absent(),
                Value<String?> actionSessionId = const Value.absent(),
                Value<String?> actionAgent = const Value.absent(),
                Value<int?> brokerReadAt = const Value.absent(),
                Value<bool> historicalBaseline = const Value.absent(),
                Value<int?> brokerDismissedAt = const Value.absent(),
                required int createdAt,
                required int updatedAt,
                Value<int?> resolvedAt = const Value.absent(),
                Value<int?> localReadAt = const Value.absent(),
                Value<int?> localDismissedAt = const Value.absent(),
                Value<int?> localDismissedRevision = const Value.absent(),
                Value<int> localPresentedRevision = const Value.absent(),
                required String rawEventJson,
                required DateTime persistedAt,
                Value<int> rowid = const Value.absent(),
              }) => AttentionEventRowsCompanion.insert(
                brokerProfileId: brokerProfileId,
                eventId: eventId,
                cursor: cursor,
                revision: revision,
                presentationRevision: presentationRevision,
                presentationStage: presentationStage,
                kind: kind,
                state: state,
                severity: severity,
                dedupeKey: dedupeKey,
                title: title,
                summary: summary,
                sessionId: sessionId,
                sessionTitle: sessionTitle,
                requestId: requestId,
                turnId: turnId,
                goalKey: goalKey,
                agent: agent,
                actionKind: actionKind,
                actionTool: actionTool,
                actionSessionId: actionSessionId,
                actionAgent: actionAgent,
                brokerReadAt: brokerReadAt,
                historicalBaseline: historicalBaseline,
                brokerDismissedAt: brokerDismissedAt,
                createdAt: createdAt,
                updatedAt: updatedAt,
                resolvedAt: resolvedAt,
                localReadAt: localReadAt,
                localDismissedAt: localDismissedAt,
                localDismissedRevision: localDismissedRevision,
                localPresentedRevision: localPresentedRevision,
                rawEventJson: rawEventJson,
                persistedAt: persistedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$AttentionEventRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $AttentionEventRowsTable,
      AttentionEventRow,
      $$AttentionEventRowsTableFilterComposer,
      $$AttentionEventRowsTableOrderingComposer,
      $$AttentionEventRowsTableAnnotationComposer,
      $$AttentionEventRowsTableCreateCompanionBuilder,
      $$AttentionEventRowsTableUpdateCompanionBuilder,
      (
        AttentionEventRow,
        BaseReferences<
          _$AppDatabase,
          $AttentionEventRowsTable,
          AttentionEventRow
        >,
      ),
      AttentionEventRow,
      PrefetchHooks Function()
    >;
typedef $$AttentionCursorRowsTableCreateCompanionBuilder =
    AttentionCursorRowsCompanion Function({
      required String brokerProfileId,
      required int cursor,
      Value<int?> baselineThroughCursor,
      Value<bool> initialSyncComplete,
      required DateTime persistedAt,
      Value<int> rowid,
    });
typedef $$AttentionCursorRowsTableUpdateCompanionBuilder =
    AttentionCursorRowsCompanion Function({
      Value<String> brokerProfileId,
      Value<int> cursor,
      Value<int?> baselineThroughCursor,
      Value<bool> initialSyncComplete,
      Value<DateTime> persistedAt,
      Value<int> rowid,
    });

class $$AttentionCursorRowsTableFilterComposer
    extends Composer<_$AppDatabase, $AttentionCursorRowsTable> {
  $$AttentionCursorRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get baselineThroughCursor => $composableBuilder(
    column: $table.baselineThroughCursor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get initialSyncComplete => $composableBuilder(
    column: $table.initialSyncComplete,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get persistedAt => $composableBuilder(
    column: $table.persistedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$AttentionCursorRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $AttentionCursorRowsTable> {
  $$AttentionCursorRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get baselineThroughCursor => $composableBuilder(
    column: $table.baselineThroughCursor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get initialSyncComplete => $composableBuilder(
    column: $table.initialSyncComplete,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get persistedAt => $composableBuilder(
    column: $table.persistedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$AttentionCursorRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $AttentionCursorRowsTable> {
  $$AttentionCursorRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<int> get cursor =>
      $composableBuilder(column: $table.cursor, builder: (column) => column);

  GeneratedColumn<int> get baselineThroughCursor => $composableBuilder(
    column: $table.baselineThroughCursor,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get initialSyncComplete => $composableBuilder(
    column: $table.initialSyncComplete,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get persistedAt => $composableBuilder(
    column: $table.persistedAt,
    builder: (column) => column,
  );
}

class $$AttentionCursorRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $AttentionCursorRowsTable,
          AttentionCursorRow,
          $$AttentionCursorRowsTableFilterComposer,
          $$AttentionCursorRowsTableOrderingComposer,
          $$AttentionCursorRowsTableAnnotationComposer,
          $$AttentionCursorRowsTableCreateCompanionBuilder,
          $$AttentionCursorRowsTableUpdateCompanionBuilder,
          (
            AttentionCursorRow,
            BaseReferences<
              _$AppDatabase,
              $AttentionCursorRowsTable,
              AttentionCursorRow
            >,
          ),
          AttentionCursorRow,
          PrefetchHooks Function()
        > {
  $$AttentionCursorRowsTableTableManager(
    _$AppDatabase db,
    $AttentionCursorRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$AttentionCursorRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$AttentionCursorRowsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$AttentionCursorRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> brokerProfileId = const Value.absent(),
                Value<int> cursor = const Value.absent(),
                Value<int?> baselineThroughCursor = const Value.absent(),
                Value<bool> initialSyncComplete = const Value.absent(),
                Value<DateTime> persistedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => AttentionCursorRowsCompanion(
                brokerProfileId: brokerProfileId,
                cursor: cursor,
                baselineThroughCursor: baselineThroughCursor,
                initialSyncComplete: initialSyncComplete,
                persistedAt: persistedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String brokerProfileId,
                required int cursor,
                Value<int?> baselineThroughCursor = const Value.absent(),
                Value<bool> initialSyncComplete = const Value.absent(),
                required DateTime persistedAt,
                Value<int> rowid = const Value.absent(),
              }) => AttentionCursorRowsCompanion.insert(
                brokerProfileId: brokerProfileId,
                cursor: cursor,
                baselineThroughCursor: baselineThroughCursor,
                initialSyncComplete: initialSyncComplete,
                persistedAt: persistedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$AttentionCursorRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $AttentionCursorRowsTable,
      AttentionCursorRow,
      $$AttentionCursorRowsTableFilterComposer,
      $$AttentionCursorRowsTableOrderingComposer,
      $$AttentionCursorRowsTableAnnotationComposer,
      $$AttentionCursorRowsTableCreateCompanionBuilder,
      $$AttentionCursorRowsTableUpdateCompanionBuilder,
      (
        AttentionCursorRow,
        BaseReferences<
          _$AppDatabase,
          $AttentionCursorRowsTable,
          AttentionCursorRow
        >,
      ),
      AttentionCursorRow,
      PrefetchHooks Function()
    >;
typedef $$AppSettingRowsTableCreateCompanionBuilder =
    AppSettingRowsCompanion Function({
      required String key,
      required String value,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$AppSettingRowsTableUpdateCompanionBuilder =
    AppSettingRowsCompanion Function({
      Value<String> key,
      Value<String> value,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$AppSettingRowsTableFilterComposer
    extends Composer<_$AppDatabase, $AppSettingRowsTable> {
  $$AppSettingRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get key => $composableBuilder(
    column: $table.key,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get value => $composableBuilder(
    column: $table.value,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$AppSettingRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $AppSettingRowsTable> {
  $$AppSettingRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get key => $composableBuilder(
    column: $table.key,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get value => $composableBuilder(
    column: $table.value,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$AppSettingRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $AppSettingRowsTable> {
  $$AppSettingRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get key =>
      $composableBuilder(column: $table.key, builder: (column) => column);

  GeneratedColumn<String> get value =>
      $composableBuilder(column: $table.value, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$AppSettingRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $AppSettingRowsTable,
          AppSettingRow,
          $$AppSettingRowsTableFilterComposer,
          $$AppSettingRowsTableOrderingComposer,
          $$AppSettingRowsTableAnnotationComposer,
          $$AppSettingRowsTableCreateCompanionBuilder,
          $$AppSettingRowsTableUpdateCompanionBuilder,
          (
            AppSettingRow,
            BaseReferences<_$AppDatabase, $AppSettingRowsTable, AppSettingRow>,
          ),
          AppSettingRow,
          PrefetchHooks Function()
        > {
  $$AppSettingRowsTableTableManager(
    _$AppDatabase db,
    $AppSettingRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$AppSettingRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$AppSettingRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$AppSettingRowsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> key = const Value.absent(),
                Value<String> value = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => AppSettingRowsCompanion(
                key: key,
                value: value,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String key,
                required String value,
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => AppSettingRowsCompanion.insert(
                key: key,
                value: value,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$AppSettingRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $AppSettingRowsTable,
      AppSettingRow,
      $$AppSettingRowsTableFilterComposer,
      $$AppSettingRowsTableOrderingComposer,
      $$AppSettingRowsTableAnnotationComposer,
      $$AppSettingRowsTableCreateCompanionBuilder,
      $$AppSettingRowsTableUpdateCompanionBuilder,
      (
        AppSettingRow,
        BaseReferences<_$AppDatabase, $AppSettingRowsTable, AppSettingRow>,
      ),
      AppSettingRow,
      PrefetchHooks Function()
    >;
typedef $$SessionOutboxRowsTableCreateCompanionBuilder =
    SessionOutboxRowsCompanion Function({
      required String clientMessageId,
      Value<String?> brokerProfileId,
      required String tool,
      required String sessionId,
      required String kind,
      required String payloadJson,
      required String status,
      Value<int> attemptCount,
      Value<String?> lastError,
      required DateTime createdAt,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$SessionOutboxRowsTableUpdateCompanionBuilder =
    SessionOutboxRowsCompanion Function({
      Value<String> clientMessageId,
      Value<String?> brokerProfileId,
      Value<String> tool,
      Value<String> sessionId,
      Value<String> kind,
      Value<String> payloadJson,
      Value<String> status,
      Value<int> attemptCount,
      Value<String?> lastError,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$SessionOutboxRowsTableFilterComposer
    extends Composer<_$AppDatabase, $SessionOutboxRowsTable> {
  $$SessionOutboxRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get clientMessageId => $composableBuilder(
    column: $table.clientMessageId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attemptCount => $composableBuilder(
    column: $table.attemptCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionOutboxRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $SessionOutboxRowsTable> {
  $$SessionOutboxRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get clientMessageId => $composableBuilder(
    column: $table.clientMessageId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attemptCount => $composableBuilder(
    column: $table.attemptCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionOutboxRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $SessionOutboxRowsTable> {
  $$SessionOutboxRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get clientMessageId => $composableBuilder(
    column: $table.clientMessageId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get tool =>
      $composableBuilder(column: $table.tool, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<int> get attemptCount => $composableBuilder(
    column: $table.attemptCount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$SessionOutboxRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $SessionOutboxRowsTable,
          SessionOutboxRow,
          $$SessionOutboxRowsTableFilterComposer,
          $$SessionOutboxRowsTableOrderingComposer,
          $$SessionOutboxRowsTableAnnotationComposer,
          $$SessionOutboxRowsTableCreateCompanionBuilder,
          $$SessionOutboxRowsTableUpdateCompanionBuilder,
          (
            SessionOutboxRow,
            BaseReferences<
              _$AppDatabase,
              $SessionOutboxRowsTable,
              SessionOutboxRow
            >,
          ),
          SessionOutboxRow,
          PrefetchHooks Function()
        > {
  $$SessionOutboxRowsTableTableManager(
    _$AppDatabase db,
    $SessionOutboxRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionOutboxRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionOutboxRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionOutboxRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> clientMessageId = const Value.absent(),
                Value<String?> brokerProfileId = const Value.absent(),
                Value<String> tool = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> kind = const Value.absent(),
                Value<String> payloadJson = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> attemptCount = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionOutboxRowsCompanion(
                clientMessageId: clientMessageId,
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                kind: kind,
                payloadJson: payloadJson,
                status: status,
                attemptCount: attemptCount,
                lastError: lastError,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String clientMessageId,
                Value<String?> brokerProfileId = const Value.absent(),
                required String tool,
                required String sessionId,
                required String kind,
                required String payloadJson,
                required String status,
                Value<int> attemptCount = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                required DateTime createdAt,
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => SessionOutboxRowsCompanion.insert(
                clientMessageId: clientMessageId,
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                kind: kind,
                payloadJson: payloadJson,
                status: status,
                attemptCount: attemptCount,
                lastError: lastError,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionOutboxRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $SessionOutboxRowsTable,
      SessionOutboxRow,
      $$SessionOutboxRowsTableFilterComposer,
      $$SessionOutboxRowsTableOrderingComposer,
      $$SessionOutboxRowsTableAnnotationComposer,
      $$SessionOutboxRowsTableCreateCompanionBuilder,
      $$SessionOutboxRowsTableUpdateCompanionBuilder,
      (
        SessionOutboxRow,
        BaseReferences<
          _$AppDatabase,
          $SessionOutboxRowsTable,
          SessionOutboxRow
        >,
      ),
      SessionOutboxRow,
      PrefetchHooks Function()
    >;
typedef $$SessionTranscriptRowsTableCreateCompanionBuilder =
    SessionTranscriptRowsCompanion Function({
      required String brokerProfileId,
      required String tool,
      required String sessionId,
      required String messagesJson,
      Value<String?> cursor,
      Value<String?> olderCursor,
      Value<bool> hasEarlier,
      Value<String?> gapJson,
      Value<String?> truncationJson,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$SessionTranscriptRowsTableUpdateCompanionBuilder =
    SessionTranscriptRowsCompanion Function({
      Value<String> brokerProfileId,
      Value<String> tool,
      Value<String> sessionId,
      Value<String> messagesJson,
      Value<String?> cursor,
      Value<String?> olderCursor,
      Value<bool> hasEarlier,
      Value<String?> gapJson,
      Value<String?> truncationJson,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$SessionTranscriptRowsTableFilterComposer
    extends Composer<_$AppDatabase, $SessionTranscriptRowsTable> {
  $$SessionTranscriptRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get messagesJson => $composableBuilder(
    column: $table.messagesJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get olderCursor => $composableBuilder(
    column: $table.olderCursor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get hasEarlier => $composableBuilder(
    column: $table.hasEarlier,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get gapJson => $composableBuilder(
    column: $table.gapJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get truncationJson => $composableBuilder(
    column: $table.truncationJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionTranscriptRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $SessionTranscriptRowsTable> {
  $$SessionTranscriptRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get messagesJson => $composableBuilder(
    column: $table.messagesJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get olderCursor => $composableBuilder(
    column: $table.olderCursor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get hasEarlier => $composableBuilder(
    column: $table.hasEarlier,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get gapJson => $composableBuilder(
    column: $table.gapJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get truncationJson => $composableBuilder(
    column: $table.truncationJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionTranscriptRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $SessionTranscriptRowsTable> {
  $$SessionTranscriptRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get tool =>
      $composableBuilder(column: $table.tool, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get messagesJson => $composableBuilder(
    column: $table.messagesJson,
    builder: (column) => column,
  );

  GeneratedColumn<String> get cursor =>
      $composableBuilder(column: $table.cursor, builder: (column) => column);

  GeneratedColumn<String> get olderCursor => $composableBuilder(
    column: $table.olderCursor,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get hasEarlier => $composableBuilder(
    column: $table.hasEarlier,
    builder: (column) => column,
  );

  GeneratedColumn<String> get gapJson =>
      $composableBuilder(column: $table.gapJson, builder: (column) => column);

  GeneratedColumn<String> get truncationJson => $composableBuilder(
    column: $table.truncationJson,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$SessionTranscriptRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $SessionTranscriptRowsTable,
          SessionTranscriptRow,
          $$SessionTranscriptRowsTableFilterComposer,
          $$SessionTranscriptRowsTableOrderingComposer,
          $$SessionTranscriptRowsTableAnnotationComposer,
          $$SessionTranscriptRowsTableCreateCompanionBuilder,
          $$SessionTranscriptRowsTableUpdateCompanionBuilder,
          (
            SessionTranscriptRow,
            BaseReferences<
              _$AppDatabase,
              $SessionTranscriptRowsTable,
              SessionTranscriptRow
            >,
          ),
          SessionTranscriptRow,
          PrefetchHooks Function()
        > {
  $$SessionTranscriptRowsTableTableManager(
    _$AppDatabase db,
    $SessionTranscriptRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionTranscriptRowsTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$SessionTranscriptRowsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$SessionTranscriptRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> brokerProfileId = const Value.absent(),
                Value<String> tool = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> messagesJson = const Value.absent(),
                Value<String?> cursor = const Value.absent(),
                Value<String?> olderCursor = const Value.absent(),
                Value<bool> hasEarlier = const Value.absent(),
                Value<String?> gapJson = const Value.absent(),
                Value<String?> truncationJson = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionTranscriptRowsCompanion(
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                messagesJson: messagesJson,
                cursor: cursor,
                olderCursor: olderCursor,
                hasEarlier: hasEarlier,
                gapJson: gapJson,
                truncationJson: truncationJson,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String brokerProfileId,
                required String tool,
                required String sessionId,
                required String messagesJson,
                Value<String?> cursor = const Value.absent(),
                Value<String?> olderCursor = const Value.absent(),
                Value<bool> hasEarlier = const Value.absent(),
                Value<String?> gapJson = const Value.absent(),
                Value<String?> truncationJson = const Value.absent(),
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => SessionTranscriptRowsCompanion.insert(
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                messagesJson: messagesJson,
                cursor: cursor,
                olderCursor: olderCursor,
                hasEarlier: hasEarlier,
                gapJson: gapJson,
                truncationJson: truncationJson,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionTranscriptRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $SessionTranscriptRowsTable,
      SessionTranscriptRow,
      $$SessionTranscriptRowsTableFilterComposer,
      $$SessionTranscriptRowsTableOrderingComposer,
      $$SessionTranscriptRowsTableAnnotationComposer,
      $$SessionTranscriptRowsTableCreateCompanionBuilder,
      $$SessionTranscriptRowsTableUpdateCompanionBuilder,
      (
        SessionTranscriptRow,
        BaseReferences<
          _$AppDatabase,
          $SessionTranscriptRowsTable,
          SessionTranscriptRow
        >,
      ),
      SessionTranscriptRow,
      PrefetchHooks Function()
    >;
typedef $$SessionDraftRowsTableCreateCompanionBuilder =
    SessionDraftRowsCompanion Function({
      required String brokerProfileId,
      required String tool,
      required String sessionId,
      required String draftText,
      Value<int> localRevision,
      Value<int> baseBrokerRevision,
      Value<bool> dirty,
      Value<String?> submittedClientMessageId,
      Value<int> mutationVersion,
      Value<int?> pendingClearRevision,
      Value<String?> conflictText,
      Value<int?> conflictBrokerRevision,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$SessionDraftRowsTableUpdateCompanionBuilder =
    SessionDraftRowsCompanion Function({
      Value<String> brokerProfileId,
      Value<String> tool,
      Value<String> sessionId,
      Value<String> draftText,
      Value<int> localRevision,
      Value<int> baseBrokerRevision,
      Value<bool> dirty,
      Value<String?> submittedClientMessageId,
      Value<int> mutationVersion,
      Value<int?> pendingClearRevision,
      Value<String?> conflictText,
      Value<int?> conflictBrokerRevision,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$SessionDraftRowsTableFilterComposer
    extends Composer<_$AppDatabase, $SessionDraftRowsTable> {
  $$SessionDraftRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get draftText => $composableBuilder(
    column: $table.draftText,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get localRevision => $composableBuilder(
    column: $table.localRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get baseBrokerRevision => $composableBuilder(
    column: $table.baseBrokerRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get dirty => $composableBuilder(
    column: $table.dirty,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get submittedClientMessageId => $composableBuilder(
    column: $table.submittedClientMessageId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get mutationVersion => $composableBuilder(
    column: $table.mutationVersion,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get pendingClearRevision => $composableBuilder(
    column: $table.pendingClearRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get conflictText => $composableBuilder(
    column: $table.conflictText,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get conflictBrokerRevision => $composableBuilder(
    column: $table.conflictBrokerRevision,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SessionDraftRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $SessionDraftRowsTable> {
  $$SessionDraftRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tool => $composableBuilder(
    column: $table.tool,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get draftText => $composableBuilder(
    column: $table.draftText,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get localRevision => $composableBuilder(
    column: $table.localRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get baseBrokerRevision => $composableBuilder(
    column: $table.baseBrokerRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get dirty => $composableBuilder(
    column: $table.dirty,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get submittedClientMessageId => $composableBuilder(
    column: $table.submittedClientMessageId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get mutationVersion => $composableBuilder(
    column: $table.mutationVersion,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get pendingClearRevision => $composableBuilder(
    column: $table.pendingClearRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get conflictText => $composableBuilder(
    column: $table.conflictText,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get conflictBrokerRevision => $composableBuilder(
    column: $table.conflictBrokerRevision,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SessionDraftRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $SessionDraftRowsTable> {
  $$SessionDraftRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get tool =>
      $composableBuilder(column: $table.tool, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get draftText =>
      $composableBuilder(column: $table.draftText, builder: (column) => column);

  GeneratedColumn<int> get localRevision => $composableBuilder(
    column: $table.localRevision,
    builder: (column) => column,
  );

  GeneratedColumn<int> get baseBrokerRevision => $composableBuilder(
    column: $table.baseBrokerRevision,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get dirty =>
      $composableBuilder(column: $table.dirty, builder: (column) => column);

  GeneratedColumn<String> get submittedClientMessageId => $composableBuilder(
    column: $table.submittedClientMessageId,
    builder: (column) => column,
  );

  GeneratedColumn<int> get mutationVersion => $composableBuilder(
    column: $table.mutationVersion,
    builder: (column) => column,
  );

  GeneratedColumn<int> get pendingClearRevision => $composableBuilder(
    column: $table.pendingClearRevision,
    builder: (column) => column,
  );

  GeneratedColumn<String> get conflictText => $composableBuilder(
    column: $table.conflictText,
    builder: (column) => column,
  );

  GeneratedColumn<int> get conflictBrokerRevision => $composableBuilder(
    column: $table.conflictBrokerRevision,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$SessionDraftRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $SessionDraftRowsTable,
          SessionDraftRow,
          $$SessionDraftRowsTableFilterComposer,
          $$SessionDraftRowsTableOrderingComposer,
          $$SessionDraftRowsTableAnnotationComposer,
          $$SessionDraftRowsTableCreateCompanionBuilder,
          $$SessionDraftRowsTableUpdateCompanionBuilder,
          (
            SessionDraftRow,
            BaseReferences<
              _$AppDatabase,
              $SessionDraftRowsTable,
              SessionDraftRow
            >,
          ),
          SessionDraftRow,
          PrefetchHooks Function()
        > {
  $$SessionDraftRowsTableTableManager(
    _$AppDatabase db,
    $SessionDraftRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SessionDraftRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SessionDraftRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SessionDraftRowsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> brokerProfileId = const Value.absent(),
                Value<String> tool = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> draftText = const Value.absent(),
                Value<int> localRevision = const Value.absent(),
                Value<int> baseBrokerRevision = const Value.absent(),
                Value<bool> dirty = const Value.absent(),
                Value<String?> submittedClientMessageId = const Value.absent(),
                Value<int> mutationVersion = const Value.absent(),
                Value<int?> pendingClearRevision = const Value.absent(),
                Value<String?> conflictText = const Value.absent(),
                Value<int?> conflictBrokerRevision = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SessionDraftRowsCompanion(
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                draftText: draftText,
                localRevision: localRevision,
                baseBrokerRevision: baseBrokerRevision,
                dirty: dirty,
                submittedClientMessageId: submittedClientMessageId,
                mutationVersion: mutationVersion,
                pendingClearRevision: pendingClearRevision,
                conflictText: conflictText,
                conflictBrokerRevision: conflictBrokerRevision,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String brokerProfileId,
                required String tool,
                required String sessionId,
                required String draftText,
                Value<int> localRevision = const Value.absent(),
                Value<int> baseBrokerRevision = const Value.absent(),
                Value<bool> dirty = const Value.absent(),
                Value<String?> submittedClientMessageId = const Value.absent(),
                Value<int> mutationVersion = const Value.absent(),
                Value<int?> pendingClearRevision = const Value.absent(),
                Value<String?> conflictText = const Value.absent(),
                Value<int?> conflictBrokerRevision = const Value.absent(),
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => SessionDraftRowsCompanion.insert(
                brokerProfileId: brokerProfileId,
                tool: tool,
                sessionId: sessionId,
                draftText: draftText,
                localRevision: localRevision,
                baseBrokerRevision: baseBrokerRevision,
                dirty: dirty,
                submittedClientMessageId: submittedClientMessageId,
                mutationVersion: mutationVersion,
                pendingClearRevision: pendingClearRevision,
                conflictText: conflictText,
                conflictBrokerRevision: conflictBrokerRevision,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SessionDraftRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $SessionDraftRowsTable,
      SessionDraftRow,
      $$SessionDraftRowsTableFilterComposer,
      $$SessionDraftRowsTableOrderingComposer,
      $$SessionDraftRowsTableAnnotationComposer,
      $$SessionDraftRowsTableCreateCompanionBuilder,
      $$SessionDraftRowsTableUpdateCompanionBuilder,
      (
        SessionDraftRow,
        BaseReferences<_$AppDatabase, $SessionDraftRowsTable, SessionDraftRow>,
      ),
      SessionDraftRow,
      PrefetchHooks Function()
    >;
typedef $$RosterSnapshotRowsTableCreateCompanionBuilder =
    RosterSnapshotRowsCompanion Function({
      required String brokerProfileId,
      required String endpoint,
      required int payloadVersion,
      required String rowsJson,
      Value<int> rowCount,
      Value<int?> newestSessionUpdatedAt,
      required DateTime capturedAt,
      Value<int> rowid,
    });
typedef $$RosterSnapshotRowsTableUpdateCompanionBuilder =
    RosterSnapshotRowsCompanion Function({
      Value<String> brokerProfileId,
      Value<String> endpoint,
      Value<int> payloadVersion,
      Value<String> rowsJson,
      Value<int> rowCount,
      Value<int?> newestSessionUpdatedAt,
      Value<DateTime> capturedAt,
      Value<int> rowid,
    });

class $$RosterSnapshotRowsTableFilterComposer
    extends Composer<_$AppDatabase, $RosterSnapshotRowsTable> {
  $$RosterSnapshotRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get endpoint => $composableBuilder(
    column: $table.endpoint,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get payloadVersion => $composableBuilder(
    column: $table.payloadVersion,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rowsJson => $composableBuilder(
    column: $table.rowsJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get rowCount => $composableBuilder(
    column: $table.rowCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get newestSessionUpdatedAt => $composableBuilder(
    column: $table.newestSessionUpdatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get capturedAt => $composableBuilder(
    column: $table.capturedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$RosterSnapshotRowsTableOrderingComposer
    extends Composer<_$AppDatabase, $RosterSnapshotRowsTable> {
  $$RosterSnapshotRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get endpoint => $composableBuilder(
    column: $table.endpoint,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get payloadVersion => $composableBuilder(
    column: $table.payloadVersion,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rowsJson => $composableBuilder(
    column: $table.rowsJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get rowCount => $composableBuilder(
    column: $table.rowCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get newestSessionUpdatedAt => $composableBuilder(
    column: $table.newestSessionUpdatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get capturedAt => $composableBuilder(
    column: $table.capturedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$RosterSnapshotRowsTableAnnotationComposer
    extends Composer<_$AppDatabase, $RosterSnapshotRowsTable> {
  $$RosterSnapshotRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get brokerProfileId => $composableBuilder(
    column: $table.brokerProfileId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get endpoint =>
      $composableBuilder(column: $table.endpoint, builder: (column) => column);

  GeneratedColumn<int> get payloadVersion => $composableBuilder(
    column: $table.payloadVersion,
    builder: (column) => column,
  );

  GeneratedColumn<String> get rowsJson =>
      $composableBuilder(column: $table.rowsJson, builder: (column) => column);

  GeneratedColumn<int> get rowCount =>
      $composableBuilder(column: $table.rowCount, builder: (column) => column);

  GeneratedColumn<int> get newestSessionUpdatedAt => $composableBuilder(
    column: $table.newestSessionUpdatedAt,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get capturedAt => $composableBuilder(
    column: $table.capturedAt,
    builder: (column) => column,
  );
}

class $$RosterSnapshotRowsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $RosterSnapshotRowsTable,
          RosterSnapshotRow,
          $$RosterSnapshotRowsTableFilterComposer,
          $$RosterSnapshotRowsTableOrderingComposer,
          $$RosterSnapshotRowsTableAnnotationComposer,
          $$RosterSnapshotRowsTableCreateCompanionBuilder,
          $$RosterSnapshotRowsTableUpdateCompanionBuilder,
          (
            RosterSnapshotRow,
            BaseReferences<
              _$AppDatabase,
              $RosterSnapshotRowsTable,
              RosterSnapshotRow
            >,
          ),
          RosterSnapshotRow,
          PrefetchHooks Function()
        > {
  $$RosterSnapshotRowsTableTableManager(
    _$AppDatabase db,
    $RosterSnapshotRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$RosterSnapshotRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$RosterSnapshotRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$RosterSnapshotRowsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> brokerProfileId = const Value.absent(),
                Value<String> endpoint = const Value.absent(),
                Value<int> payloadVersion = const Value.absent(),
                Value<String> rowsJson = const Value.absent(),
                Value<int> rowCount = const Value.absent(),
                Value<int?> newestSessionUpdatedAt = const Value.absent(),
                Value<DateTime> capturedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => RosterSnapshotRowsCompanion(
                brokerProfileId: brokerProfileId,
                endpoint: endpoint,
                payloadVersion: payloadVersion,
                rowsJson: rowsJson,
                rowCount: rowCount,
                newestSessionUpdatedAt: newestSessionUpdatedAt,
                capturedAt: capturedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String brokerProfileId,
                required String endpoint,
                required int payloadVersion,
                required String rowsJson,
                Value<int> rowCount = const Value.absent(),
                Value<int?> newestSessionUpdatedAt = const Value.absent(),
                required DateTime capturedAt,
                Value<int> rowid = const Value.absent(),
              }) => RosterSnapshotRowsCompanion.insert(
                brokerProfileId: brokerProfileId,
                endpoint: endpoint,
                payloadVersion: payloadVersion,
                rowsJson: rowsJson,
                rowCount: rowCount,
                newestSessionUpdatedAt: newestSessionUpdatedAt,
                capturedAt: capturedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$RosterSnapshotRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $RosterSnapshotRowsTable,
      RosterSnapshotRow,
      $$RosterSnapshotRowsTableFilterComposer,
      $$RosterSnapshotRowsTableOrderingComposer,
      $$RosterSnapshotRowsTableAnnotationComposer,
      $$RosterSnapshotRowsTableCreateCompanionBuilder,
      $$RosterSnapshotRowsTableUpdateCompanionBuilder,
      (
        RosterSnapshotRow,
        BaseReferences<
          _$AppDatabase,
          $RosterSnapshotRowsTable,
          RosterSnapshotRow
        >,
      ),
      RosterSnapshotRow,
      PrefetchHooks Function()
    >;

class $AppDatabaseManager {
  final _$AppDatabase _db;
  $AppDatabaseManager(this._db);
  $$ArtifactTransferRowsTableTableManager get artifactTransferRows =>
      $$ArtifactTransferRowsTableTableManager(_db, _db.artifactTransferRows);
  $$BrokerProfileRowsTableTableManager get brokerProfileRows =>
      $$BrokerProfileRowsTableTableManager(_db, _db.brokerProfileRows);
  $$AttentionEventRowsTableTableManager get attentionEventRows =>
      $$AttentionEventRowsTableTableManager(_db, _db.attentionEventRows);
  $$AttentionCursorRowsTableTableManager get attentionCursorRows =>
      $$AttentionCursorRowsTableTableManager(_db, _db.attentionCursorRows);
  $$AppSettingRowsTableTableManager get appSettingRows =>
      $$AppSettingRowsTableTableManager(_db, _db.appSettingRows);
  $$SessionOutboxRowsTableTableManager get sessionOutboxRows =>
      $$SessionOutboxRowsTableTableManager(_db, _db.sessionOutboxRows);
  $$SessionTranscriptRowsTableTableManager get sessionTranscriptRows =>
      $$SessionTranscriptRowsTableTableManager(_db, _db.sessionTranscriptRows);
  $$SessionDraftRowsTableTableManager get sessionDraftRows =>
      $$SessionDraftRowsTableTableManager(_db, _db.sessionDraftRows);
  $$RosterSnapshotRowsTableTableManager get rosterSnapshotRows =>
      $$RosterSnapshotRowsTableTableManager(_db, _db.rosterSnapshotRows);
}
