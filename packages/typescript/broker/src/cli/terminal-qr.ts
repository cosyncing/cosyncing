/**
 * Terminal QR rendering for `cosyncing pair`.
 *
 * A pairing QR is scanned by a phone camera pointed at a terminal window, so the only property that matters
 * is that a scanner locks onto it. Three things decide that, and the stock `qrcode` terminal renderer got
 * two of them wrong on a real Ubuntu desktop (physical audit, 2026-08): palette-indexed colours and a
 * one-module quiet zone.
 */
import QRCode from 'qrcode';
import { doctorColorEnabled } from '../installation/doctor.ts';

/**
 * Four light modules on every side. A scanner finds the symbol by its border against a light field; with
 * the one-module margin the previous renderer emitted, whatever the terminal drew next to the QR sat inside
 * the search area. This is also what the QR specification requires.
 */
const QUIET_ZONE_MODULES = 4;

/**
 * Error correction L (~7%). A code read straight off a screen suffers none of the print damage the higher
 * levels exist to survive, so the recovery budget buys nothing and costs symbol size: at production
 * pairing-payload length, M needs 77 modules (85 columns with the quiet zone) and L needs 65 (73 columns).
 * 73 fits an 80-column terminal. 85 wraps, and a wrapped QR is not a degraded QR, it is not a QR.
 */
const PAIRING_QR_ERROR_CORRECTION = 'L' as const;

/** What a terminal is assumed to be when it does not say — the POSIX default, and the narrowest in practice. */
export const DEFAULT_TERMINAL_COLUMNS = 80;

/**
 * 24-bit colour, not the legacy `30`/`47` pair the stock renderer used. Those index the terminal's THEME
 * palette, where "black" and "white" are routinely a dark grey and a beige — which is exactly why the
 * shipped QR read as low-contrast greyscale. These name the actual colours a scanner is looking for, so the
 * same output scans on a dark and a light terminal alike.
 */
const BLACK_FOREGROUND = '\u001b[38;2;0;0;0m';
const WHITE_FOREGROUND = '\u001b[38;2;255;255;255m';
const BLACK_BACKGROUND = '\u001b[48;2;0;0;0m';
const WHITE_BACKGROUND = '\u001b[48;2;255;255;255m';
const RESET = '\u001b[0m';

/** Same policy doctor's human renderer uses: a real TTY, NO_COLOR unset or empty, and TERM not `dumb`. */
export const terminalQrColorEnabled = doctorColorEnabled;

export interface TerminalQrOptions {
  /** Explicit black/white cells. Off renders block glyphs alone, for pipes, NO_COLOR, and dumb terminals. */
  color?: boolean;
}

/**
 * How many columns `renderTerminalQr` will occupy for `payload`, without rendering it.
 *
 * The symbol grows in steps with the payload, and the payload carries an operator-chosen MagicDNS URL, so
 * no fixed claim about the width survives contact with a long enough tailnet name. Callers ask first and
 * print something honest when the answer does not fit: a QR wider than the terminal wraps, and wrapped
 * output looks like a QR to a human and like nothing at all to a scanner.
 */
export function terminalQrWidth(payload: string): number {
  return QRCode.create(payload, { errorCorrectionLevel: PAIRING_QR_ERROR_CORRECTION }).modules.size
    + QUIET_ZONE_MODULES * 2;
}

/**
 * Render `payload` as a scannable QR.
 *
 * Terminal cells are about twice as tall as they are wide, so one cell per module produces modules stretched
 * 1:2 and scanners that hunt for a square grid struggle. Every line here carries TWO module rows in one cell
 * via `▀`, whose upper half takes the foreground colour and lower half the background — which restores
 * square modules and halves the height at the same time.
 */
export function renderTerminalQr(payload: string, options: TerminalQrOptions = {}): string {
  const symbol = QRCode.create(payload, { errorCorrectionLevel: PAIRING_QR_ERROR_CORRECTION });
  const size = symbol.modules.size;
  const data = symbol.modules.data;
  const span = size + QUIET_ZONE_MODULES * 2;
  const dark = (row: number, column: number): boolean => {
    const symbolRow = row - QUIET_ZONE_MODULES;
    const symbolColumn = column - QUIET_ZONE_MODULES;
    if (symbolRow < 0 || symbolColumn < 0 || symbolRow >= size || symbolColumn >= size) return false;
    return data[symbolRow * size + symbolColumn] === 1;
  };
  const color = options.color ?? false;
  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = '';
    let sgr = '';
    for (let column = 0; column < span; column++) {
      const upper = dark(row, column);
      // A QR side is always odd, so the last text line pairs a real module row with nothing. Padding it
      // light extends the quiet zone by a half cell instead of leaving a torn bottom edge.
      const lower = row + 1 < span ? dark(row + 1, column) : false;
      if (!color) {
        // Dark module = ink. Correct on a light background and when the output is redirected to a file,
        // which is what the no-colour path is for; the colour path is what covers dark terminals.
        line += upper ? (lower ? '█' : '▀') : (lower ? '▄' : ' ');
        continue;
      }
      const next = `${upper ? BLACK_FOREGROUND : WHITE_FOREGROUND}${lower ? BLACK_BACKGROUND : WHITE_BACKGROUND}`;
      if (next !== sgr) {
        line += next;
        sgr = next;
      }
      line += '▀';
    }
    // Reset per line so the quiet zone's white never bleeds into whatever the terminal prints after it.
    lines.push(color ? `${line}${RESET}` : line);
  }
  return `${lines.join('\n')}\n`;
}
