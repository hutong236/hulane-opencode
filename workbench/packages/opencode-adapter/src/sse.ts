/**
 * One server-sent event of an OpenCode event stream, as the stream gives it: `data: {…}` frames with a JSON body,
 * `: heartbeat` comment lines in between, and an empty line after every frame.
 */
export interface ServerEvent { id?: string; type: string; [key: string]: unknown }

/**
 * Reads events out of a byte stream as it arrives, line by line: a line may end with LF, CRLF or a lone CR, a
 * frame is the `data:` lines before an empty line. Testable on its own, apart from any socket.
 */
export class EventStreamParser {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private lines: string[] = [];
  private ended = false;

  /** Feeds bytes; returns the events that were completed by them. */
  push(chunk: Uint8Array): ServerEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events: ServerEvent[] = [];
    for (let line = this.takeLine(); line !== null; line = this.takeLine()) {
      if (line === '') {
        const event = this.flush();
        if (event) events.push(event);
      } else if (line.startsWith('data:')) {
        this.lines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    return events;
  }

  /** Ends the stream. A frame whose empty line never came is still an event; what is not a line is dropped. */
  close(): ServerEvent[] {
    this.ended = true;
    this.buffer += this.decoder.decode();
    const rest = this.buffer.trim() ? this.buffer : '';
    this.buffer = '';
    if (rest.startsWith('data:')) this.lines.push(rest.slice(5).replace(/^ /, ''));
    const event = this.flush();
    return event ? [event] : [];
  }

  get pending(): boolean {
    return !this.ended && (this.buffer.length > 0 || this.lines.length > 0);
  }

  /** The next line without its line ending, or null when there is none yet. A CR at the very end waits for what follows. */
  private takeLine(): string | null {
    const lf = this.buffer.indexOf('\n');
    const cr = this.buffer.indexOf('\r');
    if (lf < 0 && cr < 0) return null;
    if (cr >= 0 && (lf < 0 || cr < lf)) {
      if (cr === this.buffer.length - 1 && this.buffer.length > 1) return null;
      const line = this.buffer.slice(0, cr);
      this.buffer = this.buffer.slice(cr + 1 + (this.buffer[cr + 1] === '\n' ? 1 : 0));
      return line;
    }
    const line = this.buffer.slice(0, lf);
    this.buffer = this.buffer.slice(lf + 1);
    return line;
  }

  private flush(): ServerEvent | null {
    if (this.lines.length === 0) return null;
    const text = this.lines.join('\n');
    this.lines = [];
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { type: 'unparseable', raw: text }; }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      return { type: 'unparseable', raw: text };
    }
    return parsed as ServerEvent;
  }
}
