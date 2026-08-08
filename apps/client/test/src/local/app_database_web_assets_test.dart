import 'dart:io';

import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AppDatabase web runtime assets', () {
    test('uses committed Drift web asset names', () {
      expect(AppDatabase.defaultWebSqlite3WasmUri, Uri.parse('sqlite3.wasm'));
      expect(
        AppDatabase.defaultWebDriftWorkerUri,
        Uri.parse('drift_worker.js'),
      );
    });

    test('ships the web SQLite WASM module and Drift worker', () {
      final sqliteWasm = File('web/sqlite3.wasm');
      final driftWorker = File('web/drift_worker.js');
      final driftWorkerMap = File('web/drift_worker.js.map');
      final driftWorkerSource = File('web/drift_worker.dart');

      expect(sqliteWasm.existsSync(), isTrue);
      expect(sqliteWasm.lengthSync(), greaterThan(0));
      expect(driftWorker.existsSync(), isTrue);
      expect(driftWorker.lengthSync(), greaterThan(0));
      final workerJs = driftWorker.readAsStringSync();
      if (workerJs.contains('sourceMappingURL=drift_worker.js.map')) {
        expect(driftWorkerMap.existsSync(), isTrue);
        expect(driftWorkerMap.lengthSync(), greaterThan(0));
      }
      expect(driftWorkerSource.existsSync(), isTrue);
      expect(
        driftWorkerSource.readAsStringSync(),
        contains('WasmDatabase.workerMainForOpen'),
      );
    });
  });
}
