import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'app_database.g.dart';

/// Durable local database for app state that must survive restarts.
///
/// See `docs/architecture/monorepo.md`.
@DriftDatabase(
  tables: [
    ArtifactTransferRows,
    BrokerProfileRows,
    AttentionEventRows,
    AttentionCursorRows,
    AppSettingRows,
    SessionOutboxRows,
    SessionTranscriptRows,
    SessionDraftRows,
    RosterSnapshotRows,
  ],
)
final class AppDatabase extends _$AppDatabase {
  /// Creates a database from an explicit executor.
  ///
  /// Tests pass an in-memory executor. Production code should use
  /// [AppDatabase.defaults].
  AppDatabase(super.executor);

  /// Opens the default on-device database.
  AppDatabase.defaults()
    : super(
        driftDatabase(
          name: 'cosyncing_client',
          web: DriftWebOptions(
            sqlite3Wasm: defaultWebSqlite3WasmUri,
            driftWorker: defaultWebDriftWorkerUri,
          ),
        ),
      );

  /// Default web path for the sqlite3 WASM module.
  static final Uri defaultWebSqlite3WasmUri = Uri.parse('sqlite3.wasm');

  /// Default web path for the compiled Drift worker.
  static final Uri defaultWebDriftWorkerUri = Uri.parse('drift_worker.js');

  @override
  int get schemaVersion => 19;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (migrator) async {
      // Enable incremental auto-vacuum BEFORE the first table exists so new
      // databases return freed pages in bounded `PRAGMA incremental_vacuum`
      // slices during opportunistic cleanup (DR1). Existing databases keep
      // their current vacuum mode — changing it would require a full VACUUM,
      // which the retention contract forbids as an automatic operation.
      await customStatement('PRAGMA auto_vacuum = INCREMENTAL');
      await migrator.createAll();
    },
    onUpgrade: (migrator, from, to) async {
      if (from < 2) {
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.bytesTransferred,
        );
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.totalBytes,
        );
      }
      if (from < 3) {
        await migrator.createTable(brokerProfileRows);
      }
      if (from < 4) {
        await migrator.createTable(appSettingRows);
      }
      if (from < 5) {
        await migrator.createTable(sessionOutboxRows);
      }
      if (from < 6) {
        await migrator.createTable(attentionEventRows);
        await migrator.createTable(attentionCursorRows);
      } else {
        if (from < 7) {
          await migrator.addColumn(
            attentionEventRows,
            attentionEventRows.brokerReadAt,
          );
          await migrator.addColumn(
            attentionEventRows,
            attentionEventRows.brokerDismissedAt,
          );
          await migrator.addColumn(
            attentionCursorRows,
            attentionCursorRows.initialSyncComplete,
          );
        }
        if (from < 8) {
          await migrator.addColumn(
            attentionEventRows,
            attentionEventRows.historicalBaseline,
          );
          await migrator.addColumn(
            attentionCursorRows,
            attentionCursorRows.baselineThroughCursor,
          );
        }
      }
      if (from < 9) {
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.uploadId,
        );
      }
      if (from < 10) {
        await migrator.createTable(sessionTranscriptRows);
      }
      if (from < 11) {
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.partialFilePath,
        );
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.downloadEtag,
        );
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.downloadLastModified,
        );
      }
      if (from < 12) {
        await migrator.addColumn(
          artifactTransferRows,
          artifactTransferRows.brokerProfileId,
        );
        // Versions before v5 create the current outbox table above, so its
        // profile column already exists. Only upgrade the historical table
        // shape when the outbox was present in the source database.
        if (from >= 5) {
          await migrator.addColumn(
            sessionOutboxRows,
            sessionOutboxRows.brokerProfileId,
          );
        }
        await customStatement('''
          UPDATE session_outbox_rows
          SET status = 'failed',
              last_error = 'Legacy outbox row has no broker profile.'
          WHERE broker_profile_id IS NULL
            AND status IN ('queued', 'sending', 'retryable')
        ''');
        await customStatement('''
          UPDATE artifact_transfer_rows
          SET status = 'failed',
              error = 'Legacy transfer has no broker profile.',
              message = 'Switching brokers cannot safely resume this legacy transfer.'
          WHERE broker_profile_id IS NULL
            AND status IN ('queued', 'running', 'failed', 'canceled')
        ''');
      }
      if (from < 13) {
        // DR1: durable device-local composer drafts plus the indexes the
        // bounded retention cleanup scans. createTable covers the draft
        // table's own declared index; the two existing tables gain their
        // cleanup indexes here (onCreate creates them for fresh databases).
        await migrator.createTable(sessionDraftRows);
        await customStatement(
          'CREATE INDEX IF NOT EXISTS idx_session_draft_profile_updated '
          'ON session_draft_rows(broker_profile_id, updated_at)',
        );
        await customStatement(
          'CREATE INDEX IF NOT EXISTS idx_session_outbox_status_updated '
          'ON session_outbox_rows(status, updated_at)',
        );
        await customStatement(
          'CREATE INDEX IF NOT EXISTS idx_session_transcript_profile_updated '
          'ON session_transcript_rows(broker_profile_id, updated_at)',
        );
      }
      if (from >= 13 && from < 15) {
        // DR1: optimistic concurrency for the draft row. A second tab shares
        // this file but not the in-process mutation chain, so a whole-row
        // upsert there silently discards whatever this one wrote in between.
        await migrator.addColumn(
          sessionDraftRows,
          sessionDraftRows.mutationVersion,
        );
      }
      if (from >= 13 && from < 14) {
        // DR1: a prompt whose shared draft could not be cleared leaves a
        // pending clear that must stay conditional on the revision it targets.
        // Databases upgrading from before v13 create the table above with the
        // column already declared, so only a v13 database needs it added.
        await migrator.addColumn(
          sessionDraftRows,
          sessionDraftRows.pendingClearRevision,
        );
      }
      if (from >= 6 && from < 16) {
        final attentionColumns = {
          for (final row in await customSelect(
            'PRAGMA table_info(attention_event_rows)',
          ).get())
            row.read<String>('name'),
        };
        if (attentionColumns.isNotEmpty &&
            !attentionColumns.contains('session_title')) {
          await migrator.addColumn(
            attentionEventRows,
            attentionEventRows.sessionTitle,
          );
        }
        if (attentionColumns.isNotEmpty &&
            !attentionColumns.contains('local_dismissed_revision')) {
          await migrator.addColumn(
            attentionEventRows,
            attentionEventRows.localDismissedRevision,
          );
        }
      }
      if (from < 17) {
        // N3: one bounded, identity-only roster snapshot per broker profile,
        // read once at startup so a cold web start shows real chrome instead of
        // an empty page. Additive: a new table only, so every existing profile,
        // attention, draft, outbox and transcript row is untouched.
        await migrator.createTable(rosterSnapshotRows);
      }
      if (from < 18) {
        final profileColumns = {
          for (final row in await customSelect(
            'PRAGMA table_info(broker_profile_rows)',
          ).get())
            row.read<String>('name'),
        };
        if (profileColumns.isNotEmpty &&
            !profileColumns.contains('incarnation_id')) {
          await migrator.addColumn(
            brokerProfileRows,
            brokerProfileRows.incarnationId,
          );
          await customStatement(
            'UPDATE broker_profile_rows '
            "SET incarnation_id = 'legacy-' || lower(hex(randomblob(16))) "
            'WHERE incarnation_id IS NULL',
          );
        }
      }
      if (from < 19) {
        final profileColumns = {
          for (final row in await customSelect(
            'PRAGMA table_info(broker_profile_rows)',
          ).get())
            row.read<String>('name'),
        };
        if (profileColumns.containsAll({'id', 'base_uri', 'incarnation_id'})) {
          final attentionEventColumns = {
            for (final row in await customSelect(
              'PRAGMA table_info(attention_event_rows)',
            ).get())
              row.read<String>('name'),
          };
          final attentionCursorColumns = {
            for (final row in await customSelect(
              'PRAGMA table_info(attention_cursor_rows)',
            ).get())
              row.read<String>('name'),
          };
          final settingColumns = {
            for (final row in await customSelect(
              'PRAGMA table_info(app_setting_rows)',
            ).get())
              row.read<String>('name'),
          };
          final profiles = await customSelect(
            'SELECT id, base_uri, incarnation_id '
            'FROM broker_profile_rows WHERE incarnation_id IS NOT NULL',
          ).get();
          for (final profile in profiles) {
            final id = profile.read<String>('id');
            final scopeKey = _attentionScopeKeyForMigration(
              profileId: id,
              baseUri: profile.read<String>('base_uri'),
              incarnationId: profile.read<String>('incarnation_id'),
            );
            if (attentionEventColumns.contains('broker_profile_id')) {
              await customStatement(
                'UPDATE attention_event_rows SET broker_profile_id = ? '
                'WHERE broker_profile_id = ?',
                [scopeKey, id],
              );
            }
            if (attentionCursorColumns.contains('broker_profile_id')) {
              await customStatement(
                'UPDATE attention_cursor_rows SET broker_profile_id = ? '
                'WHERE broker_profile_id = ?',
                [scopeKey, id],
              );
            }
            if (settingColumns.containsAll({'key', 'value', 'updated_at'})) {
              final legacyBadgeKey =
                  'attention_badge_seen_cursor:${Uri.encodeComponent(id)}';
              final scopedBadgeKey =
                  'attention_badge_seen_cursor:'
                  '${Uri.encodeComponent(scopeKey)}';
              await customStatement(
                'UPDATE OR REPLACE app_setting_rows SET key = ? '
                'WHERE key = ?',
                [scopedBadgeKey, legacyBadgeKey],
              );
            }
          }
        }
      }
    },
  );
}

String _attentionScopeKeyForMigration({
  required String profileId,
  required String baseUri,
  required String incarnationId,
}) {
  final endpoint = _normalizedBrokerEndpointForMigration(baseUri);
  return '${Uri.encodeComponent(profileId)}@'
      '${Uri.encodeComponent(endpoint)}#'
      '${Uri.encodeComponent(incarnationId)}';
}

String _normalizedBrokerEndpointForMigration(String raw) {
  try {
    final uri = Uri.parse(raw.trim());
    if ((uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty) {
      return Uri(
        scheme: uri.scheme,
        host: uri.host,
        port: uri.hasPort ? uri.port : 7734,
      ).toString();
    }
  } on Object {
    // Preserve the same stable fallback used by source identity.
  }
  return raw;
}

/// Artifact transfer records persisted by the session transfer repository.
class ArtifactTransferRows extends Table {
  /// Stable transfer id.
  TextColumn get id => text()();

  /// Owning broker profile. Null is reserved for pre-v12 legacy rows.
  TextColumn get brokerProfileId => text().nullable()();

  /// Owning broker tool key.
  TextColumn get tool => text()();

  /// Owning broker session id.
  TextColumn get sessionId => text()();

  /// Artifact action key from the transcript descriptor.
  TextColumn get actionKey => text()();

  /// Display filename.
  TextColumn get fileName => text()();

  /// Transfer direction enum name.
  TextColumn get direction => text()();

  /// Transfer status enum name.
  TextColumn get status => text()();

  /// Number of user-triggered retry attempts.
  IntColumn get attemptCount => integer().withDefault(const Constant(0))();

  /// Broker artifact key, when available.
  TextColumn get artifactKey => text().nullable()();

  /// Source URL, or `data:` marker for inline data URLs.
  TextColumn get sourceUrl => text().nullable()();

  /// App cache path once bytes are cached.
  TextColumn get cachedFilePath => text().nullable()();

  /// User-selected export path once saved.
  TextColumn get exportedPath => text().nullable()();

  /// MIME type, when known.
  TextColumn get contentType => text().nullable()();

  /// Broker/content hash, when known.
  TextColumn get contentHash => text().nullable()();

  /// Broker resumable upload id, when initialized.
  TextColumn get uploadId => text().nullable()();

  /// Durable `.part` path for a resumable workspace download.
  TextColumn get partialFilePath => text().nullable()();

  /// Strong ETag bound to [partialFilePath].
  TextColumn get downloadEtag => text().nullable()();

  /// HTTP-date validator bound to [partialFilePath].
  TextColumn get downloadLastModified => text().nullable()();

  /// Cached byte length, when known.
  IntColumn get byteLength => integer().nullable()();

  /// Bytes transferred so far, when known.
  IntColumn get bytesTransferred => integer().nullable()();

  /// Total expected bytes, when known.
  IntColumn get totalBytes => integer().nullable()();

  /// Error message for failed transfers.
  TextColumn get error => text().nullable()();

  /// User-facing status detail.
  TextColumn get message => text().withDefault(const Constant(''))();

  /// Transfer creation timestamp.
  DateTimeColumn get createdAt => dateTime()();

  /// Last mutation timestamp.
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

/// Saved broker endpoint profiles.
class BrokerProfileRows extends Table {
  /// Stable profile id.
  TextColumn get id => text()();

  /// User-facing display name.
  TextColumn get displayName => text()();

  /// Normalized broker base URI string.
  TextColumn get baseUri => text()();

  /// Creation timestamp.
  DateTimeColumn get createdAt => dateTime()();

  /// Opaque saved-row generation, replaced after delete and re-add.
  TextColumn get incarnationId => text().nullable()();

  /// Last update timestamp.
  DateTimeColumn get updatedAt => dateTime().nullable()();

  /// Last successful connection timestamp.
  DateTimeColumn get lastUsedAt => dateTime().nullable()();

  /// Secure/runtime credential slot key.
  TextColumn get credentialKey => text().nullable()();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

/// Durable attention events for one exact broker source incarnation.
class AttentionEventRows extends Table {
  /// Exact encoded broker source key (historical column name).
  TextColumn get brokerProfileId => text()();

  /// Stable event id from the broker.
  TextColumn get eventId => text()();

  /// Broker paging cursor.
  IntColumn get cursor => integer()();

  /// Event revision.
  IntColumn get revision => integer()();

  /// Broker rendering revision.
  IntColumn get presentationRevision => integer()();

  /// Action-trigger stage for reminder/retry pipelines.
  TextColumn get presentationStage => text().nullable()();

  /// Event kind (non-exhaustive, forward-compatible).
  TextColumn get kind => text()();

  /// Event lifecycle state.
  TextColumn get state => text()();

  /// Event severity.
  TextColumn get severity => text()();

  /// Stable dedupe key.
  TextColumn get dedupeKey => text()();

  /// Event headline.
  TextColumn get title => text()();

  /// Optional event details.
  TextColumn get summary => text().nullable()();

  /// Optional broker event scopes.
  TextColumn get sessionId => text().nullable()();

  /// Display-only session name captured with the broker event.
  TextColumn get sessionTitle => text().nullable()();

  /// Optional broker request identity.
  TextColumn get requestId => text().nullable()();

  /// Optional broker turn identity.
  TextColumn get turnId => text().nullable()();

  /// Optional broker goal identity.
  TextColumn get goalKey => text().nullable()();

  /// Optional broker agent/tool identity.
  TextColumn get agent => text().nullable()();

  /// Attention action kind.
  TextColumn get actionKind => text().nullable()();

  /// Optional action tool.
  TextColumn get actionTool => text().nullable()();

  /// Optional action session identity.
  TextColumn get actionSessionId => text().nullable()();

  /// Optional action agent identity.
  TextColumn get actionAgent => text().nullable()();

  /// Broker-side read/dismiss times.
  IntColumn get brokerReadAt => integer().nullable()();

  /// Marks whether this event belongs to the first synced historical catch-up
  /// floor.
  BoolColumn get historicalBaseline =>
      boolean().withDefault(const Constant(false))();

  /// Broker-side dismiss time.
  IntColumn get brokerDismissedAt => integer().nullable()();

  /// Broker event timestamps.
  IntColumn get createdAt => integer()();

  /// Broker event update timestamp.
  IntColumn get updatedAt => integer()();

  /// Broker event resolution timestamp.
  IntColumn get resolvedAt => integer().nullable()();

  /// Local read/dismiss/presentation state.
  IntColumn get localReadAt => integer().nullable()();

  /// Local event dismissal timestamp.
  IntColumn get localDismissedAt => integer().nullable()();

  /// Exact event revision targeted by a bulk local dismissal.
  IntColumn get localDismissedRevision => integer().nullable()();

  /// Greatest event presentation revision shown by this client.
  IntColumn get localPresentedRevision =>
      integer().withDefault(const Constant(0))();

  /// Raw event payload for unknown future fields.
  TextColumn get rawEventJson => text()();

  /// Last local persistence mutation.
  DateTimeColumn get persistedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {brokerProfileId, eventId};
}

/// Cursor anchor for the broker feed per profile.
class AttentionCursorRows extends Table {
  /// Exact encoded broker source key (historical column name).
  TextColumn get brokerProfileId => text()();

  /// Last durable cursor returned by the broker.
  IntColumn get cursor => integer()();

  /// First non-null durable history floor retained for deterministic baseline.
  IntColumn get baselineThroughCursor => integer().nullable()();

  /// Whether every page from the installation's initial catch-up is durable.
  BoolColumn get initialSyncComplete =>
      boolean().withDefault(const Constant(false))();

  /// Local storage mutation time.
  DateTimeColumn get persistedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {brokerProfileId};
}

/// Durable app settings for lightweight non-sensitive configuration.
class AppSettingRows extends Table {
  /// Unique setting key.
  TextColumn get key => text()();

  /// Setting value.
  TextColumn get value => text()();

  /// Timestamp when the setting was last updated.
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {key};
}

/// Durable outbox rows for mutating session messages.
@TableIndex(
  name: 'idx_session_outbox_status_updated',
  columns: {#status, #updatedAt},
)
class SessionOutboxRows extends Table {
  /// Stable broker client message id.
  TextColumn get clientMessageId => text()();

  /// Owning broker profile. Null is reserved for pre-v12 legacy rows.
  TextColumn get brokerProfileId => text().nullable()();

  /// Owning broker tool key.
  TextColumn get tool => text()();

  /// Owning broker session id.
  TextColumn get sessionId => text()();

  /// Outbound message kind enum name.
  TextColumn get kind => text()();

  /// JSON payload needed to replay the message.
  TextColumn get payloadJson => text()();

  /// Outbox status enum name.
  TextColumn get status => text()();

  /// Number of transport send attempts.
  IntColumn get attemptCount => integer().withDefault(const Constant(0))();

  /// Last transport or broker error, when any.
  TextColumn get lastError => text().nullable()();

  /// Creation timestamp.
  DateTimeColumn get createdAt => dateTime()();

  /// Last mutation timestamp.
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {clientMessageId};
}

/// Transactional durable transcript/checkpoint snapshot per broker session.
@TableIndex(
  name: 'idx_session_transcript_profile_updated',
  columns: {#brokerProfileId, #updatedAt},
)
class SessionTranscriptRows extends Table {
  /// Owning broker profile, preventing cross-profile transcript leakage.
  TextColumn get brokerProfileId => text()();

  /// Broker tool key.
  TextColumn get tool => text()();

  /// Broker session id.
  TextColumn get sessionId => text()();

  /// Canonical reduced messages as JSON.
  TextColumn get messagesJson => text()();

  /// Latest reconnect cursor committed with [messagesJson].
  TextColumn get cursor => text().nullable()();

  /// Cursor for the next older page.
  TextColumn get olderCursor => text().nullable()();

  /// Whether another retained older page exists.
  BoolColumn get hasEarlier => boolean().withDefault(const Constant(false))();

  /// Latest honest gap metadata as JSON.
  TextColumn get gapJson => text().nullable()();

  /// Latest tail-window metadata as JSON.
  TextColumn get truncationJson => text().nullable()();

  /// Last successful local transcript transaction.
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {brokerProfileId, tool, sessionId};
}

/// Durable device-local composer draft (DR1), one row per profile/tool/session.
///
/// Stores at most ONE current local draft revision per session plus the
/// minimum conflict state needed to avoid data loss when the local edit and
/// the shared broker draft changed independently:
///
/// - [draftText] / [localRevision] / [dirty]: the device's current draft value.
/// - [baseBrokerRevision]: the broker draft revision the local value is based
///   on (0 before any versioned publish is acknowledged).
/// - [submittedClientMessageId]: set while the exact text is durably handed
///   off to the session outbox; the row is kept until broker delivery.
/// - [pendingClearRevision]: the shared revision an unfinished post-send clear
///   targets, so the retry stays conditional on that exact record instead of
///   becoming an unconditional empty overwrite.
/// - [conflictText] / [conflictBrokerRevision]: the preserved shared version
///   while a conflict awaits an explicit user resolution. Never deduplicated
///   by text heuristics — both versions survive until the user chooses.
@TableIndex(
  name: 'idx_session_draft_profile_updated',
  columns: {#brokerProfileId, #updatedAt},
)
class SessionDraftRows extends Table {
  /// Owning broker profile, preventing cross-profile draft leakage.
  TextColumn get brokerProfileId => text()();

  /// Broker tool key.
  TextColumn get tool => text()();

  /// Broker session id.
  TextColumn get sessionId => text()();

  /// Current local draft text ('' rows represent a pending clear).
  TextColumn get draftText => text()();

  /// Local monotone revision, incremented per coalesced local edit flush.
  IntColumn get localRevision => integer().withDefault(const Constant(0))();

  /// Last broker draft revision the local value is based on / was
  /// acknowledged at. Ordering across clients uses broker revisions only,
  /// never client wall clocks.
  IntColumn get baseBrokerRevision =>
      integer().withDefault(const Constant(0))();

  /// Whether the local value has edits the broker has not acknowledged.
  BoolColumn get dirty => boolean().withDefault(const Constant(false))();

  /// Outbox handoff association while a send awaits broker delivery.
  TextColumn get submittedClientMessageId => text().nullable()();

  /// Monotone version of this row, bumped on EVERY accepted write.
  ///
  /// A conditional update on this value is what makes concurrent writers safe:
  /// the in-process mutation chain covers one controller and a transaction
  /// covers one connection, but a second browser tab is neither. `localRevision`
  /// cannot serve — it tracks coalesced user edits, so state-only writes
  /// (binding a send, adopting a revision, clearing a conflict) leave it
  /// unchanged and would look like no mutation at all.
  IntColumn get mutationVersion => integer().withDefault(const Constant(0))();

  /// Shared revision an unfinished post-send clear targets, when the broker
  /// accepted the prompt but could not durably clear the draft it contained.
  ///
  /// The retry is conditional on this exact revision. Once the shared record
  /// moves past it, the text this device sent is no longer the shared draft
  /// and the clear retires instead of overwriting whatever replaced it.
  IntColumn get pendingClearRevision => integer().nullable()();

  /// Preserved shared-draft text for an unresolved conflict.
  TextColumn get conflictText => text().nullable()();

  /// Broker revision of [conflictText].
  IntColumn get conflictBrokerRevision => integer().nullable()();

  /// Last mutation timestamp; drives TTL and LRU retention.
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {brokerProfileId, tool, sessionId};
}

/// Bounded last-known roster IDENTITY snapshot (N3), one row per broker profile.
///
/// Read once during the existing initial roster load so a cold start — a web
/// refresh in particular — renders the real navigation and roster shape instead
/// of an empty page, then replaced atomically by the authoritative response.
///
/// This table stores IDENTITY ONLY. It deliberately has no column for session
/// status, Drive/Observe ownership, Terminal Sync, permissions/questions,
/// control capabilities, telemetry, prompts, transcript content, drafts,
/// credentials or broker errors: cached activity must never be replayed as
/// current truth, and the cheapest way to guarantee that is to have nowhere to
/// put it. See `SessionRosterIdentity` in the client for the exact payload
/// shape and `rosterSnapshotPayloadVersion` for its compatibility gate.
class RosterSnapshotRows extends Table {
  /// Owning broker profile; the snapshot is scoped to this exact profile so a
  /// switch can never show another broker's rows.
  TextColumn get brokerProfileId => text()();

  /// Normalized broker endpoint these identities were captured from.
  ///
  /// A profile keeps its id when its URL is edited, so the id alone does not
  /// identify the roster source: pointing the same profile at a different
  /// broker would otherwise inherit the previous broker's session identities.
  /// The reader compares this against the profile's current endpoint and
  /// discards the row on any difference.
  TextColumn get endpoint => text()();

  /// Encoded identity payload version, so a future or corrupt shape can fail
  /// open to normal loading instead of being misread.
  IntColumn get payloadVersion => integer()();

  /// Bounded JSON array of identity rows.
  TextColumn get rowsJson => text()();

  /// Number of identity rows encoded in [rowsJson], for cheap bound checks.
  IntColumn get rowCount => integer().withDefault(const Constant(0))();

  /// Newest `updatedAt` the authoritative roster reported, in epoch ms.
  ///
  /// Display-only provenance for the "last seen" line; never a freshness claim
  /// about the session's current activity.
  IntColumn get newestSessionUpdatedAt => integer().nullable()();

  /// When this client last wrote the snapshot from an authoritative response.
  DateTimeColumn get capturedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {brokerProfileId};
}
