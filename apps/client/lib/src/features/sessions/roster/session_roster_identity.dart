import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// Encoded shape version of a stored roster snapshot (N3).
///
/// A row written by a NEWER build carries a higher version than this client
/// understands. Reading it as if it were the current shape is how a cache
/// starts inventing fields, so a mismatch fails open to normal loading and the
/// row is deleted rather than guessed at.
///
/// Version 2 added [SessionRosterIdentity.createdAt], the anchor the
/// authoritative roster orders its working band by. A version-1 row has no
/// anchor at all, so it is dropped rather than rendered in an order this build
/// no longer produces.
const int rosterSnapshotPayloadVersion = 2;

/// Maximum broker profiles that may retain a roster snapshot.
///
/// The device already retains per-profile attention, draft and transcript
/// state; the snapshot is by far the smallest of those, and startup only ever
/// reads the ONE active profile. Eight covers a laptop, a couple of phones and
/// a few tailnet machines with room to spare, and every profile beyond it is
/// evicted least-recently-captured first.
const int maxRetainedRosterSnapshotProfiles = 8;

/// Maximum identity rows retained in one profile's snapshot.
///
/// The authoritative roster on a busy broker runs to ~1.5k sessions (the
/// broker's own `?window=` filter exists because of it), and the cache is a
/// startup hint, not a mirror. 300 is comfortably more than any first screen
/// can show while staying an order of magnitude below the real roster, and it
/// sits between the transcript cache's 100 retained sessions per profile and
/// its 500 retained messages — the same order of magnitude as the limits DR1
/// already justified for durable per-profile state.
const int maxRosterSnapshotRows = 300;

/// Maximum encoded bytes for one profile's snapshot.
///
/// 300 identity rows encode to roughly 90 KB in the worst case seen (long cwd
/// paths and titles). 256 KiB leaves headroom for unusually long project paths
/// without ever approaching the 4 MiB the transcript cache allows a single
/// session, which is the right ratio for a pure identity list.
const int maxRosterSnapshotBytes = 256 * 1024;

/// Maximum encoded bytes retained across every profile's snapshot.
///
/// A hard aggregate ceiling: [maxRetainedRosterSnapshotProfiles] x
/// [maxRosterSnapshotBytes] is 2 MiB, so this is the same bound stated as one
/// number and enforced independently in case either factor is retuned. It is
/// 1/32 of the transcript cache's 64 MiB per-profile budget.
const int maxRetainedRosterSnapshotBytesTotal = 2 * 1024 * 1024;

/// Maximum age a snapshot may reach before it is treated as unusable.
///
/// Past a fortnight the identity list is more likely to mislead (renamed
/// projects, deleted sessions) than to help, and the row is deleted on read.
/// This matches the order of DR1's local draft retention rather than the
/// transcript cache, because identity, unlike a transcript, has no user content
/// worth preserving.
const Duration maxRosterSnapshotAge = Duration(days: 14);

/// Rows one opportunistic cleanup pass may delete.
///
/// Mirrors `SessionLocalMaintenance.cleanupBatchLimit`: cleanup is triggered by
/// real work (a snapshot write), never a timer, and must do bounded work
/// regardless of table size.
const int rosterSnapshotCleanupBatchLimit = 100;

/// One cached roster row: IDENTITY ONLY.
///
/// Deliberately not a [SessionInfo]. Reconstructing one would require inventing
/// a [SessionStatus], an [AttachMode] and a control block, and a fabricated
/// `SessionStatus.idle` is exactly the lie this lane exists to prevent — it
/// would let the authoritative row renderer present a stale row as a live,
/// idle, drivable session. A separate type makes the cached/authoritative
/// boundary a compile-time fact rather than a convention.
///
/// Every field here is stable identity or display naming:
///
/// * [machine], [tool], [sessionId] — routing identity;
/// * [nativeId], [parentThreadId], [origin] — R1c lineage identity;
/// * [title] — session title;
/// * [cwd], [projectName] — project/cwd display identity;
/// * [modelLabel], [modelId] — model label/identity;
/// * [updatedAt] — last authoritative update time;
/// * [createdAt] — when the session was created.
///
/// [createdAt] is identity, not activity: it is fixed when the session is
/// created and never moves again, which is exactly why the authoritative
/// roster orders its working band by it. Carrying it costs nothing and lets
/// the cached pane rank a row that has never been updated.
///
/// Status, ownership, Terminal Sync, permissions, control capabilities,
/// telemetry, prompts and transcript content are absent by construction.
@immutable
final class SessionRosterIdentity {
  /// Creates one cached identity row.
  const SessionRosterIdentity({
    required this.tool,
    required this.sessionId,
    required this.title,
    this.machine,
    this.nativeId,
    this.parentThreadId,
    this.origin,
    this.cwd,
    this.projectName,
    this.modelLabel,
    this.modelId,
    this.updatedAt,
    this.createdAt,
  });

  /// Projects the identity fields of an authoritative roster row.
  factory SessionRosterIdentity.fromSession(SessionInfo session) {
    return SessionRosterIdentity(
      tool: session.tool,
      sessionId: session.id,
      title: session.title,
      machine: session.machine,
      nativeId: session.nativeId,
      parentThreadId: session.parentThreadId,
      origin: session.origin,
      cwd: session.cwd,
      projectName: session.projectName,
      modelLabel: session.currentModel?.label ?? session.model,
      modelId: session.currentModel?.modelID,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    );
  }

  /// Rebuilds one row from its stored JSON object.
  ///
  /// Throws [FormatException] for any shape it cannot read, so a corrupt
  /// payload fails the whole decode and the caller falls open to normal
  /// loading instead of rendering half a roster.
  factory SessionRosterIdentity.fromJson(Map<String, Object?> json) {
    final tool = json['tool'];
    final sessionId = json['id'];
    if (tool is! String || tool.isEmpty || sessionId is! String) {
      throw const FormatException('Cached roster row needs a tool and an id.');
    }
    return SessionRosterIdentity(
      tool: tool,
      sessionId: sessionId,
      title: _optionalString(json['title']) ?? '',
      machine: _optionalString(json['machine']),
      nativeId: _optionalString(json['nativeId']),
      parentThreadId: _optionalString(json['parentThreadId']),
      origin: _originFromName(_optionalString(json['origin'])),
      cwd: _optionalString(json['cwd']),
      projectName: _optionalString(json['projectName']),
      modelLabel: _optionalString(json['modelLabel']),
      modelId: _optionalString(json['modelId']),
      updatedAt: _optionalInt(json['updatedAt']),
      createdAt: _optionalInt(json['createdAt']),
    );
  }

  /// Backend id (`codex`, `opencode`, `claude`, `pi`).
  final String tool;

  /// Stable session id within [tool].
  final String sessionId;

  /// Session title as last seen.
  final String title;

  /// Broker-reported machine, when the roster carried one.
  final String? machine;

  /// Tool-native thread id used to resolve child linkage (R1c).
  final String? nativeId;

  /// Native parent thread id for a child row (R1c).
  final String? parentThreadId;

  /// How the session came to exist, for the same origin filtering the
  /// authoritative roster applies.
  final SessionOrigin? origin;

  /// Working directory as last seen.
  final String? cwd;

  /// Broker/project alias for [cwd].
  final String? projectName;

  /// Human-readable model label.
  final String? modelLabel;

  /// Technical model id, shown only in a tooltip.
  final String? modelId;

  /// Last authoritative update time, epoch milliseconds.
  final int? updatedAt;

  /// Session creation time, epoch milliseconds.
  ///
  /// Absent for any adapter that does not report one (dsh today).
  final int? createdAt;

  /// Recency this row is ranked by, falling back to creation.
  ///
  /// A session created but never updated has no `updatedAt`, and ranking it at
  /// zero buried the newest row in the roster at the bottom of the cached pane.
  int? get recencyAnchor => updatedAt ?? createdAt;

  /// Stable routing key, matching `sessionRosterKey` for the same session.
  String get rosterKey => '$tool/$sessionId';

  /// Cross-machine identity, matching `sessionCompositeRosterKey`.
  String get compositeKey => '${machine ?? ''}/$tool/$sessionId';

  /// Encodes this row, omitting absent fields so the payload stays small.
  Map<String, Object?> toJson() => <String, Object?>{
    'tool': tool,
    'id': sessionId,
    if (title.isNotEmpty) 'title': title,
    if (machine != null) 'machine': machine,
    if (nativeId != null) 'nativeId': nativeId,
    if (parentThreadId != null) 'parentThreadId': parentThreadId,
    if (origin != null) 'origin': origin!.name,
    if (cwd != null) 'cwd': cwd,
    if (projectName != null) 'projectName': projectName,
    if (modelLabel != null) 'modelLabel': modelLabel,
    if (modelId != null) 'modelId': modelId,
    if (updatedAt != null) 'updatedAt': updatedAt,
    if (createdAt != null) 'createdAt': createdAt,
  };
}

/// One profile's cached roster identity list plus its provenance.
@immutable
final class SessionRosterSnapshot {
  /// Creates a snapshot.
  const SessionRosterSnapshot({
    required this.brokerProfileId,
    required this.rows,
    required this.capturedAt,
    required this.omittedRowCount,
    this.newestSessionUpdatedAt,
  });

  /// Owning broker profile.
  final String brokerProfileId;

  /// Retained identity rows, newest-activity first.
  final List<SessionRosterIdentity> rows;

  /// When this client last captured the snapshot from an authoritative roster.
  final DateTime capturedAt;

  /// Authoritative rows the bounds dropped.
  ///
  /// Surfaced so the pane can say the list is partial instead of implying the
  /// broker only had this many sessions.
  final int omittedRowCount;

  /// Newest session `updatedAt` in the captured roster, epoch milliseconds.
  final int? newestSessionUpdatedAt;

  /// Whether the bounds dropped any authoritative row.
  bool get isPartial => omittedRowCount > 0;
}

/// Result of applying every published bound to a candidate row list.
@immutable
final class BoundedRosterSnapshotPayload {
  /// Creates a bounded payload.
  const BoundedRosterSnapshotPayload({
    required this.rows,
    required this.rowsJson,
    required this.omittedRowCount,
    required this.newestSessionUpdatedAt,
  });

  /// Rows that survived every bound.
  final List<SessionRosterIdentity> rows;

  /// Encoded JSON array of [rows].
  final String rowsJson;

  /// Candidate rows dropped by the row-count or byte bound.
  final int omittedRowCount;

  /// Newest `updatedAt` across the CANDIDATE rows, not just the retained ones.
  final int? newestSessionUpdatedAt;
}

/// Applies the row-count and byte bounds to [sessions], newest activity first.
///
/// Retention rules, in order:
///
/// 1. Rows are ranked newest-activity first — `updatedAt`, or `createdAt` for a
///    session that has never been updated — so the identities most likely to
///    matter on the next start survive.
/// 2. A resolved parent is pulled in with its child whenever the child is
///    retained, so R1c adjacency still holds in the cached projection. The
///    parent is not counted twice and cannot push the list past the bounds.
/// 3. The row cap is applied, then the byte budget, dropping from the oldest
///    retained end. [BoundedRosterSnapshotPayload.omittedRowCount] reports what
///    went, so the pane can be honest about being partial.
///
/// Bounds are enforced HERE, on the write path, not only during cleanup: a
/// single oversized write would otherwise sit in the database until the next
/// maintenance trigger, and there is no timer that guarantees one.
BoundedRosterSnapshotPayload boundRosterSnapshotPayload(
  List<SessionInfo> sessions,
) {
  final identities = <String, SessionRosterIdentity>{};
  final order = <String>[];
  int? newest;
  for (final session in sessions) {
    final identity = SessionRosterIdentity.fromSession(session);
    if (!identities.containsKey(identity.compositeKey)) {
      order.add(identity.compositeKey);
    }
    identities[identity.compositeKey] = identity;
    final updatedAt = session.updatedAt;
    if (updatedAt != null && (newest == null || updatedAt > newest)) {
      newest = updatedAt;
    }
  }

  // Parent lookup by the same (machine, tool, nativeId) identity R1c uses, so
  // a retained child can keep its parent and stay adjacent to it.
  final keyByNativeIdentity = <String, String>{};
  for (final key in order) {
    final identity = identities[key]!;
    final nativeId = identity.nativeId;
    if (nativeId == null || nativeId.isEmpty) continue;
    keyByNativeIdentity['${identity.machine ?? ''}/${identity.tool}/$nativeId'] =
        key;
  }

  final ranked = [...order]
    ..sort((a, b) => compareRosterIdentities(identities[a]!, identities[b]!));

  final retainedKeys = <String>{};
  final retained = <SessionRosterIdentity>[];
  void take(String key) {
    if (retainedKeys.contains(key)) return;
    final identity = identities[key];
    if (identity == null) return;
    retainedKeys.add(key);
    retained.add(identity);
  }

  for (final key in ranked) {
    if (retained.length >= maxRosterSnapshotRows) break;
    final identity = identities[key]!;
    final parentThreadId = identity.parentThreadId;
    final parentKey = parentThreadId == null || parentThreadId.isEmpty
        ? null
        : keyByNativeIdentity['${identity.machine ?? ''}/${identity.tool}/'
              '$parentThreadId'];
    // A child and its available parent are retained as a PAIR or not at all.
    //
    // The parent goes in first so a later truncation cannot drop it out from
    // under the child. When only one slot is left the child is skipped
    // entirely: keeping it alone would manufacture an orphan whose parent the
    // roster actually has, and the cached projection would then have to decide
    // how to display a child with nowhere to hang. Skipping falls through to
    // the next ranked key, so the last slot still goes to something useful —
    // typically a root, which needs no pair.
    if (parentKey != null &&
        parentKey != key &&
        !retainedKeys.contains(parentKey)) {
      if (retained.length + 2 > maxRosterSnapshotRows) continue;
      take(parentKey);
    }
    take(key);
  }

  // Byte budget: encode once, then drop from the least-recent end until the
  // serialized array fits. Encoding per row keeps this one pass.
  final encoded = retained
      .map((identity) => jsonEncode(identity.toJson()))
      .toList(growable: false);
  var bytes = 2; // '[' + ']'
  var kept = 0;
  for (var index = 0; index < encoded.length; index++) {
    final next =
        bytes + utf8.encode(encoded[index]).length + (kept == 0 ? 0 : 1);
    if (next > maxRosterSnapshotBytes) break;
    bytes = next;
    kept++;
  }

  final rows = retained.sublist(0, kept);
  final rowsJson = kept == 0 ? '[]' : '[${encoded.sublist(0, kept).join(',')}]';
  return BoundedRosterSnapshotPayload(
    rows: List<SessionRosterIdentity>.unmodifiable(rows),
    rowsJson: rowsJson,
    omittedRowCount: identities.length - rows.length,
    newestSessionUpdatedAt: newest,
  );
}

/// Orders cached identity rows newest-activity first, ties on identity.
///
/// The cache holds no status by construction, so it cannot reproduce the
/// authoritative roster's status bands and never will. What it can do is stop
/// inventing an order of its own: this is the same rule the authoritative
/// roster applies to its settled rows, so the cached pane and the live pane
/// that replaces it agree about every row that is not currently working.
///
/// Ties resolve on composite identity, matching the authoritative comparator,
/// so both the retained set and the displayed order are deterministic across
/// runs. An unstable set would make the bound tests flaky rather than
/// load-bearing.
int compareRosterIdentities(SessionRosterIdentity a, SessionRosterIdentity b) {
  final left = a.recencyAnchor;
  final right = b.recencyAnchor;
  // An unranked row sorts after every ranked one, never at epoch zero.
  if (left == null && right != null) return 1;
  if (right == null && left != null) return -1;
  final byRecency = left == null || right == null ? 0 : right.compareTo(left);
  return byRecency != 0 ? byRecency : a.compositeKey.compareTo(b.compositeKey);
}

/// Decodes a stored rows payload.
///
/// Throws [FormatException] on anything it cannot read exactly, including a row
/// count past [maxRosterSnapshotRows]: an over-cap payload means the row was
/// written by something that did not honour the bounds, and honouring it here
/// would make the cap advisory.
List<SessionRosterIdentity> decodeRosterSnapshotRows(String rowsJson) {
  final decoded = jsonDecode(rowsJson);
  if (decoded is! List<Object?>) {
    throw const FormatException('Cached roster rows must be a JSON list.');
  }
  if (decoded.length > maxRosterSnapshotRows) {
    throw const FormatException('Cached roster payload exceeds the row bound.');
  }
  final rows = <SessionRosterIdentity>[];
  for (final value in decoded) {
    if (value is! Map<Object?, Object?>) {
      throw const FormatException('Cached roster rows must be JSON objects.');
    }
    rows.add(
      SessionRosterIdentity.fromJson(Map<String, Object?>.from(value)),
    );
  }
  return List<SessionRosterIdentity>.unmodifiable(rows);
}

String? _optionalString(Object? value) {
  if (value == null) return null;
  if (value is! String) {
    throw const FormatException('Cached roster field must be a string.');
  }
  return value.isEmpty ? null : value;
}

int? _optionalInt(Object? value) {
  if (value == null) return null;
  if (value is! int) {
    throw const FormatException('Cached roster timestamp must be an integer.');
  }
  return value;
}

/// Maps a stored origin name, tolerating values a newer broker may introduce.
SessionOrigin? _originFromName(String? name) {
  if (name == null) return null;
  for (final origin in SessionOrigin.values) {
    if (origin.name == name) return origin;
  }
  return SessionOrigin.unknown;
}
