import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Space, Table, Typography } from 'antd';
import { getProjects, type RegisteredProject } from '../api/client';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projects: RegisteredProject[] };

/** Reads only registered project metadata. No filesystem or Git mutations. */
export function ProjectList() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ status: 'loading' });
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
  return <Card title="已登记项目" extra={<Button onClick={retry} disabled={state.status === 'loading'}>刷新</Button>}>
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
          ]} />)}
  </Card>;
}
