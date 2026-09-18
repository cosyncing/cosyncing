import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/pairing/data/secure_storage_preflight.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('writes, verifies, and removes a temporary sentinel', () async {
    final backend = _MemoryBackend();

    await verifySecureStorage(backend: backend);

    expect(backend.values, isEmpty);
    expect(backend.writes, 1);
    expect(backend.reads, 1);
    expect(backend.deletes, 1);
  });

  test('removes the sentinel when its read fails', () async {
    final backend = _MemoryBackend(failRead: true);

    await expectLater(
      verifySecureStorage(backend: backend),
      throwsA(isA<StateError>()),
    );

    expect(backend.values, isEmpty);
    expect(backend.deletes, 1);
  });

  test('fails when secure storage returns a different value', () async {
    final backend = _MemoryBackend(readOverride: 'different');

    await expectLater(
      verifySecureStorage(backend: backend),
      throwsA(isA<SecureStoragePreflightException>()),
    );

    expect(backend.values, isEmpty);
  });
}

final class _MemoryBackend implements SecureBrokerCredentialBackend {
  _MemoryBackend({this.failRead = false, this.readOverride});

  final bool failRead;
  final String? readOverride;
  final Map<String, String> values = <String, String>{};
  int writes = 0;
  int reads = 0;
  int deletes = 0;

  @override
  Future<void> write(String key, String value) async {
    writes += 1;
    values[key] = value;
  }

  @override
  Future<String?> read(String key) async {
    reads += 1;
    if (failRead) throw StateError('read failed');
    return readOverride ?? values[key];
  }

  @override
  Future<void> delete(String key) async {
    deletes += 1;
    values.remove(key);
  }
}
