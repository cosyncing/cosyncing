// Session wire scripting for F05 feature tests: control blocks and a broker
// that arbitrates who owns one session.
//
// The app's real `SessionConnection` talks to `FakeBrokerSocket`; this file
// only decides which frames the broker answers an attach (or a frame the app
// sent) with. The broker's rules mirror the real one: Observe by default, a
// `resume`/`live` attach with a drive reason is a request for Drive, an
// attach conflict leaves the socket Observing, and a handoff hands the
// session back to the terminal.
import 'fake_broker.dart';

/// A `control` block: [drive] and [terminalSync] as the broker publishes them.
Map<String, Object?> controlBlock({
  Map<String, Object?>? drive,
  Map<String, Object?>? terminalSync,
}) => {
  'drive': drive ?? {'state': 'driving', 'supported': true},
  'terminalSync':
      terminalSync ??
      {'supported': false, 'syncAvailable': false, 'active': false},
};

/// A drive block.
Map<String, Object?> driveBlock(
  String state, {
  bool supported = true,
  String? reason,
  bool? takeoverAvailable,
  String? takeoverMode,
  bool? handoffAvailable,
}) => {
  'state': state,
  'supported': supported,
  'reason': ?reason,
  'takeoverAvailable': ?takeoverAvailable,
  'takeoverMode': ?takeoverMode,
  'handoffAvailable': ?handoffAvailable,
};

/// A terminal-sync block.
Map<String, Object?> syncBlock({
  bool supported = true,
  bool syncAvailable = false,
  bool active = false,
  String? presence,
  String? action,
  String? command,
  String? input,
  bool? behind,
  String? reason,
}) => {
  'supported': supported,
  'syncAvailable': syncAvailable,
  'active': active,
  'presence': ?presence,
  'action': ?action,
  'command': ?command,
  'input': ?input,
  'behind': ?behind,
  'reason': ?reason,
};

/// A `hello` frame, the way [broker] opens a stream, with a chosen version
/// and compatibility decision.
Map<String, Object?> helloWith(
  FakeBroker broker, {
  String version = '0.7.0',
  String status = 'compatible',
  bool readOnly = false,
  String reason = 'compatible',
}) {
  final hello = broker.helloFrame();
  final contract = (hello['broker']! as Map)['contract'];
  return {
    'kind': 'hello',
    'broker': {'version': version, 'contract': contract},
    'compatibility': {
      'status': status,
      'readOnly': readOnly,
      'reason': reason,
      'broker': contract,
    },
  };
}

/// One session whose ownership the broker arbitrates between a terminal and
/// the app.
///
/// Installs itself as the broker's attach policy and frame handler. Every
/// attach the app opens is recorded in [attaches] (its bound parameters).
class OwnedSession {
  /// Arbitrates session [id] of [broker].
  ///
  /// [terminalOwns] starts the session in the terminal's hands (the app
  /// Observes and may take over); false starts it with the app Driving.
  OwnedSession(
    this.broker,
    this.id, {
    this.terminalOwns = true,
    this.takeoverMode,
    this.terminalSync,
    this.handoffAvailable,
    this.alsoIds = const [],
    this.drivingTerminalSync,
    this.observingDrive,
  }) {
    for (final each in [id, ...alsoIds]) {
      _drives[each] = !terminalOwns;
    }
    broker
      ..attachFrames = _frames
      ..onFrame = _onFrame;
  }

  /// The broker.
  final FakeBroker broker;

  /// The session id.
  final String id;

  /// Whether the terminal owns input when the app has not taken over.
  final bool terminalOwns;

  /// The mode a takeover must attach with (`live`/`resume`), when declared.
  final String? takeoverMode;

  /// The terminal-sync block published while the app is not driving.
  final Map<String, Object?>? terminalSync;

  /// The terminal-sync block published while the app is driving (a handoff
  /// command, say).
  final Map<String, Object?>? drivingTerminalSync;

  /// `handoffAvailable` published while the app is driving.
  final bool? handoffAvailable;

  /// The drive block published while the app is not driving, when it is not
  /// the ordinary takeable Observe (a session whose agent is not installed
  /// offers no Take over, say).
  final Map<String, Object?>? observingDrive;

  /// More sessions of the broker arbitrated the same way.
  final List<String> alsoIds;

  final Map<String, bool> _drives = {};

  /// Whether the app currently holds Drive on the primary session.
  bool get appDrives => _drives[id]!;
  set appDrives(bool value) => _drives[id] = value;

  /// Whether the app currently holds Drive on [sessionId].
  bool drives(String sessionId) => _drives[sessionId] ?? false;

  /// Refuse a Drive request with this attach-conflict code (null grants it).
  String? refuseWith;

  /// Message the refusal carries.
  String refusalMessage = 'The terminal still holds this session.';

  /// When true a Drive request is neither granted nor refused: the broker
  /// keeps the socket open and answers nothing (a slow adapter).
  bool stall = false;

  /// Answer a handoff with a `nack` instead of handing the session back.
  bool refuseHandoff = false;

  /// Extra fields merged into every session frame (`sessionOwner`, …).
  Map<String, Object?> sessionExtras = const {};

  /// Parameters of every attach, oldest first.
  final List<Map<String, String>> attaches = [];

  Map<String, Object?> _control(String sessionId) => drives(sessionId)
      ? controlBlock(
          drive: driveBlock('driving', handoffAvailable: handoffAvailable),
          terminalSync: drivingTerminalSync ?? syncBlock(supported: false),
        )
      : controlBlock(
          drive:
              observingDrive ??
              driveBlock('observing', takeoverMode: takeoverMode),
          terminalSync: terminalSync ?? syncBlock(supported: false),
        );

  Map<String, Object?> sessionFrame(Map<String, Object?> session) => {
    'kind': 'session',
    'info': {
      ...session,
      'control': _control(session['id']! as String),
      ...sessionExtras,
    },
  };

  List<Map<String, Object?>> _frames(
    FakeBrokerSocket socket,
    Map<String, Object?> session,
  ) {
    final sid = session['id']! as String;
    if (!_drives.containsKey(sid)) {
      return [
        broker.helloFrame(),
        sessionFrame(session),
        {
          'kind': 'history',
          'messages': const <Object?>[],
          'cursor': 'cursor-1',
        },
      ];
    }
    final params = socket.attachParams;
    attaches.add(params);
    final mode = params['mode'];
    final reason = params['reason'];
    final asksDrive = (mode == 'resume' || mode == 'live') && reason != null;
    final conflict = <Map<String, Object?>>[];
    if (asksDrive) {
      if (stall) {
        // The socket opens and says nothing about ownership.
        return [broker.helloFrame()];
      }
      if (refuseWith != null) {
        _drives[sid] = false;
        conflict.add({
          'kind': 'attach-conflict',
          'requestedMode': mode,
          'reason': reason,
          'code': refuseWith,
          'message': refusalMessage,
        });
      } else {
        _drives[sid] = true;
      }
    } else if (mode == null || mode == 'observe') {
      // A bare attach is an Observe attach: the app does not hold Drive.
      _drives[sid] = false;
    } else if (mode == 'resume') {
      _drives[sid] = refuseWith == null;
    }
    return [
      broker.helloFrame(),
      ...conflict,
      sessionFrame(session),
      {
        'kind': 'history',
        'messages': broker.transcripts[sid] ?? const <Object?>[],
        'cursor': 'cursor-${attaches.length}',
      },
    ];
  }

  void _onFrame(FakeBrokerSocket socket, Map<String, dynamic> frame) {
    if (frame['kind'] != 'handoff') return;
    final clientMessageId = frame['clientMessageId'];
    if (refuseHandoff) {
      socket.emit({
        'kind': 'nack',
        'clientMessageId': clientMessageId,
        'code': 'HANDOFF_REFUSED',
        'message': 'Another client still drives this session.',
      });
      return;
    }
    final row = socket.session;
    if (row == null) return;
    _drives[row['id']! as String] = false;
    socket.emit(
      sessionFrame(row)
        ..['info'] = {
          ...(sessionFrame(row)['info']! as Map<String, Object?>),
          'sessionOwner': {
            'revision': {'epoch': 'e1', 'seq': attaches.length + 1},
            'state': 'none',
          },
        },
    );
  }

  /// The broker side changes ownership under an attached app (the terminal
  /// writes, so the app is demoted): every open socket is told.
  void terminalTakesOver() {
    _drives[id] = false;
    for (final socket in broker.socketsFor(id)) {
      if (!socket.isConnected) continue;
      final row = socket.session;
      if (row != null) socket.emit(sessionFrame(row));
    }
  }

  /// Parameters of the newest attach.
  Map<String, String> get lastAttach => attaches.last;
}

/// A model-output transcript row, as history replays it.
Map<String, Object?> modelOutput(String text, {String? id}) => {
  'type': 'model-output',
  'text': text,
  'id': ?id,
};
