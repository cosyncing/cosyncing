import 'package:cosyncing_client/src/features/voice/model/speech_text_compiler.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const compiler = SpeechTextCompiler();

  List<String> texts(String source) =>
      compiler.compile(source).map((u) => u.text).toList();

  group('decoration stripping', () {
    test('strips bold, italic, and heading markers', () {
      expect(texts('# Title'), ['Title']);
      expect(texts('This is **bold**, *italic*, and _also italic_.'), [
        'This is bold, italic, and also italic.',
      ]);
      expect(texts('~~struck~~ end.'), ['struck end.']);
    });

    test('keeps underscores that are part of identifiers', () {
      expect(texts('Use snake_case and _emphasis_.'), [
        'Use snake_case and emphasis.',
      ]);
    });

    test('strips list markers and preserves order', () {
      expect(texts('- First\n- Second\n- Third'), [
        'First',
        'Second',
        'Third',
      ]);
      expect(texts('1. One\n2. Two'), ['One', 'Two']);
    });

    test('strips blockquote markers', () {
      expect(texts('> quoted text'), ['quoted text']);
    });

    test('strips inline code backticks but keeps content', () {
      final out = texts('Run `npm install` now.');
      expect(out, ['Run npm install now.']);
      expect(out.first.contains('`'), isFalse);
    });
  });

  group('code and table omission', () {
    test('omits fenced code and emits a marker', () {
      final out = compiler.compile(
        "Here is code:\n```python\nprint('hi')\n```\nDone.",
      );

      expect(out, hasLength(3));
      expect(out[0].text, 'Here is code:');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[1].kind, SpeechUtteranceKind.omissionMarker);
      expect(out[2].text, 'Done.');
      final flat = out.map((u) => u.text).join(' ');
      expect(flat, isNot(contains("print('hi')")));
    });

    test('omits a fenced json block', () {
      final out = compiler.compile('```json\n{"a": 1}\n```');
      expect(out, hasLength(1));
      expect(out[0].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[0].kind, SpeechUtteranceKind.omissionMarker);
      expect(out.first.text, isNot(contains('"a"')));
    });

    test('omits an unclosed fence for the rest of the document', () {
      final out = compiler.compile('intro\n```\nsecret code\nstill code');
      expect(out, hasLength(2));
      expect(out[0].text, 'intro');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out.map((u) => u.text).join(' '), isNot(contains('secret')));
    });

    test('omits a gfm table', () {
      final out = compiler.compile('| A | B |\n|---|---|\n| 1 | 2 |');
      expect(out, hasLength(1));
      expect(out[0].text, SpeechTextCompiler.tableOmitted);
      expect(out[0].kind, SpeechUtteranceKind.omissionMarker);
      expect(out.first.text, isNot(contains('| 1 |')));
    });

    test('omits an indented code block after a blank line', () {
      final out = compiler.compile(
        'intro\n\n    code line\n    more\n\nafter',
      );
      expect(out.map((u) => u.text).toList(), [
        'intro',
        SpeechTextCompiler.codeBlockOmitted,
        'after',
      ]);
    });

    test('does not omit indented list continuation (conservative)', () {
      final out = compiler.compile('- item\n    continuation here');
      expect(out, hasLength(1));
      expect(out[0].text, 'item continuation here');
      expect(out[0].kind, SpeechUtteranceKind.prose);
    });
  });

  group('raw json omission', () {
    test('omits a one-line json object and never speaks its values', () {
      final out = compiler.compile(
        'Here is data:\n'
        '{"api_key":"sk-secret-123","user":"admin"}\n'
        'Done.',
      );
      expect(out, hasLength(3));
      expect(out[0].text, 'Here is data:');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[1].kind, SpeechUtteranceKind.omissionMarker);
      expect(out[2].text, 'Done.');
      final flat = out.map((u) => u.text).join(' ');
      expect(flat, isNot(contains('sk-secret-123')));
      expect(flat, isNot(contains('admin')));
      expect(flat, isNot(contains('api_key')));
    });

    test('omits a multiline json object', () {
      final out = compiler.compile(
        'Config:\n{\n  "token": "abc",\n  "n": 1\n}\nEnd.',
      );
      expect(out, hasLength(3));
      expect(out[0].text, 'Config:');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[2].text, 'End.');
      expect(
        out.map((u) => u.text).join(' '),
        isNot(contains('abc')),
      );
    });

    test('omits a json array', () {
      final out = compiler.compile('["a","b","c"]');
      expect(out, hasLength(1));
      expect(out[0].text, SpeechTextCompiler.codeBlockOmitted);
    });

    test('omits nested json with braces inside strings', () {
      final out = compiler.compile('{"a":"}b{","c":[1,2]}');
      expect(out, hasLength(1));
      expect(out[0].text, SpeechTextCompiler.codeBlockOmitted);
      expect(
        out.first.text,
        isNot(contains('}b{')),
      );
    });

    test('empty json object and array are omitted', () {
      expect(
        compiler.compile('{}').map((u) => u.text).toList(),
        [SpeechTextCompiler.codeBlockOmitted],
      );
      expect(
        compiler.compile('[]').map((u) => u.text).toList(),
        [SpeechTextCompiler.codeBlockOmitted],
      );
    });

    test('json block breaks a preceding prose paragraph', () {
      final out = compiler.compile(
        'Some prose here\n{"secret":"value"}\nMore prose.',
      );
      expect(out, hasLength(3));
      expect(out[0].text, 'Some prose here');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[2].text, 'More prose.');
      expect(
        out.map((u) => u.text).join(' '),
        isNot(contains('value')),
      );
    });

    test('malformed json block starting a line stays prose', () {
      final out = compiler.compile('Before.\n{"a":}\nAfter.');
      expect(out, hasLength(3));
      expect(out[0].text, 'Before.');
      expect(out[1].kind, SpeechUtteranceKind.prose);
      expect(out[2].text, 'After.');
    });

    test('inline json mid-sentence is not detected (conservative)', () {
      // The line does not start with { so it stays prose; only line-led
      // json blocks are omitted.
      final out = texts('Result: {"a": 1} is fine.');
      expect(out, hasLength(1));
      expect(out.first, contains('Result'));
    });

    test('json with trailing content stays prose (conservative)', () {
      final out = compiler.compile('{"a": 1} trailing');
      expect(out, hasLength(1));
      expect(out[0].kind, SpeechUtteranceKind.prose);
    });

    test('mixed prose and json preserves order', () {
      final out = compiler.compile(
        'First.\n{"x":1}\nSecond.\n[1,2]\nThird.',
      );
      expect(out.map((u) => u.text).toList(), [
        'First.',
        SpeechTextCompiler.codeBlockOmitted,
        'Second.',
        SpeechTextCompiler.codeBlockOmitted,
        'Third.',
      ]);
    });

    test('omits valid json with internal blank lines (no leak)', () {
      final out = compiler.compile(
        'Here is config:\n'
        '{\n'
        '  "api_key": "sk-secret-456",\n'
        '\n'
        '  "role": "admin"\n'
        '}\n'
        'Done.',
      );
      expect(out, hasLength(3));
      expect(out[0].text, 'Here is config:');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[1].kind, SpeechUtteranceKind.omissionMarker);
      expect(out[2].text, 'Done.');
      final flat = out.map((u) => u.text).join(' ');
      expect(flat, isNot(contains('sk-secret-456')));
      expect(flat, isNot(contains('admin')));
      expect(flat, isNot(contains('api_key')));
    });

    test('omits valid json array with internal blank lines', () {
      final out = compiler.compile(
        'Data:\n'
        '[\n'
        '  "first",\n'
        '\n'
        '  "second"\n'
        ']\n'
        'End.',
      );
      expect(out, hasLength(3));
      expect(out[0].text, 'Data:');
      expect(out[1].text, SpeechTextCompiler.codeBlockOmitted);
      expect(out[2].text, 'End.');
      expect(
        out.map((u) => u.text).join(' '),
        isNot(contains('first')),
      );
    });

    test('does not swallow prose after a json block with blank lines', () {
      final out = compiler.compile(
        '{\n  "a": 1\n\n}\n\nFollowing prose.',
      );
      expect(out.map((u) => u.text).toList(), [
        SpeechTextCompiler.codeBlockOmitted,
        'Following prose.',
      ]);
    });
  });

  group('links and urls', () {
    test('shortens a labeled link to its label', () {
      final out = texts('See [OpenAI](https://openai.com/foo) for info.');
      expect(out, ['See OpenAI for info.']);
      expect(out.first, isNot(contains('https://')));
    });

    test('shortens a bare url to its host', () {
      final out = texts('Visit https://openai.com/foo/bar now.');
      expect(out, ['Visit openai.com now.']);
      expect(out.first, isNot(contains('https://')));
      expect(out.first, isNot(contains('/foo')));
    });

    test('keeps a reference link label', () {
      expect(texts('See [the docs][ref] now.'), ['See the docs now.']);
    });

    test('keeps image alt text and drops the url', () {
      final out = texts('![a diagram](chart.png)');
      expect(out, ['a diagram']);
      expect(out.first, isNot(contains('chart.png')));
    });

    test('drops an image with no alt text', () {
      expect(texts('before ![](x.png) after'), ['before after']);
    });
  });

  group('html and entities', () {
    test('strips html tags but keeps inner text', () {
      final out = texts('Use <b>bold</b> text.');
      expect(out, ['Use bold text.']);
      expect(out.first, isNot(contains('<')));
    });

    test('decodes common html entities', () {
      expect(texts('A &amp; B &lt;c&gt;'), ['A & B <c>']);
    });
  });

  group('order and boundaries', () {
    test('preserves prose, code, and list order', () {
      const src =
          'First sentence.\n```\ncode\n```\n- item one\n'
          '- item two\nSecond sentence.';
      expect(texts(src), [
        'First sentence.',
        SpeechTextCompiler.codeBlockOmitted,
        'item one',
        'item two',
        'Second sentence.',
      ]);
    });

    test('every chunk is non-empty and within the bound', () {
      final words = List<String>.generate(60, (i) => 'word$i');
      final out = compiler.compile('${words.join(' ')}.');
      expect(out, isNotEmpty);
      for (final u in out) {
        expect(u.text, isNotEmpty);
        expect(
          u.text.length,
          lessThanOrEqualTo(SpeechTextCompiler.maxChunkLength),
        );
      }
    });

    test('splits a long single sentence across clause boundaries', () {
      final clauses = List<String>.generate(40, (i) => 'clause$i');
      final out = compiler.compile('${clauses.join(', ')}.');
      expect(out.length, greaterThan(1));
      for (final u in out) {
        expect(u.text.length, lessThanOrEqualTo(200));
      }
    });

    test('hard-splits a long unbreakable token', () {
      final token = 'a' * 500;
      final out = compiler.compile('$token.');
      expect(out.length, greaterThan(1));
      for (final u in out) {
        expect(u.text.length, lessThanOrEqualTo(200));
      }
    });

    test('each utterance is a distinct cancellation boundary', () {
      final out = compiler.compile('One. Two. Three.');
      expect(out.map((u) => u.text).toList(), ['One.', 'Two.', 'Three.']);
      for (final u in out) {
        expect(u.kind, SpeechUtteranceKind.prose);
      }
    });
  });

  group('determinism and no-fabrication', () {
    test('is deterministic', () {
      const src = '# H\n\ntext **b**\n```\nx\n```\n- a\n- b';
      expect(texts(src), texts(src));
    });

    test('never adds content except documented markers', () {
      final out = compiler.compile('Hello world.');
      expect(out, hasLength(1));
      expect(out[0].text, 'Hello world.');
    });

    test('empty input yields no utterances', () {
      expect(compiler.compile(''), isEmpty);
      expect(compiler.compile('   \n\t '), isEmpty);
    });

    test('only-code input yields a single omission marker', () {
      final out = compiler.compile('```\ncode\n```');
      expect(out.map((u) => u.text).toList(), [
        SpeechTextCompiler.codeBlockOmitted,
      ]);
    });
  });

  group('tolerance for malformed input', () {
    test('a heading marker with no text is treated as prose', () {
      expect(compiler.compile('###'), isNotEmpty);
    });

    test('unclosed emphasis markers are left intact (conservative)', () {
      expect(texts('**unclosed bold'), ['**unclosed bold']);
    });

    test('a lone asterisk is not mistaken for emphasis', () {
      expect(texts('5 * 3 = 15'), ['5 * 3 = 15']);
    });

    test('mixed malformed markdown does not throw', () {
      expect(
        () => compiler.compile('##\n```\n[link](\n|notatable'),
        returnsNormally,
      );
      expect(() => compiler.compile('> > > ### ***'), returnsNormally);
    });
  });

  test('default utterance kind is prose', () {
    expect(const SpeechUtterance('hi').kind, SpeechUtteranceKind.prose);
  });
}
