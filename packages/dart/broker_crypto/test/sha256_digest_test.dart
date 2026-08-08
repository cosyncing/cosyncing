import 'package:broker_crypto/broker_crypto.dart';
import 'package:test/test.dart';

void main() {
  test('sha256Digest emits canonical lowercase digest', () async {
    final hash = await sha256Digest([104, 101, 108, 108, 111]);

    expect(
      hash,
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  test(
    'sha256StreamDigest hashes chunks and reports their byte count',
    () async {
      final result = await sha256StreamDigest(
        Stream<List<int>>.fromIterable([
          [104, 101],
          [108],
          [108, 111],
        ]),
      );

      expect(result.byteLength, 5);
      expect(
        result.digest,
        'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e'
        '1b161e5c1fa7425e73043362938b9824',
      );
    },
  );
}
