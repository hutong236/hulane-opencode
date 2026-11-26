import type { DiffOp, NeedsReviewReason } from '../api/client';

export const DIFF_OP_LABEL: Record<DiffOp, string> = {
  added: '新增', modified: '修改', deleted: '删除', needs_review: '待审核',
};

export const NEEDS_REVIEW_LABEL: Record<NeedsReviewReason, string> = {
  duplicate_id: '同一个编号在一个版本里出现了多次，无法确定该对应哪一条。',
  unkeyed_array_changed: '没有稳定编号的列表整体发生了变化，无法逐条对应。',
  reordered: '列表里的值都在，只是顺序变了；请确认顺序是否有含义。',
  possible_rename: '一条消失了，另一条内容相同但编号不同：可能只是改了编号。',
  ambiguous_match: '几条内容相同，可能是一次拆分、合并或复制，无法确定对应关系。',
};

const FIELD_LABEL: Record<string, string> = {
  title: '标题', background: '背景', goal: '目标', scope: '范围', risk: '风险', priority: '优先级',
  acceptanceCriteria: '验收条目', text: '内容', note: '备注',
};

const unescapeToken = (token: string): string => token.replace(/~1/g, '/').replace(/~0/g, '~');

/** `/list[id=AC-2]` addresses an item by id and `/tags[="prod"]` a plain value of a list; anything else is a name. */
function addressOf(segment: string): { key: string; item?: string; value?: string } | null {
  const byId = /^(.*)\[id=(.*)\]$/.exec(segment);
  if (byId) return { key: byId[1], item: unescapeToken(byId[2]) };
  const byValue = /^(.*)\[=(.*)\]$/.exec(segment);
  if (byValue) return { key: byValue[1], value: byValue[2] };
  return null;
}

/** A pointer in words: `/acceptanceCriteria[id=AC-2]/text` becomes `验收条目 AC-2 / 内容`. */
export function describePointer(pointer: string): string {
  if (pointer === '') return '整份内容';
  return pointer.slice(1).split('/').map(segment => {
    const address = addressOf(segment);
    const key = unescapeToken(address ? address.key : segment);
    const label = FIELD_LABEL[key] ?? key;
    if (address?.item !== undefined) return `${label} ${address.item}`;
    if (address?.value !== undefined) return `${label} 中的 ${address.value}`;
    return label;
  }).join(' / ');
}

/** A value as text. Text is shown as it is; anything else as JSON, so a reader sees exactly what was stored. */
export function formatDiffValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}
