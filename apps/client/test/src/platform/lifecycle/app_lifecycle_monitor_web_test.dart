@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/lifecycle/app_lifecycle_monitor_web.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web/web.dart' as web;

@JS('Object.defineProperty')
external void _defineProperty(JSObject target, String name, JSObject spec);

@JS('Reflect.deleteProperty')
external bool _deleteProperty(JSObject target, String name);

/// The document's visibility and focus, faked on the real document.
var _hidden = false;
var _focused = true;

void _fakeDocument() {
  _defineProperty(
    web.document,
    'visibilityState',
    JSObject()
      ..['configurable'] = true.toJS
      ..['get'] = (() => (_hidden ? 'hidden' : 'visible').toJS).toJS,
  );
  _defineProperty(
    web.document,
    'hasFocus',
    JSObject()
      ..['configurable'] = true.toJS
      ..['value'] = (() => _focused.toJS).toJS,
  );
}

void _restoreDocument() {
  _deleteProperty(web.document, 'visibilityState');
  _deleteProperty(web.document, 'hasFocus');
}

Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  setUp(() {
    _hidden = false;
    _focused = true;
    _fakeDocument();
  });

  tearDown(_restoreDocument);

  test('a tab restored in the background starts hidden', () async {
    _hidden = true;
    _focused = false;
    final monitor = WebAppLifecycleMonitor();
    addTearDown(monitor.dispose);
    final changes = <BrokerAppLifecycleState>[];
    monitor.stateChanges.listen(changes.add);

    expect(monitor.currentState, BrokerAppLifecycleState.hidden);

    // Shown and focused. Flutter's engine reports nothing here, because it
    // started this tab as resumed.
    _hidden = false;
    _focused = true;
    web.document.dispatchEvent(web.Event('visibilitychange'));
    await _settle();

    expect(monitor.currentState, BrokerAppLifecycleState.resumed);
    expect(changes, [BrokerAppLifecycleState.resumed]);
  });

  test('a visible tab without focus starts inactive', () {
    _focused = false;
    final monitor = WebAppLifecycleMonitor();
    addTearDown(monitor.dispose);

    expect(monitor.currentState, BrokerAppLifecycleState.inactive);
  });

  test('blur and focus move between inactive and resumed', () async {
    final monitor = WebAppLifecycleMonitor();
    addTearDown(monitor.dispose);
    final changes = <BrokerAppLifecycleState>[];
    monitor.stateChanges.listen(changes.add);

    _focused = false;
    web.window.dispatchEvent(web.Event('blur'));
    await _settle();
    _focused = true;
    web.window.dispatchEvent(web.Event('focus'));
    await _settle();
    _hidden = true;
    web.document.dispatchEvent(web.Event('visibilitychange'));
    await _settle();

    expect(changes, [
      BrokerAppLifecycleState.inactive,
      BrokerAppLifecycleState.resumed,
      BrokerAppLifecycleState.hidden,
    ]);
  });

  test('leaving the browser from a child frame is noticed', () async {
    final monitor = WebAppLifecycleMonitor(
      childFramePollInterval: const Duration(milliseconds: 20),
    );
    addTearDown(monitor.dispose);

    // Focus moves into an artifact frame: the window blurs, the document
    // keeps focus, and the user is still in the app.
    web.window.dispatchEvent(web.Event('blur'));
    await _settle();
    expect(monitor.currentState, BrokerAppLifecycleState.resumed);

    // The user switches to another application. This page gets no event.
    _focused = false;
    await Future<void>.delayed(const Duration(milliseconds: 80));

    expect(monitor.currentState, BrokerAppLifecycleState.inactive);
  });

  test('dispose stops observing', () async {
    final monitor = WebAppLifecycleMonitor()..dispose();

    _focused = false;
    web.window.dispatchEvent(web.Event('blur'));
    await _settle();

    expect(monitor.currentState, BrokerAppLifecycleState.resumed);
  });
}
