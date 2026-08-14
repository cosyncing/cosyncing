import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Thrown when an oversized-diff body can no longer be retrieved — the broker
/// evicted the content-addressed blob, or the signed URL expired/was rejected
/// (403/404/410). The UI shows an honest "no longer available" state (terminal,
/// no retry: a stale signed URL is fixed by a fresh history frame).
class DiffBodyUnavailableException implements Exception {
  /// Creates a [DiffBodyUnavailableException].
  const DiffBodyUnavailableException();
}

/// Thrown when fetched bytes do not hash to the advertised content hash — the
/// body is corrupt or the reference is stale. Surfaced as a transient error.
class DiffBodyIntegrityException implements Exception {
  /// Creates a [DiffBodyIntegrityException].
  const DiffBodyIntegrityException();
}

/// Thrown when a referenced body exceeds the client byte ceiling — either the
/// advertised size is over the limit (rejected before any fetch) or the stream
/// crossed it mid-flight (cancelled). Terminal: it will not shrink on retry.
class DiffBodyTooLargeException implements Exception {
  /// Creates a [DiffBodyTooLargeException].
  const DiffBodyTooLargeException();
}

/// Fetches oversized tool-result diff bodies the broker moved behind a signed,
/// content-hashed reference (mirrors the artifact fetch path). Bodies are
/// cached by content hash so re-expanding a row never refetches. The signed URL
/// is bearer material, so no broker auth header is attached.
// ignore: one_member_abstracts
abstract interface class DiffBodyLoader {
  /// Fetches the diff body at [url] (a signed broker URL), caching by
  /// [contentHash]. [expectedBytes] is the reference's advertised size, if any:
  /// a value over the client ceiling is rejected WITHOUT fetching. Throws
  /// [DiffBodyUnavailableException] (404/410/403), [DiffBodyTooLargeException]
  /// (over the ceiling), or [DiffBodyIntegrityException] (hash mismatch).
  Future<String> load({
    required String url,
    required String contentHash,
    int? expectedBytes,
  });
}

/// Production loader over `BrokerClient.fetchArtifactUrlBounded` with a
/// byte-budgeted, content-hash-keyed in-memory cache and in-flight de-dup.
class BrokerDiffBodyLoader implements DiffBodyLoader {
  /// Creates a loader bound to the provider [Ref] for broker access.
  BrokerDiffBodyLoader(this._ref);

  final Ref _ref;

  /// Hard ceiling on a single fetched body — matches the broker's
  /// `HARD_MAX_REFERENCED_DIFF_BYTES`, so a legitimately-clipped body always
  /// fits while a hostile/buggy oversize is rejected or cancelled mid-stream.
  static const int _maxBodyBytes = 4 * 1024 * 1024;

  /// Total cached body bytes kept resident. A phone must not accumulate many
  /// large diffs, so the cache is bounded by UTF-8 BYTES (not a count of
  /// entries): oversized diffs are text and cheap to refetch, so eviction is
  /// fine.
  static const int _maxCacheBytes = 512 * 1024;

  /// A single body larger than this is served but never cached — caching it
  /// would evict everything smaller and still miss next time. It still renders
  /// (the parser is bounded to 400 lines regardless of body size).
  static const int _maxCacheableBytes = 128 * 1024;

  /// Cached body + its UTF-8 byte size, LRU by insertion order.
  final Map<String, _CachedBody> _cache = <String, _CachedBody>{};
  int _cacheBytes = 0;

  /// Loads in flight, keyed by content hash: concurrent expansions of the same
  /// referenced diff share one download instead of each fetching the full body.
  final Map<String, Future<String>> _inFlight = <String, Future<String>>{};

  @override
  Future<String> load({
    required String url,
    required String contentHash,
    int? expectedBytes,
  }) {
    // Reject an advertised over-ceiling body before touching the network.
    if (expectedBytes != null && expectedBytes > _maxBodyBytes) {
      return Future<String>.error(const DiffBodyTooLargeException());
    }
    final cached = _cache[contentHash];
    if (cached != null) {
      // Refresh recency (LRU by insertion order).
      _cache
        ..remove(contentHash)
        ..[contentHash] = cached;
      return Future<String>.value(cached.body);
    }
    final pending = _inFlight[contentHash];
    if (pending != null) return pending;
    final future = _fetch(url, contentHash);
    _inFlight[contentHash] = future;
    return future;
  }

  Future<String> _fetch(String url, String contentHash) async {
    try {
      final client = await _ref.read(brokerClientProvider.future);
      if (client == null) throw const DiffBodyUnavailableException();
      // Streams and cancels once the ceiling is crossed, so an oversized body
      // is never fully buffered even if the advertised size lied.
      final download = await client.fetchArtifactUrlBounded(
        url,
        maxBytes: _maxBodyBytes,
      );
      // Verify integrity before caching or rendering: the content hash is not
      // just a cache key — a mismatch means a corrupt transfer or a stale
      // reference, so we refuse the body rather than show wrong content.
      final digest = await sha256Digest(download.bytes);
      if (digest != 'sha256:$contentHash') {
        throw const DiffBodyIntegrityException();
      }
      final body = utf8.decode(download.bytes, allowMalformed: true);
      _put(contentHash, body, download.bytes.length);
      return body;
    } on ArtifactTooLargeException {
      throw const DiffBodyTooLargeException();
    } on BrokerException catch (e) {
      // 403 = expired/invalid signed URL (broker returns 403, not 404, on
      // signature expiry) → terminal-unavailable, same as an evicted blob.
      if (e.statusCode == 403 || e.statusCode == 404 || e.statusCode == 410) {
        throw const DiffBodyUnavailableException();
      }
      rethrow;
    } finally {
      // Map value type is Future, so remove() returns one; we only drop the
      // entry (its future is already handled by the awaiting caller).
      unawaited(_inFlight.remove(contentHash));
    }
  }

  void _put(String hash, String body, int byteSize) {
    if (byteSize > _maxCacheableBytes) return;
    _cache[hash] = _CachedBody(body, byteSize);
    _cacheBytes += byteSize;
    while (_cacheBytes > _maxCacheBytes && _cache.isNotEmpty) {
      final oldest = _cache.keys.first;
      final removed = _cache.remove(oldest);
      if (removed != null) _cacheBytes -= removed.byteSize;
    }
  }
}

/// A cached diff body paired with its UTF-8 byte size (the cache-budget unit).
class _CachedBody {
  const _CachedBody(this.body, this.byteSize);

  final String body;
  final int byteSize;
}

/// Loader for oversized tool-result diff bodies; overridden in tests.
final diffBodyLoaderProvider = Provider<DiffBodyLoader>(
  BrokerDiffBodyLoader.new,
);
