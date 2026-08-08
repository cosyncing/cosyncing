import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollCacheExtent;

void main() {
  runApp(const SelectionLabApp());
}

enum SelectionLabMode {
  current,
  focusFix,
  transcriptLevel,
  hardenedTranscript,
}

class SelectionLabApp extends StatelessWidget {
  const SelectionLabApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(),
      darkTheme: ThemeData.dark(useMaterial3: true),
      home: const SelectionLabPage(),
    );
  }
}

class SelectionLabPage extends StatefulWidget {
  const SelectionLabPage({super.key});

  @override
  State<SelectionLabPage> createState() => _SelectionLabPageState();
}

class _SelectionLabPageState extends State<SelectionLabPage> {
  SelectionLabMode _mode = SelectionLabMode.current;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Transcript selection trial')),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
              child: DropdownButtonFormField<SelectionLabMode>(
                initialValue: _mode,
                decoration: const InputDecoration(
                  labelText: 'Behavior',
                  border: OutlineInputBorder(),
                ),
                items: const [
                  DropdownMenuItem(
                    value: SelectionLabMode.current,
                    child: Text('A · Current app'),
                  ),
                  DropdownMenuItem(
                    value: SelectionLabMode.focusFix,
                    child: Text('B · Focus fix only'),
                  ),
                  DropdownMenuItem(
                    value: SelectionLabMode.transcriptLevel,
                    child: Text('C · Transcript-level selection'),
                  ),
                  DropdownMenuItem(
                    value: SelectionLabMode.hardenedTranscript,
                    child: Text('D · Cross-message + hardened scroll'),
                  ),
                ],
                onChanged: (value) {
                  if (value == null || value == _mode) return;
                  setState(() => _mode = value);
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Text(
                _instructionsFor(_mode),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: _SelectionSurface(
                key: ValueKey(_mode),
                mode: _mode,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _instructionsFor(SelectionLabMode mode) {
    return switch (mode) {
      SelectionLabMode.current =>
        'Long-press text, then start a one-finger scroll. The current '
            'pointer-down focus handoff may clear the selection immediately.',
      SelectionLabMode.focusFix =>
        'Long-press within one message and scroll. This isolates the smallest '
            'fix, but the range still cannot cross message boundaries.',
      SelectionLabMode.transcriptLevel =>
        'Long-press, scroll, then drag a handle toward the viewport edge and '
            'across messages. This exercises Flutter’s scroll-aware path.',
      SelectionLabMode.hardenedTranscript =>
        'This keeps cross-message selection, avoids shortcut autofocus, and '
            'retains two extra viewports of lazy rows while you scroll.',
    };
  }
}

class _SelectionSurface extends StatefulWidget {
  const _SelectionSurface({required this.mode, super.key});

  final SelectionLabMode mode;

  @override
  State<_SelectionSurface> createState() => _SelectionSurfaceState();
}

class _SelectionSurfaceState extends State<_SelectionSurface> {
  final FocusNode _shortcutFocus = FocusNode(
    debugLabel: 'selection-lab-history-shortcuts',
  );

  @override
  void dispose() {
    _shortcutFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final transcriptLevel =
        widget.mode == SelectionLabMode.transcriptLevel ||
        widget.mode == SelectionLabMode.hardenedTranscript;
    final scrollCacheExtent = widget.mode == SelectionLabMode.hardenedTranscript
        ? const ScrollCacheExtent.viewport(2)
        : null;
    Widget transcript = ListView.builder(
      key: const Key('selection-lab-list'),
      scrollCacheExtent: scrollCacheExtent,
      itemCount: 60,
      itemBuilder: (context, index) {
        final row = _MessageRow(index: index);
        if (transcriptLevel) return row;
        return SelectionArea(child: row);
      },
    );

    if (transcriptLevel) {
      transcript = SelectionArea(child: transcript);
    }

    transcript = Focus(
      focusNode: _shortcutFocus,
      autofocus: widget.mode != SelectionLabMode.hardenedTranscript,
      child: transcript,
    );

    if (widget.mode == SelectionLabMode.current) {
      transcript = Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _shortcutFocus.requestFocus(),
        child: transcript,
      );
    }

    return transcript;
  }
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({required this.index});

  final int index;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final speaker = index.isEven ? 'Agent' : 'You';
    final detail = switch (index % 4) {
      0 =>
        'The transcript is still loading structured output. Select a phrase '
            'near the end of this message, then extend the same range into '
            'the next message.',
      1 =>
        'This row is deliberately longer and wraps across several lines on a '
            'phone. A small scroll should move the selected text without '
            'discarding its native highlight or handles.',
      2 =>
        'Drag the lower selection handle toward the bottom edge. In the '
            'recommended mode, Flutter should scroll the list while the '
            'selection continues across message boundaries.',
      _ =>
        'Scroll far enough for the original row to leave the viewport, then '
            'return. This checks how the lazy list and the selection registrar '
            'cooperate when rows are temporarily unmounted.',
    };

    return ColoredBox(
      color: index.isEven ? colors.surface : colors.surfaceContainerLowest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$speaker · message ${index + 1}',
              style: Theme.of(context).textTheme.labelMedium,
            ),
            const SizedBox(height: 8),
            Text(
              detail,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }
}
