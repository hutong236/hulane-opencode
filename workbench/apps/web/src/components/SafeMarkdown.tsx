import type { ReactNode } from 'react';
import { parseMarkdown, type Inline } from './markdown';

function renderInline(runs: Inline[], key: string): ReactNode {
  return runs.map((run, index) => {
    const node = run.type === 'text' ? run.value
      : run.type === 'bold' ? <strong key={`${key}-${index}`}>{run.value}</strong>
      : run.type === 'italic' ? <em key={`${key}-${index}`}>{run.value}</em>
      : <code key={`${key}-${index}`}>{run.value}</code>;
    return run.type === 'text' ? <span key={`${key}-${index}`}>{node}</span> : node;
  });
}

/**
 * Renders the parsed subset as React elements only. The source text is never parsed as HTML and never reaches
 * `dangerouslySetInnerHTML`, so a `<script>` in a requirement is just five characters of text.
 */
export function SafeMarkdown({ text }: { text: string }) {
  return <div className="safe-markdown">{parseMarkdown(text).map((block, index) => {
    const key = `b${index}`;
    if (block.type === 'heading') {
      return <p key={key} className="safe-markdown-heading" style={{ fontWeight: 600, margin: '8px 0 4px' }}>
        {renderInline(block.inline, key)}
      </p>;
    }
    if (block.type === 'list') {
      return <ul key={key} style={{ margin: '4px 0', paddingLeft: 20 }}>
        {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>)}
      </ul>;
    }
    return <p key={key} style={{ whiteSpace: 'pre-line', margin: '4px 0' }}>{renderInline(block.inline, key)}</p>;
  })}</div>;
}
