import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Space, Table, Typography } from 'antd';
import { ApiError, getProjectStatus, getProjects, registerProject, type ProjectGitStatus, type RegisteredProject } from '../api/client';

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

/** Registration changes only the local catalog; the API validates the real Git root. */
export function ProjectList() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [form] = Form.useForm<RegistrationFields>();
  const [submitting, setSubmitting] = useState(false);
  const [registrationError, setRegistrationError] = useState('');
  const mounted = useRef(true);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
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
    <Card title="已登记项目" extra={<Button onClick={retry} disabled={state.status === 'loading'}>刷新</Button>}>
      {state.status === 'error' && <Alert type="error" showIcon message="项目列表加载失败"
        description={<Space direction="vertical"><Typography.Text>{state.message}</Typography.Text>
          <Button onClick={retry}>重试加载</Button></Space>} />}
      {state.status === 'loading' && <Table loading dataSource={[]} columns={[]} pagination={false}
        aria-label="项目列表加载中" />}
      {state.status === 'ready' && (state.projects.length === 0
        ? <Empty description="尚未登记项目" />
        : <Table rowKey="id" dataSource={state.projects} pagination={{ pageSize: 10 }}
            columns={[
              { title: '名称', dataIndex: 'name', key: 'name' },
              { title: '标识', dataIndex: 'slug', key: 'slug' },
              { title: '默认分支', dataIndex: 'default_branch', key: 'default_branch' },
              { title: '本地仓库', dataIndex: 'repo_root', key: 'repo_root', ellipsis: true },
              { title: '实时 Git 状态', key: 'git-health', render: (_: unknown, item: RegisteredProject) => <ProjectHealth key={item.id} id={item.id} /> },
            ]} />)}
    </Card>
  </Space>;
}
