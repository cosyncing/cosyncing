// Glyph outline data is kept on one line per shape for review against the
// design source.
// ignore_for_file: lines_longer_than_80_chars
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// The workspace's line-icon family.
///
/// One consistent 24-unit grid, round caps and joins, and a single stroke
/// weight. Navigation, roster and tab chrome use these instead of Material's
/// filled glyphs so every icon on those surfaces reads as one set.
enum StrokeGlyph {
  /// Sidebar collapse/expand.
  panel,

  /// New session.
  compose,

  /// Search.
  search,

  /// Overview.
  overview,

  /// Notifications.
  bell,

  /// Project folder.
  folder,

  /// Disclosure chevron, pointing down (rotate for right).
  chevronDown,

  /// Server/machine.
  monitor,

  /// Settings.
  settings,

  /// Close.
  close,

  /// Close all tabs.
  closeAll,

  /// Add.
  plus,

  /// Filters.
  filter,

  /// Drawer menu.
  menu,

  /// Go to (row trailing arrow).
  arrowRight,
}

/// Paints a [StrokeGlyph] at [size] logical pixels.
///
/// The color defaults to the ambient [IconTheme] color, so it follows the
/// same foreground rules as an [Icon] inside buttons and list rows.
class StrokeIcon extends StatelessWidget {
  /// Creates a line icon.
  const StrokeIcon(
    this.glyph, {
    this.size = 18,
    this.color,
    this.quarterTurns = 0,
    this.semanticLabel,
    super.key,
  });

  /// Which glyph to draw.
  final StrokeGlyph glyph;

  /// Square edge length.
  final double size;

  /// Stroke color; the ambient icon color when null.
  final Color? color;

  /// Clockwise quarter turns, for chevrons.
  final int quarterTurns;

  /// Optional accessible name. Decorative when null.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final resolved =
        color ??
        IconTheme.of(context).color ??
        DefaultTextStyle.of(context).style.color ??
        const Color(0xFF000000);
    Widget icon = CustomPaint(
      size: Size.square(size),
      painter: _StrokeIconPainter(
        glyph,
        resolved,
        MediaQuery.maybeDevicePixelRatioOf(context) ?? 1,
      ),
    );
    if (quarterTurns != 0) {
      icon = RotatedBox(quarterTurns: quarterTurns, child: icon);
    }
    return Semantics(
      label: semanticLabel,
      excludeSemantics: true,
      child: icon,
    );
  }
}

/// Glyph outlines on a 24-unit grid. `R` is a rounded rect (x y w h radius),
/// `C` a circle (cx cy r); anything else is SVG path data.
const Map<StrokeGlyph, List<String>> _outlines = {
  StrokeGlyph.panel: ['R3 4 18 16 3', 'M9 4v16'],
  StrokeGlyph.compose: [
    'M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6M14 5l5 5M10 14l-1 4 4-1 9-9a2 2 0 0 0-5-5z',
  ],
  StrokeGlyph.search: ['C10.5 10.5 6.5', 'm16 16 5 5'],
  StrokeGlyph.overview: [
    'R3 3 7 7 1.5',
    'R14 3 7 7 1.5',
    'R3 14 7 7 1.5',
    'R14 14 7 7 1.5',
  ],
  StrokeGlyph.bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4'],
  StrokeGlyph.folder: [
    'M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 9h18',
  ],
  StrokeGlyph.chevronDown: ['m7 10 5 5 5-5'],
  StrokeGlyph.monitor: ['R3 3 18 13 2', 'M8 21h8m-4-5v5'],
  StrokeGlyph.settings: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    'm9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3z',
  ],
  StrokeGlyph.close: ['m6 6 12 12M6 18 18 6'],
  StrokeGlyph.closeAll: [
    'M8 3h11a2 2 0 0 1 2 2v11M16 8H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-9 4 6 5m0-5-6 5',
  ],
  StrokeGlyph.plus: ['M12 5v14M5 12h14'],
  StrokeGlyph.filter: ['M4 6h16M7 12h10M10 18h4'],
  StrokeGlyph.menu: ['M4 7h16M4 12h16M4 17h16'],
  StrokeGlyph.arrowRight: ['M5 12h14m-6-6 6 6-6 6'],
};

/// Parsed once per glyph; the outlines are constant.
final Map<StrokeGlyph, List<_Shape>> _shapes = {};

List<_Shape> _shapesFor(StrokeGlyph glyph) => _shapes.putIfAbsent(
  glyph,
  () => [for (final spec in _outlines[glyph]!) _Shape.parse(spec)],
);

class _Shape {
  const _Shape.path(Path this.path) : rrect = null, circle = null;
  const _Shape.rrect(RRect this.rrect) : path = null, circle = null;
  const _Shape.circle((Offset, double) this.circle) : path = null, rrect = null;

  factory _Shape.parse(String spec) {
    List<double> numbers() =>
        spec.substring(1).split(' ').map(double.parse).toList();
    switch (spec[0]) {
      case 'R':
        final v = numbers();
        return _Shape.rrect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(v[0], v[1], v[2], v[3]),
            Radius.circular(v[4]),
          ),
        );
      case 'C':
        final v = numbers();
        return _Shape.circle((Offset(v[0], v[1]), v[2]));
      default:
        return _Shape.path(parseStrokePath(spec));
    }
  }

  final Path? path;
  final RRect? rrect;
  final (Offset, double)? circle;

  void paint(Canvas canvas, Paint paint) {
    if (path case final path?) canvas.drawPath(path, paint);
    if (rrect case final rrect?) canvas.drawRRect(rrect, paint);
    if (circle case (final center, final radius)) {
      canvas.drawCircle(center, radius, paint);
    }
  }
}

void _paintOutlines(Canvas canvas, Size size, StrokeGlyph glyph, Color color) {
  canvas
    ..save()
    ..scale(size.width / 24, size.height / 24);
  final paint = Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1.65
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round
    ..color = color;
  for (final shape in _shapesFor(glyph)) {
    shape.paint(canvas, paint);
  }
  canvas.restore();
}

/// Whether icons draw from cached rasters instead of stroking every frame.
///
/// Flutter web has no raster cache: CanvasKit re-strokes every antialiased
/// path on every frame, and a sidebar full of these icons roughly tripled the
/// cost of handing each frame to the browser (about 40 ms instead of 14 ms per
/// frame in the web review's measurements). One image per glyph, color, size
/// and pixel ratio costs a single textured quad instead. Native renderers
/// cache static layers themselves, so they keep the vector outlines.
bool get _drawFromRasters => debugStrokeIconRasterOverride ?? kIsWeb;

/// Forces the raster (true) or vector (false) path; null follows the platform.
@visibleForTesting
bool? debugStrokeIconRasterOverride;

typedef _RasterKey = (StrokeGlyph, int, double, double);

/// Bounded by the glyphs, theme colors, sizes and pixel ratios actually on
/// screen; the cap only guards against an unbounded color animation.
final Map<_RasterKey, ui.Image> _rasters = {};
const int _maxRasters = 512;

/// How many icon rasters are cached.
@visibleForTesting
int get debugStrokeIconRasterCount => _rasters.length;

/// Forgets cached rasters; images still on screen stay alive until replaced.
@visibleForTesting
void debugClearStrokeIconRasters() => _rasters.clear();

ui.Image _rasterFor(
  StrokeGlyph glyph,
  Color color,
  Size size,
  double devicePixelRatio,
) {
  final key = (glyph, color.toARGB32(), size.width, devicePixelRatio);
  final cached = _rasters[key];
  if (cached != null) return cached;
  // Dropped, not disposed: a picture recorded this frame may still draw it.
  if (_rasters.length >= _maxRasters) _rasters.clear();
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder)..scale(devicePixelRatio);
  _paintOutlines(canvas, size, glyph, color);
  final picture = recorder.endRecording();
  final image = picture.toImageSync(
    math.max(1, (size.width * devicePixelRatio).ceil()),
    math.max(1, (size.height * devicePixelRatio).ceil()),
  );
  picture.dispose();
  return _rasters[key] = image;
}

class _StrokeIconPainter extends CustomPainter {
  const _StrokeIconPainter(this.glyph, this.color, this.devicePixelRatio);

  final StrokeGlyph glyph;
  final Color color;
  final double devicePixelRatio;

  @override
  void paint(Canvas canvas, Size size) {
    if (!_drawFromRasters) {
      _paintOutlines(canvas, size, glyph, color);
      return;
    }
    final image = _rasterFor(glyph, color, size, devicePixelRatio);
    final pixels = Size(image.width.toDouble(), image.height.toDouble());
    canvas.drawImageRect(
      image,
      Offset.zero & pixels,
      Offset.zero & (pixels / devicePixelRatio),
      Paint()..filterQuality = FilterQuality.low,
    );
  }

  @override
  bool shouldRepaint(_StrokeIconPainter oldDelegate) =>
      oldDelegate.glyph != glyph ||
      oldDelegate.color != color ||
      oldDelegate.devicePixelRatio != devicePixelRatio;
}

/// Parses the SVG path-data subset the glyph outlines use: move, line,
/// horizontal/vertical line, cubic, elliptical arc and close, absolute or
/// relative, including implicit repeats.
@visibleForTesting
Path parseStrokePath(String data) {
  final tokens = RegExp(
    r'[MmLlHhVvAaCcZz]|-?(?:\d+\.?\d*|\.\d+)',
  ).allMatches(data).map((match) => match.group(0)!).toList();
  final path = Path();
  var index = 0;
  var x = 0.0;
  var y = 0.0;
  var startX = 0.0;
  var startY = 0.0;
  String? command;
  bool isNumber(int at) =>
      at < tokens.length && !RegExp('[A-Za-z]').hasMatch(tokens[at]);
  double next() => double.parse(tokens[index++]);
  while (index < tokens.length) {
    if (!isNumber(index)) command = tokens[index++];
    final current = command;
    if (current == null) {
      throw FormatException('Path data must start with a command', data);
    }
    final relative = current == current.toLowerCase();
    switch (current.toUpperCase()) {
      case 'M':
        var nx = next();
        var ny = next();
        if (relative) {
          nx += x;
          ny += y;
        }
        path.moveTo(nx, ny);
        x = startX = nx;
        y = startY = ny;
        // Further coordinate pairs after a move are implicit lines.
        command = relative ? 'l' : 'L';
      case 'L':
        var nx = next();
        var ny = next();
        if (relative) {
          nx += x;
          ny += y;
        }
        path.lineTo(nx, ny);
        x = nx;
        y = ny;
      case 'H':
        var nx = next();
        if (relative) nx += x;
        path.lineTo(nx, y);
        x = nx;
      case 'V':
        var ny = next();
        if (relative) ny += y;
        path.lineTo(x, ny);
        y = ny;
      case 'C':
        final v = [for (var i = 0; i < 6; i++) next()];
        if (relative) {
          for (var i = 0; i < 6; i += 2) {
            v[i] += x;
            v[i + 1] += y;
          }
        }
        path.cubicTo(v[0], v[1], v[2], v[3], v[4], v[5]);
        x = v[4];
        y = v[5];
      case 'A':
        final rx = next();
        final ry = next();
        final rotation = next();
        final largeArc = next() != 0;
        final clockwise = next() != 0;
        var nx = next();
        var ny = next();
        if (relative) {
          nx += x;
          ny += y;
        }
        path.arcToPoint(
          Offset(nx, ny),
          radius: Radius.elliptical(rx, ry),
          rotation: rotation,
          largeArc: largeArc,
          clockwise: clockwise,
        );
        x = nx;
        y = ny;
      case 'Z':
        path.close();
        x = startX;
        y = startY;
        // Close takes no coordinates; a number after it is malformed data.
        command = null;
      default:
        throw FormatException('Unsupported path command $current', data);
    }
  }
  return path;
}
