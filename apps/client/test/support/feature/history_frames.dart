// Scripted history for the recovery scenarios (F03b): what a broker sends on
// each attach of a session, and the frames it sends after.
//
// A scenario says, per attach, which history the socket opens with (a fresh
// reset, an incremental reconnect frame, a capped reset); the app's own
// reconnect, cache restore and resync paths do the rest.
import 'fake_broker.dart';

/// A `history` frame.
Map<String, Object?> historyFrame(
  List<Map<String, Object?>> messages, {
  bool reset = false,
  String? cursor,
  String? olderCursor,
  bool hasEarlier = false,
  String? endCursor,
  bool newerHistory = false,
  Map<String, Object?>? gap,
  Map<String, Object?>? truncated,
}) => {
  'kind': 'history',
  'messages': messages,
  if (reset) 'reset': true,
  'cursor': ?cursor,
  'olderCursor': ?olderCursor,
  if (hasEarlier) 'hasEarlier': true,
  'endCursor': ?endCursor,
  if (newerHistory) 'newerHistory': true,
  'gap': ?gap,
  'truncated': ?truncated,
};

/// A live `message` frame.
Map<String, Object?> messageFrame(Map<String, Object?> message, int seq) => {
  'kind': 'message',
  'seq': seq,
  'message': message,
};

/// The frames of one attach: given the socket, what follows the hello and the
/// session frame.
typedef AttachScript =
    List<Map<String, Object?>> Function(
      FakeBrokerSocket socket,
    );

/// Serves attach number N of session [id] from `attaches[N]` (the last one
/// serves every later attach).
void scriptAttaches(
  FakeBroker broker,
  String id,
  List<AttachScript> attaches,
) {
  final previous = broker.attachFrames;
  broker.attachFrames = (socket, session) {
    if (session['id'] != id) {
      return (previous ?? _unscripted(broker)).call(socket, session);
    }
    final number = broker.socketsFor(id).indexOf(socket);
    final script = attaches[number.clamp(0, attaches.length - 1)];
    return [
      broker.helloFrame(),
      {
        'kind': 'session',
        'info': {...session, 'control': FakeBroker.drivingControl},
      },
      ...script(socket),
    ];
  };
}

List<Map<String, Object?>> Function(
  FakeBrokerSocket socket,
  Map<String, Object?> session,
)
_unscripted(FakeBroker broker) =>
    (socket, session) => [
      broker.helloFrame(),
      {
        'kind': 'session',
        'info': {...session, 'control': FakeBroker.drivingControl},
      },
      {
        'kind': 'history',
        'messages': broker.transcripts[session['id']] ?? const <Object?>[],
        'cursor': 'cursor-1',
      },
    ];
