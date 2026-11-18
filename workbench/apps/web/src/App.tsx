import { useEffect, useState } from 'react';
import { Alert, Card, Layout, Menu, Space, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
const pages = [
  { key: 'projects', label: '项目管理' },
  { key: 'requirements', label: '需求中心' },
  { key: 'workflows', label: '工作流中心' },
  { key: 'runs', label: '执行监控' },
  { key: 'integration', label: '集成测试' },
  { key: 'settings', label: '系统配置' },
];

type Health = { status: string; service: string };
export default function App() {
  const [page, setPage] = useState(pages[0].key);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<Health>; })
      .then(setHealth)
      .catch(err => { if (!controller.signal.aborted) setHealthError(String(err)); });
    return () => controller.abort();
  }, []);
  const selected = pages.find(p => p.key === page) ?? pages[0];
  const onMenuClick: MenuProps['onClick'] = ({ key }) => setPage(key);
  return <Layout className="app-layout">
    <Sider breakpoint="lg" collapsedWidth="0" theme="dark">
      <div className="brand">OpenCode 工作台</div>
      <Menu theme="dark" mode="inline" selectedKeys={[page]} onClick={onMenuClick} items={pages} />
    </Sider>
    <Layout>
      <Header className="app-header"><Space><Text strong>本地研发工作台</Text><Tag color={health?.status === 'ok' ? 'success' : 'default'}>{health?.status === 'ok' ? 'API 已连接' : 'API 未连接'}</Tag></Space></Header>
      <Content className="app-content">
        <Title level={3}>{selected.label}</Title>
        {healthError && <Alert type="error" showIcon message="API 连接失败" description={healthError} className="app-alert" />}
        <Card><Text type="secondary">此模块尚未实现。工程初始化仅提供真实 API 健康检查；后续将按 WB-002～WB-028 逐项交付。</Text></Card>
      </Content>
    </Layout>
  </Layout>;
}
