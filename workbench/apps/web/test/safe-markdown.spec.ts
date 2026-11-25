import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown } from '../src/components/markdown.js';

test('bold, italic and code become typed runs; anything else stays literal text', () => {
  assert.deepEqual(parseInline('**粗** *斜* `码` 其它'), [
    { type: 'bold', value: '粗' }, { type: 'text', value: ' ' },
    { type: 'italic', value: '斜' }, { type: 'text', value: ' ' },
    { type: 'code', value: '码' }, { type: 'text', value: ' 其它' },
  ]);
  // An unmatched marker is text, never a half-parsed construct.
  assert.deepEqual(parseInline('**未闭合'), [{ type: 'text', value: '**未闭合' }]);
  assert.deepEqual(parseInline('``'), [{ type: 'text', value: '``' }]);
  assert.deepEqual(parseInline(''), [{ type: 'text', value: '' }]);
});

test('headings, lists and paragraphs are the only block forms', () => {
  assert.deepEqual(parseMarkdown('# 标题\n\n- 一\n- 二\n\n正文两行\n第二行'), [
    { type: 'heading', level: 1, inline: [{ type: 'text', value: '标题' }] },
    { type: 'list', items: [[{ type: 'text', value: '一' }], [{ type: 'text', value: '二' }]] },
    { type: 'paragraph', inline: [{ type: 'text', value: '正文两行\n第二行' }] },
  ]);
  assert.deepEqual(parseMarkdown('## 二级')[0], { type: 'heading', level: 2, inline: [{ type: 'text', value: '二级' }] });
});

test('raw HTML is inert text in every form', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">点我</a>',
    '<svg onload=alert(1)></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '![x](javascript:alert(1))',
    '[点我](javascript:alert(1))',
  ];
  for (const attack of attacks) {
    // Nothing is ever recognized as markup beyond bold/italic/code: the whole sample is one literal text run.
    assert.deepEqual(parseInline(attack), [{ type: 'text', value: attack }], attack);
    const blocks = parseMarkdown(attack);
    assert.deepEqual(blocks, [{ type: 'paragraph', inline: [{ type: 'text', value: attack }] }], attack);
  }
  // Even inside a recognized construct the payload is literal text data, never markup.
  assert.deepEqual(parseInline('**<b>粗</b>**'), [{ type: 'bold', value: '<b>粗</b>' }]);
  assert.deepEqual(parseMarkdown('- <script>x</script>')[0], {
    type: 'list', items: [[{ type: 'text', value: '<script>x</script>' }]],
  });
});
