/**
 * A tiny Markdown subset, parsed into plain data. There is no HTML step anywhere: raw HTML in the source stays
 * literal text in `text` nodes, so no markup, script or event attribute can ever become live.
 */
export type Inline =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'list'; items: Inline[][] };

/** Inline runs of one line or block: `**bold**`, `*italic*`, `` `code` ``. Anything else is literal text. */
export function parseInline(text: string): Inline[] {
  const runs: Inline[] = [];
  let rest = text;
  const push = (type: Inline['type'], value: string) => { if (value) runs.push({ type, value } as Inline); };
  while (rest.length > 0) {
    const at = rest.search(/\*\*|(?<!\*)\*(?!\*)|`/);
    if (at < 0) { push('text', rest); break; }
    push('text', rest.slice(0, at));
    const marker = rest.slice(at).match(/^\*\*|^\*|^`/)![0];
    const close = rest.indexOf(marker, at + marker.length);
    if (close < 0) { push('text', rest.slice(at)); break; }
    const inner = rest.slice(at + marker.length, close);
    if (inner.length === 0) { push('text', rest.slice(at, close + marker.length)); }
    else if (marker === '**') push('bold', inner);
    else if (marker === '*') push('italic', inner);
    else push('code', inner);
    rest = rest.slice(close + marker.length);
  }
  return runs.length > 0 ? runs : [{ type: 'text', value: '' }];
}

/** Blocks separated by blank lines: `# ` headings, `- ` lists, everything else a paragraph. */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n');
    const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0] ?? '');
    if (heading && lines.length === 1) {
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3, inline: parseInline(heading[2]) });
      continue;
    }
    if (lines.every(line => /^[-*]\s+/.test(line))) {
      blocks.push({ type: 'list', items: lines.map(line => parseInline(line.replace(/^[-*]\s+/, ''))) });
      continue;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(chunk) });
  }
  return blocks;
}
