/// Synchronous key/value backing for composer keepalive records (DR1b).
///
/// Synchronous is the whole point. The durable Drift row is written from an
/// asynchronous debounce, and a document that is being destroyed is not
/// guaranteed to run another microtask, let alone a database round trip. A
/// backing store whose write returns only after the value is submitted to
/// storage that outlives the document is what makes an edit unlosable.
abstract interface class SessionDraftKeepaliveStore {
  /// Every entry currently held, including foreign keys this store shares
  /// with other users of the same backing (the caller filters by prefix).
  ///
  /// Enumerating and decoding a whole backing is a startup cost, never a
  /// per-keystroke one — see [read].
  Map<String, String> readAll();

  /// One entry, or null. Kept separate from [readAll] because the write path
  /// runs on every keystroke and must not enumerate anything.
  String? read(String key);

  /// Writes one entry, throwing when the backing refused it (quota).
  void write(String key, String value);

  /// Removes one entry; a missing key is not an error.
  void remove(String key);
}

/// Process-local backing.
///
/// The default off the web — native platforms destroy no documents, so their
/// durability boundary is the ordinary lifecycle flush — and what focused
/// tests use to observe the record protocol without a browser.
final class MemorySessionDraftKeepaliveStore
    implements SessionDraftKeepaliveStore {
  /// Creates a store, optionally pre-seeded with entries a previous document
  /// would have left behind, and optionally bounded to [capacityChars] so a
  /// test can reproduce a refused write.
  MemorySessionDraftKeepaliveStore({
    Map<String, String>? seed,
    this.capacityChars,
  }) : _entries = {...?seed};

  final Map<String, String> _entries;

  /// Total stored characters this store accepts, or null for unbounded.
  int? capacityChars;

  /// Writes refused so far, for assertions about the refusal path.
  int refusedWrites = 0;

  @override
  Map<String, String> readAll() => Map<String, String>.from(_entries);

  @override
  String? read(String key) => _entries[key];

  @override
  void write(String key, String value) {
    final budget = capacityChars;
    if (budget != null) {
      var used = value.length + key.length;
      for (final entry in _entries.entries) {
        if (entry.key == key) continue;
        used += entry.key.length + entry.value.length;
      }
      if (used > budget) {
        refusedWrites++;
        throw StateError('keepalive store is full');
      }
    }
    _entries[key] = value;
  }

  @override
  void remove(String key) => _entries.remove(key);
}
