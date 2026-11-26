import { useState } from 'react';
import { Button, Space, Tag, Typography } from 'antd';
import type { DiffOp, RequirementDiffChange, StoredRequirementDiff } from '../api/client';
import { DIFF_OP_LABEL, NEEDS_REVIEW_LABEL, describePointer, formatDiffValue } from './requirement-diff-text';

const OP_COLOR: Record<DiffOp, string> = {
  added: 'success', modified: 'warning', deleted: 'error', needs_review: 'processing',
};

/** A stored value as text. Text is kept as it was, line breaks included; any other value as JSON. */
function DiffValue({ value, empty }: { value: unknown; empty: string }) {
  if (value === undefined || value === null) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return <Typography.Text aria-label="差分值" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
    {formatDiffValue(value)}
  </Typography.Text>;
}

function DiffChange({ change }: { change: RequirementDiffChange }) {
  const where = <Typography.Text code>{describePointer(change.pointer)}</Typography.Text>;
  if (change.op === 'added') {
    return <li style={{ marginBottom: 10 }} aria-label={`新增 ${change.pointer}`}>
      <Space wrap size="small"><Tag color={OP_COLOR.added}>新增</Tag>{where}</Space>
      <div><DiffValue value={change.value} empty="（空）" /></div>
    </li>;
  }
  if (change.op === 'deleted') {
    return <li style={{ marginBottom: 10 }} aria-label={`删除 ${change.pointer}`}>
      <Space wrap size="small"><Tag color={OP_COLOR.deleted}>删除</Tag>{where}</Space>
      <div><DiffValue value={change.old_value} empty="（空）" /></div>
    </li>;
  }
  if (change.op === 'modified') {
    return <li style={{ marginBottom: 10 }} aria-label={`修改 ${change.pointer}`}>
      <Space wrap size="small"><Tag color={OP_COLOR.modified}>修改</Tag>{where}</Space>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Typography.Text type="secondary" aria-label="原值">原值：</Typography.Text>
        <DiffValue value={change.old_value} empty="（空）" />
        <Typography.Text type="secondary">→</Typography.Text>
        <Typography.Text type="secondary" aria-label="新值">新值：</Typography.Text>
        <DiffValue value={change.new_value} empty="（空）" />
      </div>
    </li>;
  }
  return <li style={{ marginBottom: 10 }} aria-label={`待审核 ${change.pointer}`}>
    <Space wrap size="small"><Tag color={OP_COLOR.needs_review}>待审核</Tag>{where}</Space>
    {change.reason && <div><Typography.Text type="warning">{NEEDS_REVIEW_LABEL[change.reason]}</Typography.Text></div>}
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <div><Typography.Text type="secondary">基准版本</Typography.Text><DiffValue value={change.old_value} empty="（这一侧没有）" /></div>
      <div><Typography.Text type="secondary">目标版本</Typography.Text><DiffValue value={change.new_value} empty="（这一侧没有）" /></div>
    </div>
    {(change.related?.length ?? 0) > 0 && <div>
      <Typography.Text type="secondary">相关：</Typography.Text>
      {change.related!.map(pointer => <Typography.Text code key={pointer} style={{ marginRight: 8 }}>{describePointer(pointer)}</Typography.Text>)}
    </div>}
  </li>;
}

/** One stored comparison: what was compared, how much changed, and every change with its values. */
export function RequirementDiffView({ record }: { record: StoredRequirementDiff }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const { summary } = record;
  return <div aria-label="版本差分" style={{ marginTop: 12, padding: 12, border: '1px solid #d9d9d9', borderRadius: 8 }}>
    <Space wrap size="middle" style={{ marginBottom: 8 }}>
      <Typography.Text strong aria-label="差分版本">V{record.base_version} → V{record.target_version}</Typography.Text>
      <Tag color="success">新增 {summary.added}</Tag>
      <Tag color="warning">修改 {summary.modified}</Tag>
      <Tag color="error">删除 {summary.deleted}</Tag>
      <Tag color="processing">待审核 {summary.needs_review}</Tag>
      <Tag>未变化 {summary.unchanged}</Tag>
    </Space>
    <div><Typography.Text type="secondary">差分哈希 </Typography.Text>
      <Typography.Text code aria-label="差分哈希">{record.diff_sha256.slice(0, 16)}</Typography.Text></div>
    {record.diff.changes.length === 0 && <Typography.Text style={{ display: 'block', marginTop: 8 }}>两个版本没有差别。</Typography.Text>}
    <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 0, listStyle: 'none' }}>
      {record.diff.changes.map((change, index) => <DiffChange key={`${change.pointer}-${index}`} change={change} />)}
    </ul>
    {record.diff.unchanged.length > 0 && <div style={{ marginTop: 8 }}>
      <Button size="small" onClick={() => setShowUnchanged(shown => !shown)} aria-expanded={showUnchanged}
        aria-label={showUnchanged ? '收起未变化' : '显示未变化'}>{showUnchanged ? '收起未变化的项' : `显示未变化的 ${summary.unchanged} 项`}</Button>
      {showUnchanged && <ul aria-label="未变化" style={{ marginTop: 6, marginBottom: 0, paddingLeft: 20 }}>
        {record.diff.unchanged.map((pointer, index) => <li key={`${pointer}-${index}`}>
          <Typography.Text code>{describePointer(pointer)}</Typography.Text>
        </li>)}
      </ul>}
    </div>}
  </div>;
}
