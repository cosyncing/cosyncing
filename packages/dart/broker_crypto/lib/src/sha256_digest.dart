import 'package:cryptography/cryptography.dart';

/// Computes a canonical SHA-256 digest for byte data.
Future<String> sha256Digest(List<int> bytes) async {
  final digest = await Sha256().hash(bytes);
  return _encodeDigest(digest.bytes);
}

/// Incrementally hashes [chunks] without retaining the complete payload.
///
/// The returned byte count lets callers prove a re-opened file still matches
/// the picker metadata before beginning a staged upload.
Future<({String digest, int byteLength})> sha256StreamDigest(
  Stream<List<int>> chunks,
) async {
  final sink = Sha256().toSync().newHashSink();
  var byteLength = 0;
  await for (final chunk in chunks) {
    byteLength += chunk.length;
    sink.add(chunk);
  }
  sink.close();
  final digest = await sink.hash();
  return (digest: _encodeDigest(digest.bytes), byteLength: byteLength);
}

String _encodeDigest(List<int> bytes) {
  final encoded = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0'));
  return 'sha256:${encoded.join()}';
}
