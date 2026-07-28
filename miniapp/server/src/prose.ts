/**
 * Pull the assistant's prose out of `aside exec`'s stdout, as it streams.
 *
 * The server already owns the child process, and its stdout mirrors the
 * model's text token by token -- verified on a live turn, where the reply
 * arrived in eight chunks over three seconds while the transcript line for
 * that same message was not written until the whole message (text AND its
 * tool calls) had completed. That gap is exactly the "it all arrives at
 * once" the owner reported, so streaming stdout is worth doing properly.
 *
 * What stdout actually looks like, from that capture:
 *
 *   ESC[2m Thinking: … ESC[0m \n          <- dim: thinking
 *   A lighthouse is a tall tower …        <- plain: the answer, in chunks
 *   ESC[0m \n
 *   \n ESC[32m bash ESC[0m (command: …)\n <- green: a tool call
 *   \n ESC[2m > probe-ok ESC[0m \n        <- dim: that tool's output
 *
 * So the gate is not a guess about "does this look like prose": it is the
 * colour state. Anything emitted while a non-default SGR is active is
 * chrome (thinking, tool names, tool output) and is dropped; only text at
 * the default attribute is forwarded. That is a property of the writer, not
 * a heuristic about the content, which is what makes it safe to render.
 *
 * Three details this has to get right, all of them because chunks split at
 * arbitrary byte offsets:
 *
 *  - An escape sequence can straddle two chunks. A partial one is held back
 *    rather than emitted as literal `ESC[3`.
 *  - The dim run that opens a tool result begins with ` > `; that prefix is
 *    inside the dim region, so the colour gate already covers it.
 *  - A tool call's `(command: …)` tail is emitted at the DEFAULT attribute
 *    after `ESC[0m`, so a colour-only gate would leak it. Lines are
 *    therefore suppressed for the remainder of any line that began with a
 *    coloured run.
 *
 * Everything this produces is provisional: the transcript remains
 * authoritative, and the buffer is dropped the moment the real part lands.
 */

/** SGR parameters that mean "this is chrome, not the answer". */
const DIM = 2;
const RESET = 0;

export interface ProseFilterOptions {
  /** Cap on the retained buffer, so a runaway stream cannot grow unbounded. */
  maxBuffer?: number;
}

/** The escape byte, written as a code unit so it survives every editor. */
const ESC = '\u001b';

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^\\u0007]*\\u0007`, 'g');

export class ProseFilter {
  /** Bytes held back because they may be the head of an escape sequence. */
  private partial = '';
  /** True while a non-default SGR attribute is in effect. */
  private styled = false;
  /**
   * True when the current line has already contained styled output. The
   * unstyled remainder of such a line is chrome too (`(command: …)`).
   */
  private lineTainted = false;
  /** True once this line has emitted a non-space character. */
  private lineHasProse = false;

  constructor(private readonly opts: ProseFilterOptions = {}) {}

  /** Feed a stdout chunk; returns the prose to append, possibly empty. */
  feed(chunk: string): string {
    let input = this.partial + chunk;
    this.partial = '';
    let out = '';

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];

      if (ch === ESC) {
        // CSI form: ESC [ params letter. Hold back anything incomplete.
        const rest = input.slice(i);
        const match = /^\[([0-9;]*)([A-Za-z])/.exec(rest);
        if (!match) {
          // Either a partial sequence at the end of the chunk, or a form we
          // do not model. A short tail is held; anything longer is dropped
          // rather than leaked as literal escape text.
          if (rest.length < 12) this.partial = rest;
          break;
        }
        if (match[2] === 'm') this.applySgr(match[1]);
        i += match[0].length - 1;
        continue;
      }

      if (ch === '\n') {
        // A line that carried any styled run was chrome; its terminator
        // goes with it, otherwise every tool call leaves a blank line
        // behind in the streamed answer.
        const tainted = this.styled || this.lineTainted;
        this.lineTainted = false;
        this.lineHasProse = false;
        if (!tainted) out += ch;
        continue;
      }

      if (this.styled) {
        this.lineTainted = true;
        continue;
      }
      if (this.lineTainted) continue;

      // The CLI's status lines open with an UNSTYLED " • " bullet and only
      // then switch colour, so the colour gate alone lets the bullet
      // through -- observed on `Error Session not found`, which reached a
      // live client as a stray "•". A bullet at the head of a line marks
      // the whole line as chrome.
      if (ch === '•' && !this.lineHasProse) {
        this.lineTainted = true;
        // Anything already emitted for this line was leading whitespace.
        out = out.replace(/[^\S\n]+$/, '');
        continue;
      }
      if (!/\s/.test(ch)) this.lineHasProse = true;
      out += ch;
    }

    const max = this.opts.maxBuffer ?? 8000;
    return out.length > max ? out.slice(-max) : out;
  }

  /** Apply one SGR sequence's parameters to the style gate. */
  private applySgr(params: string): void {
    const codes = params
      .split(';')
      .map((p) => (p === '' ? RESET : Number(p)))
      .filter((n) => Number.isFinite(n));

    for (const code of codes) {
      if (code === RESET) {
        this.styled = false;
      } else if (code === DIM || (code >= 30 && code <= 97)) {
        // dim, or any foreground/background colour
        this.styled = true;
      } else if (code === 22 || code === 39 || code === 49) {
        // explicit "back to normal intensity / default colour"
        this.styled = false;
      }
    }
  }

  /** Reset between turns so state cannot leak across processes. */
  reset(): void {
    this.partial = '';
    this.styled = false;
    this.lineTainted = false;
    this.lineHasProse = false;
  }
}

/**
 * Strip every ANSI sequence from a string.
 *
 * Used on the captured stdout tail that error reporting reads, which is
 * shown to the user verbatim and must not carry terminal control bytes.
 */
export function stripAnsi(text: string): string {
  return String(text || '').replace(
    // eslint-disable-next-line no-control-regex
    ANSI_RE,
    '',
  );
}
