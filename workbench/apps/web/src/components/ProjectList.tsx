import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Space, Table, Typography } from 'antd';
import { ConfirmAction } from './UiPrimitives';
import {
  ApiError, getProjectStatus, getProjects, registerProject, renameProject, unregisterProject,
  type ProjectGitStatus, type RegisteredProject,
} from '../api/client';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projects: RegisteredProject[] };
type HealthState = { status: 'loading' } | { status: 'ready'; value: ProjectGitStatus } | { status: 'error'; message: string };
function ProjectHealth({ id }: { id: string }) {
  const [revision, setRevision] = useState(0);
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setHealth({ status: 'loading' });
    getProjectStatus(id, controller.signal).then(value => {
      if (!controller.signal.aborted) setHealth({ status: 'ready', value });
    }).catch(error => {
      if (!controller.signal.aborted) setHealth({
        status: 'error', message: error instanceof ApiError ? error.message : '无法读取 Git 状态',
      });
    });
    return () => controller.abort();
  }, [id, revision]);
  if (health.status === 'loading') return <Typography.Text aria-label="Git 状态加载中">加载中…</Typography.Text>;
  if (health.status === 'error') return <Space size="small">
    <Typography.Text type="danger">{health.message}</Typography.Text>
    <Button size="small" onClick={() => setRevision(value => value + 1)}>重试状态</Button>
  </Space>;
  return <Space size="small" wrap>
    <Typography.Text code>{health.value.headSha?.slice(0, 12) ?? '尚无提交'}</Typography.Text>
    <Typography.Text>{health.value.branch ?? '游离 HEAD'}</Typography.Text>
    <Typography.Text type={health.value.dirty ? 'warning' : 'success'}>
      {health.value.dirty ? '有未提交修改' : '工作区干净'}
    </Typography.Text>
  </Space>;
}
type RegistrationFields = { path: string; slug: string; name: string };
type RenameFields = { name: string };
const renameFormId = 'project-rename-form';

/** Registration changes only the local catalog; the API validates the real Git root. */
export function ProjectList() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [form] = Form.useForm<RegistrationFields>();
  const [submitting, setSubmitting] = useState(false);
  const [registrationError, setRegistrationError] = useState('');
  const [unregistering, setUnregistering] = useState<string | null>(null);
  const [unregisterError, setUnregisterError] = useState<{ name: string; message: string } | null>(null);
  // The row as it was loaded: its revision is what the API compares against, so a newer rename is never overwritten.
  const [renaming, setRenaming] = useState<RegisteredProject | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renameForm] = Form.useForm<RenameFields>();
  const mounted = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const unregisterPending = useRef<AbortController | null>(null);
  const renameRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
      unregisterPending.current?.abort();
      renameRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    // A failed unregister is reported for the list it happened on, not for a re-read one.
    setUnregisterError(null);
    getProjects(controller.signal).then(projects => {
      if (!controller.signal.aborted) setState({ status: 'ready', projects });
    }).catch(error => {
      if (!controller.signal.aborted) setState({
        status: 'error',
        message: error instanceof Error ? error.message : '无法读取项目列表',
      });
    });
    return () => controller.abort();
  }, [revision]);
  const retry = () => setRevision(value => value + 1);
  const submit = async (values: RegistrationFields) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSubmitting(true);
    setRegistrationError('');
    try {
      await registerProject(values, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      form.resetFields();
      retry();
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setRegistrationError(error instanceof ApiError ? error.message : '项目登记失败，请重试');
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current && !controller.signal.aborted) setSubmitting(false);
    }
  };
  /** Settles when the request does: the pending promise keeps the confirmation open, a settled one closes it. */
  const unregister = async (project: RegisteredProject): Promise<void> => {
    // One DELETE at a time, guarded synchronously because a double confirm can precede the re-render.
    if (unregisterPending.current) return;
    const controller = new AbortController();
    unregisterPending.current = controller;
    setUnregistering(project.id);
    setUnregisterError(null);
    try {
      await unregisterProject(project.id, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      retry();
    } catch (error) {
      // Only the catalog entry is ever removed, so a failed request leaves the row in place.
      if (!mounted.current || controller.signal.aborted) return;
      setUnregisterError({
        name: project.name,
        message: error instanceof ApiError ? error.message : '取消登记失败，请重试',
      });
    } finally {
      if (unregisterPending.current === controller) unregisterPending.current = null;
      if (mounted.current) setUnregistering(null);
    }
  };
  const openRename = (project: RegisteredProject) => {
    if (unregisterPending.current) return;
    setRenameError('');
    renameForm.setFieldsValue({ name: project.name });
    setRenaming(project);
  };
  const closeRename = () => {
    if (renameRequest.current) return;
    setRenaming(null);
    setRenameError('');
  };
  const rename = async (values: RenameFields) => {
    const project = renaming;
    // One save at a time, guarded synchronously because two submits can precede the re-render.
    if (!project || renameRequest.current) return;
    const controller = new AbortController();
    renameRequest.current = controller;
    setRenamePending(true);
    setRenameError('');
    try {
      await renameProject(project.id, { name: values.name, revision: project.revision }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setRenaming(null);
      retry();
    } catch (error) {
      // The dialog stays open with the typed name, so the user can read why nothing was saved.
      if (!mounted.current || controller.signal.aborted) return;
      setRenameError(error instanceof ApiError ? error.message : '重命名失败，请重试');
    } finally {
      if (renameRequest.current === controller) renameRequest.current = null;
      if (mounted.current) setRenamePending(false);
    }
  };
  const busy = unregistering !== null || renamePending;
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Card title="登记本地 Git 仓库">
      <Form form={form} layout="vertical" onFinish={values => void submit(values)} autoComplete="off">
        <Form.Item name="path" label="仓库绝对路径" rules={[{ required: true, message: '请输入绝对路径' },
          { pattern: /^\//, message: '必须使用绝对路径' }]}>
          <Input placeholder="/home/user/projects/cmdb" disabled={submitting} />
        </Form.Item>
        <Form.Item name="slug" label="项目标识" rules={[{ required: true, message: '请输入项目标识' },
          { pattern: /^[a-z0-9][a-z0-9-]{1,63}$/, message: '使用 2–64 位小写字母、数字或连字符' }]}>
          <Input placeholder="cmdb" disabled={submitting} />
        </Form.Item>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true, message: '请输入项目名称' }]}>
          <Input placeholder="CMDB" disabled={submitting} />
        </Form.Item>
        {registrationError && <Alert type="error" showIcon message="登记失败" description={registrationError}
          style={{ marginBottom: 16 }} />}
        <Button type="primary" htmlType="submit" loading={submitting}>登记仓库</Button>
      </Form>
    </Card>
    <Card title="已登记项目" extra={<Button onClick={retry} disabled={state.status === 'loading' || busy}>刷新</Button>}>
      {state.status === 'error' && <Alert type="error" showIcon message="项目列表加载失败"
        description={<Space direction="vertical"><Typography.Text>{state.message}</Typography.Text>
          <Button onClick={retry}>重试加载</Button></Space>} />}
      {unregisterError && <Alert type="error" showIcon message={`取消登记「${unregisterError.name}」失败`}
        description={unregisterError.message} style={{ marginBottom: 16 }} />}
      {state.status === 'loading' && <Table loading dataSource={[]} columns={[]} pagination={false}
        aria-label="项目列表加载中" />}
      {state.status === 'ready' && (state.projects.length === 0
        ? <Empty description="尚未登记项目" />
        : <Table rowKey="id" dataSource={state.projects} pagination={{ pageSize: 10 }}
            // Fixed widths leave the rest of the row to the one column without a width: the repository.
            tableLayout="fixed" scroll={{ x: 880 }}
            columns={[
              { title: '名称', dataIndex: 'name', key: 'name', width: 140, ellipsis: true },
              { title: '标识', dataIndex: 'slug', key: 'slug', width: 130, ellipsis: true },
              { title: '默认分支', dataIndex: 'default_branch', key: 'default_branch', width: 100, ellipsis: true },
              // The path and its origin are one fact shown on two lines; the whole value is in each line's tooltip.
              { title: '仓库 / 远端', key: 'repository',
                onCell: (item: RegisteredProject) => ({
                  'aria-label': `仓库 ${item.repo_root}，远端 ${item.remote_url ?? '无'}`,
                }),
                render: (_: unknown, item: RegisteredProject) => <div style={{ width: 0, minWidth: '100%' }}>
                  <Typography.Text ellipsis={{ tooltip: item.repo_root }}>{item.repo_root}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}
                    ellipsis={{ tooltip: item.remote_url ?? false }}>
                    {item.remote_url ? `origin: ${item.remote_url}` : '无远端'}
                  </Typography.Text>
                </div> },
              { title: '实时 Git 状态', key: 'git-health', width: 220, render: (_: unknown, item: RegisteredProject) => <ProjectHealth key={item.id} id={item.id} /> },
              { title: '操作', key: 'actions', width: 180, render: (_: unknown, item: RegisteredProject) => <Space size="small">
                  <Button size="small" disabled={busy} onClick={() => openRename(item)}>重命名</Button>
                  <ConfirmAction label="取消登记" size="small" danger loading={unregistering === item.id} disabled={busy}
                    title={`确认取消登记「${item.name}」？`} okText="确认取消登记" cancelText="保留登记"
                    description={`只会移除工作台中的登记记录，不会删除本地仓库文件、分支或未提交的修改。\n仓库目录：${item.repo_root}`}
                    onConfirm={() => unregister(item)} />
                </Space> },
            ]} />)}
    </Card>
    {renaming && <Modal open title={`重命名「${renaming.name}」`} okText="保存名称" cancelText="放弃修改"
      okButtonProps={{ form: renameFormId, htmlType: 'submit', loading: renamePending, disabled: unregistering !== null }}
      cancelButtonProps={{ disabled: renamePending }} closable={!renamePending} maskClosable={!renamePending}
      keyboard={!renamePending} onCancel={closeRename}>
      <Typography.Paragraph type="secondary">
        只修改工作台里显示的名称，不会改动仓库目录、Git 分支或任何文件。
      </Typography.Paragraph>
      {/* The form name is what labels the field for assistive technology and what the save button submits. */}
      <Form name={renameFormId} form={renameForm} layout="vertical" autoComplete="off"
        onFinish={values => void rename(values)}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true, message: '请输入项目名称' },
          { max: 120, message: '项目名称最多 120 个字符' }]}>
          <Input maxLength={120} showCount autoFocus disabled={renamePending} />
        </Form.Item>
        {renameError && <Alert type="error" showIcon message="重命名失败" description={renameError} />}
      </Form>
    </Modal>}
  </Space>;
}
