import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Table, Tag, Typography,
} from 'antd';
import { ConfirmAction, DataTable } from './UiPrimitives';
import { SafeMarkdown } from './SafeMarkdown';
import {
  ApiError, ALLOWED_TRANSITIONS, createRequirement, getRequirement, getRequirements,
  getRequirementVersions, restoreRequirement, transitionRequirement, updateRequirement,
  type Requirement, type RequirementContent, type RequirementPriority, type RequirementVersion,
} from '../api/client';

const STATUS_LABEL: Record<Requirement['status'], string> = {
  draft: '草稿', reviewed: '已评审', approved: '已批准', archived: '已归档',
};
const STATUS_COLOR: Record<Requirement['status'], string> = {
  draft: 'default', reviewed: 'processing', approved: 'success', archived: 'warning',
};
const PRIORITY_LABEL: Record<RequirementPriority, string> = { low: '低', medium: '中', high: '高', critical: '紧急' };
const NEXT_LABEL: Record<string, string> = { reviewed: '标记为已评审', approved: '标记为已批准', archived: '标记为已归档' };

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; requirements: Requirement[] };

interface RequirementFields {
  requirementKey: string;
  title: string;
  priority: RequirementPriority;
  background: string;
  goal: string;
  scope: string;
  risk: string;
  acceptanceCriteria: { id: string; text: string }[];
  actor: string;
  summary: string;
}

const contentOf = (fields: RequirementFields): RequirementContent => ({
  title: fields.title,
  background: fields.background,
  goal: fields.goal,
  scope: fields.scope,
  risk: fields.risk,
  priority: fields.priority,
  acceptanceCriteria: fields.acceptanceCriteria,
});

/** The fields every write form shares; the API needs an actor and a summary for each new version. */
function RequirementFormItems({ withKey }: { withKey: boolean }) {
  return <>
    {withKey && <Form.Item name="requirementKey" label="业务编号" rules={[
      { required: true, message: '请填写业务编号' },
      { pattern: /^REQ-[0-9]{3,6}$/, message: '格式为 REQ-000 到 REQ-999999' },
    ]}><Input placeholder="REQ-001" aria-label="业务编号" /></Form.Item>}
    <Form.Item name="title" label="标题" rules={[
      { required: true, message: '请填写标题' },
      { max: 200, message: '标题最多 200 个字符' },
    ]}><Input aria-label="标题" /></Form.Item>
    <Form.Item name="priority" label="优先级" initialValue="medium">
      <Select aria-label="优先级" options={(Object.keys(PRIORITY_LABEL) as RequirementPriority[])
        .map(value => ({ value, label: PRIORITY_LABEL[value] }))} />
    </Form.Item>
    <Form.Item name="background" label="背景" rules={[{ max: 20000, message: '背景最多 20000 个字符' }]}>
      <Input.TextArea rows={3} aria-label="背景" />
    </Form.Item>
    <Form.Item name="goal" label="目标" rules={[{ max: 20000, message: '目标最多 20000 个字符' }]}>
      <Input.TextArea rows={3} aria-label="目标" />
    </Form.Item>
    <Form.Item name="scope" label="范围" rules={[{ max: 20000, message: '范围最多 20000 个字符' }]}>
      <Input.TextArea rows={3} aria-label="范围" />
    </Form.Item>
    <Form.Item name="risk" label="风险" rules={[{ max: 5000, message: '风险最多 5000 个字符' }]}>
      <Input.TextArea rows={2} aria-label="风险" />
    </Form.Item>
    <Form.List name="acceptanceCriteria">
      {(fields, { add, remove }) => <>
        {fields.map((field, index) => <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
          <Form.Item name={[field.name, 'id']} rules={[{ required: true, message: '请填写条目编号' }]} style={{ marginBottom: 8 }}>
            <Input placeholder={`条目 ${index + 1} 编号`} aria-label={`验收条目 ${index + 1} 编号`} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name={[field.name, 'text']} rules={[
            { required: true, message: '请填写条目内容' },
            { max: 2000, message: '条目内容最多 2000 个字符' },
          ]} style={{ marginBottom: 8 }}>
            <Input placeholder="验收条目内容" aria-label={`验收条目 ${index + 1} 内容`} />
          </Form.Item>
          <Button danger size="small" onClick={() => remove(field.name)}
            aria-label={`删除验收条目 ${index + 1}`}>删除</Button>
        </Space>)}
        <Form.Item>
          <Button onClick={() => add({ id: `AC-${fields.length + 1}`, text: '' })}
            aria-label="添加验收条目" disabled={fields.length >= 50}>添加验收条目</Button>
        </Form.Item>
      </>}
    </Form.List>
    <Form.Item name="actor" label="操作人" rules={[
      { required: true, message: '请填写操作人' },
      { max: 120, message: '操作人最多 120 个字符' },
    ]}><Input aria-label="操作人" /></Form.Item>
    <Form.Item name="summary" label="变更摘要" rules={[
      { required: true, message: '请填写变更摘要' },
      { max: 500, message: '摘要最多 500 个字符' },
    ]}><Input.TextArea rows={2} aria-label="变更摘要" /></Form.Item>
  </>;
}

export function Requirements() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [detail, setDetail] = useState<Requirement | null>(null);
  const [historyFor, setHistoryFor] = useState<Requirement | null>(null);
  const [versions, setVersions] = useState<RequirementVersion[] | null>(null);
  const [viewedVersion, setViewedVersion] = useState<RequirementVersion | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Transitions and restores append no content version, but the API still records who did it.
  const [actor, setActor] = useState('');
  const [createForm] = Form.useForm<RequirementFields>();
  const [editForm] = Form.useForm<RequirementFields>();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    getRequirements(controller.signal).then(requirements => {
      if (!controller.signal.aborted) setState({ status: 'ready', requirements });
    }).catch(error => {
      if (!controller.signal.aborted) setState({
        status: 'error', message: error instanceof ApiError ? error.message : '需求列表加载失败',
      });
    });
    return () => controller.abort();
  }, [revision]);

  const refresh = () => setRevision(value => value + 1);
  const run = async (
    who: string, action: (actor: string) => Promise<Requirement>, after?: (updated: Requirement) => void,
  ) => {
    if (busyRef.current) return;
    if (!who.trim()) { setFormError('请先填写操作人'); return; }
    busyRef.current = true;
    setBusy(true);
    try {
      const updated = await action(who.trim());
      setFormError('');
      after?.(updated);
      refresh();
    } catch (error) {
      // The typed form stays open: a refused write never loses what was entered.
      setFormError(error instanceof ApiError ? error.message : '操作失败，请重试');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openDetail = (requirement: Requirement) => {
    setDetail(requirement);
    setFormError('');
    setViewedVersion(null);
  };

  const openHistory = async (requirement: Requirement) => {
    setHistoryFor(requirement);
    setVersions(null);
    setViewedVersion(null);
    try {
      setVersions(await getRequirementVersions(requirement.id));
    } catch (error) {
      setVersions([]);
      setFormError(error instanceof ApiError ? error.message : '版本历史加载失败');
    }
  };

  const openEdit = (requirement: Requirement) => {
    editForm.setFieldsValue({
      requirementKey: requirement.requirement_key,
      title: requirement.content.title,
      priority: requirement.content.priority,
      background: requirement.content.background,
      goal: requirement.content.goal,
      scope: requirement.content.scope,
      risk: requirement.content.risk,
      acceptanceCriteria: requirement.content.acceptanceCriteria.map(entry => ({ ...entry })),
      actor: '',
      summary: '',
    });
    setFormError('');
    setEditOpen(true);
  };

  return <Card title="需求中心" extra={<Button aria-label="刷新" onClick={refresh} disabled={state.status === 'loading'}>刷新</Button>}>
    {state.status === 'error' && <Alert type="error" showIcon message="需求列表加载失败"
      description={<div><p>{state.message}</p><Button aria-label="重试" onClick={refresh}>重试</Button></div>} className="app-alert" />}
    {state.status === 'loading' && <Table loading dataSource={[]} columns={[]} pagination={false}
      aria-label="需求列表加载中" />}
    {state.status === 'ready' && <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { createForm.resetFields(); setFormError(''); setCreateOpen(true); }}
          aria-label="新建需求">新建需求</Button>
      </Space>
      <DataTable<Requirement> rowKey="id" aria-label="需求列表" dataSource={state.requirements}
        tableLayout="fixed" scroll={{ x: 880 }} columns={[
          { title: '业务编号', dataIndex: 'requirement_key', width: 110 },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          { title: '状态', dataIndex: 'status', width: 90,
            render: (status: Requirement['status']) => <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag> },
          { title: '优先级', width: 80,
            render: (_, row) => PRIORITY_LABEL[row.content.priority] },
          { title: '当前版本', width: 90, render: (_, row) => `V${row.current_version}` },
          { title: '更新时间', dataIndex: 'updated_at', width: 190 },
          { title: '操作', width: 170, render: (_, row) => <Space size="small">
            <Button size="small" onClick={() => openDetail(row)} aria-label="详情">详情</Button>
            <Button size="small" onClick={() => void openHistory(row)} aria-label="版本历史">版本历史</Button>
          </Space> },
        ]} />
    </>}

    <Modal title="新建需求" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} width={720}>
      <Form form={createForm} layout="vertical" name="requirement-create-form" onFinish={values => {
        void run(values.actor, () => createRequirement({
          requirementKey: values.requirementKey, content: contentOf(values), actor: values.actor, summary: values.summary,
        }), () => setCreateOpen(false));
      }}>
        {formError && createOpen && <Alert type="error" showIcon message="登记失败" description={formError}
          style={{ marginBottom: 12 }} />}
        <RequirementFormItems withKey />
        <Button type="primary" htmlType="submit" loading={busy} aria-label="保存需求">保存需求</Button>
      </Form>
    </Modal>

    <Modal title="保存修订（生成新版本）" open={editOpen} onCancel={() => setEditOpen(false)} footer={null} width={720}>
      <Form form={editForm} layout="vertical" name="requirement-edit-form" onFinish={values => {
        if (!detail) return;
        void run(values.actor, () => updateRequirement(detail.id, {
          requirementKey: detail.requirement_key, content: contentOf(values),
          actor: values.actor, summary: values.summary, expectedRevision: detail.revision,
        }), updated => { setEditOpen(false); setDetail(updated); });
      }}>
        {formError && editOpen && <Alert type="error" showIcon message="保存失败" description={formError}
          style={{ marginBottom: 12 }} />}
        <RequirementFormItems withKey={false} />
        <Button type="primary" htmlType="submit" loading={busy} aria-label="保存修订">保存修订</Button>
      </Form>
    </Modal>

    <Modal title={detail ? `${detail.requirement_key} ${detail.title}` : ''} open={detail !== null}
      onCancel={() => setDetail(null)} footer={null} width={720}>
      {detail && <>
        {formError && !editOpen && !createOpen && <Alert type="error" showIcon message="操作失败" description={formError}
          style={{ marginBottom: 12 }} />}
        <Space style={{ marginBottom: 12 }} wrap>
          <Input aria-label="操作人" placeholder="操作人" value={actor} style={{ width: 160 }}
            onChange={event => setActor(event.target.value)} />
          <Tag color={STATUS_COLOR[detail.status]}>{STATUS_LABEL[detail.status]}</Tag>
          <Typography.Text type="secondary">当前版本 V{detail.current_version} · 修订号 {detail.revision}</Typography.Text>
          {ALLOWED_TRANSITIONS[detail.status].map(next => <ConfirmAction key={next} label={NEXT_LABEL[next]}
            title={`确认将 ${detail.requirement_key} ${NEXT_LABEL[next].replace('标记为', '')}？`}
            description="状态转换只改状态，不改写任何历史快照。" okText="确认转换" cancelText="取消"
            loading={busy} onConfirm={() => run(actor, who => getRequirement(detail.id).then(current =>
              transitionRequirement(current.id, {
                status: next, expectedRevision: current.revision,
                actor: who, summary: NEXT_LABEL[next],
              })), updated => setDetail(updated))} />)}
          <Button size="small" loading={busy} onClick={() => openEdit(detail)} aria-label="保存修订">保存修订</Button>
          <Button size="small" onClick={() => void openHistory(detail)} aria-label="版本历史">版本历史</Button>
        </Space>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="背景"><SafeMarkdown text={detail.content.background} /></Descriptions.Item>
          <Descriptions.Item label="目标"><SafeMarkdown text={detail.content.goal} /></Descriptions.Item>
          <Descriptions.Item label="范围"><SafeMarkdown text={detail.content.scope} /></Descriptions.Item>
          <Descriptions.Item label="风险"><SafeMarkdown text={detail.content.risk} /></Descriptions.Item>
          <Descriptions.Item label="优先级">{PRIORITY_LABEL[detail.content.priority]}</Descriptions.Item>
          <Descriptions.Item label="验收条目">
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {detail.content.acceptanceCriteria.map(entry => <li key={entry.id}>
                <Typography.Text code>{entry.id}</Typography.Text> <SafeMarkdown text={entry.text} />
              </li>)}
            </ol>
          </Descriptions.Item>
        </Descriptions>
      </>}
    </Modal>

    <Modal title={historyFor ? `${historyFor.requirement_key} 的版本历史` : ''} open={historyFor !== null}
      onCancel={() => { setHistoryFor(null); setViewedVersion(null); }} footer={null} width={720}>
      {formError && historyFor && !editOpen && !createOpen && <Alert type="error" showIcon message="操作失败"
        description={formError} style={{ marginBottom: 12 }} />}
      <Space style={{ marginBottom: 12 }}>
        <Input aria-label="操作人" placeholder="操作人" value={actor} style={{ width: 160 }}
          onChange={event => setActor(event.target.value)} />
      </Space>
      <DataTable<RequirementVersion> rowKey="id" aria-label="版本历史" dataSource={versions ?? []}
        loading={versions === null} tableLayout="fixed" scroll={{ x: 820 }} columns={[
          { title: '版本', width: 70, render: (_, row) => `V${row.version}` },
          { title: '摘要', dataIndex: 'summary', width: 220, ellipsis: true },
          { title: '操作人', dataIndex: 'actor', width: 110, ellipsis: true },
          { title: '时间', dataIndex: 'created_at', width: 180 },
          { title: '内容哈希', width: 130, render: (_, row) => <Typography.Text code>{row.content_sha256.slice(0, 12)}</Typography.Text> },
          { title: '操作', width: 210, render: (_, row) => <Space size="small">
            <Button size="small" onClick={() => setViewedVersion(row)} aria-label={`查看 V${row.version}`}>查看</Button>
            {historyFor && row.version !== historyFor.current_version && <ConfirmAction size="small"
              label="恢复为新草稿" title={`确认将 V${row.version} 恢复为新草稿？`}
              description="历史快照保持只读；恢复会生成一个新版本。" okText="确认恢复" cancelText="取消"
              loading={busy} onConfirm={() => run(actor, who => getRequirement(historyFor.id).then(current =>
                restoreRequirement(current.id, {
                  version: row.version, expectedRevision: current.revision,
                  actor: who, summary: `恢复 V${row.version} 为新草稿`,
                })), updated => {
                  setHistoryFor(null);
                  setViewedVersion(null);
                  if (detail) setDetail(updated);
                })} />}
          </Space> },
        ]} />
      {viewedVersion && <Descriptions column={1} size="small" title={`V${viewedVersion.version}（只读快照）`}
        style={{ marginTop: 12 }}>
        <Descriptions.Item label="摘要">{viewedVersion.summary || '（无）'}</Descriptions.Item>
        <Descriptions.Item label="操作人">{viewedVersion.actor}</Descriptions.Item>
        <Descriptions.Item label="内容哈希"><Typography.Text code>{viewedVersion.content_sha256}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="标题">{viewedVersion.content.title}</Descriptions.Item>
        <Descriptions.Item label="背景"><SafeMarkdown text={viewedVersion.content.background} /></Descriptions.Item>
        <Descriptions.Item label="目标"><SafeMarkdown text={viewedVersion.content.goal} /></Descriptions.Item>
        <Descriptions.Item label="范围"><SafeMarkdown text={viewedVersion.content.scope} /></Descriptions.Item>
        <Descriptions.Item label="风险"><SafeMarkdown text={viewedVersion.content.risk} /></Descriptions.Item>
      </Descriptions>}
    </Modal>
  </Card>;
}
