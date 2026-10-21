/// Versioned server storage measurements and finite cleanup operations.
library;

Map<String, dynamic> _object(Object? value) =>
    Map<String, dynamic>.from(value! as Map);
List<Map<String, dynamic>> _objects(Object? value) =>
    (value! as List<dynamic>).map(_object).toList();

class StorageCategoryMeasurement {
  StorageCategoryMeasurement.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String,
      bytes = json['bytes'] as int?,
      itemCount = json['itemCount'] as int,
      eligibleCount = json['eligibleCount'] as int,
      eligibleBytes = json['eligibleBytes'] as int?,
      quality = json['quality'] as String;
  final String id;
  final int? bytes;
  final int itemCount;
  final int eligibleCount;
  final int? eligibleBytes;
  final String quality;
}

class StorageInventory {
  StorageInventory.fromJson(Map<String, dynamic> json)
    : inventoryId = json['inventoryId'] as String,
      serverIdentity = json['serverIdentity'] as String,
      measuredAt = DateTime.fromMillisecondsSinceEpoch(
        json['measuredAt'] as int,
      ),
      status = json['status'] as String,
      categories = List.unmodifiable(
        _objects(json['categories']).map(StorageCategoryMeasurement.fromJson),
      ),
      actions = List<String>.unmodifiable(json['actions'] as List<dynamic>) {
    if (json['capability'] != 'storage-v1') {
      throw const FormatException('Unsupported storage capability');
    }
  }
  final String inventoryId;
  final String serverIdentity;
  final DateTime measuredAt;
  final String status;
  final List<StorageCategoryMeasurement> categories;
  final List<String> actions;
}

class StorageReviewItem {
  StorageReviewItem.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String,
      version = json['version'] as String,
      category = json['category'] as String,
      label = json['label'] as String,
      size = json['size'] as int?,
      createdAt = DateTime.fromMillisecondsSinceEpoch(json['createdAt'] as int),
      eligible = json['eligible'] as bool,
      reason = json['reason'] as String?,
      tool = json['tool'] as String?,
      sessionId = json['sessionId'] as String?;
  final String id;
  final String version;
  final String category;
  final String label;
  final int? size;
  final DateTime createdAt;
  final bool eligible;
  final String? reason;
  final String? tool;
  final String? sessionId;
}

class StorageReviewPage {
  StorageReviewPage.fromJson(Map<String, dynamic> json)
    : items = List.unmodifiable(
        _objects(json['items']).map(StorageReviewItem.fromJson),
      ),
      nextCursor = json['nextCursor'] as String?,
      eligibleCount = json['eligibleCount'] as int;
  final List<StorageReviewItem> items;
  final String? nextCursor;
  final int eligibleCount;
}

class StorageCleanupPlan {
  StorageCleanupPlan.fromJson(Map<String, dynamic> json)
    : planId = json['planId'] as String,
      inventoryId = json['inventoryId'] as String,
      expiresAt = DateTime.fromMillisecondsSinceEpoch(json['expiresAt'] as int),
      itemCount = json['itemCount'] as int,
      affectedSessions = json['affectedSessions'] as int,
      logicalBytes = json['logicalBytes'] as int?,
      reclaimableBytes = json['reclaimableBytes'] as int?,
      skippedCount = json['skippedCount'] as int;
  final String planId;
  final String inventoryId;
  final DateTime expiresAt;
  final int itemCount;
  final int affectedSessions;
  final int? logicalBytes;
  final int? reclaimableBytes;
  final int skippedCount;
}

class StorageCleanupJob {
  StorageCleanupJob.fromJson(Map<String, dynamic> json)
    : jobId = json['jobId'] as String,
      planId = json['planId'] as String,
      state = json['state'] as String,
      total = json['total'] as int,
      processed = json['processed'] as int,
      removed = json['removed'] as int,
      missing = json['missing'] as int,
      skipped = json['skipped'] as int,
      failed = json['failed'] as int,
      reclaimedBytes = json['reclaimedBytes'] as int?,
      retainedUntil = DateTime.fromMillisecondsSinceEpoch(
        json['retainedUntil'] as int,
      ),
      outcomes = List.unmodifiable(
        (json['outcomes'] as List<dynamic>? ?? []).map(
          (value) => Map<String, dynamic>.unmodifiable(_object(value)),
        ),
      );
  final String jobId;
  final String planId;
  final String state;
  final int total;
  final int processed;
  final int removed;
  final int missing;
  final int skipped;
  final int failed;
  final int? reclaimedBytes;
  final DateTime retainedUntil;
  final List<Map<String, dynamic>> outcomes;
  bool get finished => ['completed', 'partial', 'canceled'].contains(state);
}
