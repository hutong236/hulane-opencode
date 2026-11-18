import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Alert, Breadcrumb, Button, Card, ConfigProvider, Drawer, Empty, Form, Layout,
  Menu, Space, Switch, Tag, Typography, message, theme,
} from 'antd';
import type { MenuProps } from 'antd';
import { getHealth, type ApiHealth } from './api/client';
import { ConfirmAction } from './components/UiPrimitives';
import { sections, getSection, isSection, defaultSection, type Section } from './routes';

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Alert type="error" showIcon message="页面渲染失败"
      description={<Button onClick={() => window.location.reload()}>重新加载页面</Button>} />;
  }
}

type HealthState =
  | { status: 'loading'; info: null; error: '' }
  | { status: 'ok'; info: ApiHealth; error: '' }
  | { status: 'error'; info: null; error: string };

function useHealth() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<HealthState>({ status: 'loading', info: null, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', info: null, error: '' });
    getHealth(controller.signal).then(info => {
      if (!controller.signal.aborted) setState({ status: 'ok', info, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({
        status: 'error', info: null, error: error instanceof Error ? error.message : String(error),
      });
    });
    return () => controller.abort();
  }, [revision]);
  return { ...state, retry: () => setRevision(value => value + 1) };
}

function initialTheme(): boolean {
  try { return window.localStorage.getItem('workbench-theme') === 'dark'; }
  catch { return false; }
}

function WorkbenchShell() {
  const [section, setSection] = useState<Section>(() => getSection(window.location.pathname));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(initialTheme);
  const [messageApi, contextHolder] = message.useMessage();
  const [settingsForm] = Form.useForm<{ dark: boolean }>();
  const health = useHealth();

  useEffect(() => {
    if (!isSection(window.location.pathname)) window.history.replaceState(null, '', defaultSection.path);
    const syncHistory = () => setSection(getSection(window.location.pathname));
    window.addEventListener('popstate', syncHistory);
    return () => window.removeEventListener('popstate', syncHistory);
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('workbench-theme', dark ? 'dark' : 'light'); }
    catch { return; }
  }, [dark]);
  const navigate = useCallback((path: string) => {
    const destination = getSection(path);
    if (window.location.pathname !== destination.path) window.history.pushState(null, '', destination.path);
    setSection(destination);
    setMobileOpen(false);
  }, []);

  const items: MenuProps['items'] = sections.map(item => ({ key: item.path, label: item.label }));
  const menu = <Menu mode="inline" theme="dark" selectedKeys={[section.path]}
    onClick={({ key }) => navigate(key)} items={items} aria-label="工作台导航" />;

  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
    {contextHolder}
    <Layout className={`app-layout ${dark ? 'theme-dark' : ''}`}>
      <Sider width={232} theme="dark" breakpoint="lg" collapsedWidth={0} trigger={null}>
        <div className="brand">OpenCode 工作台</div>
        {menu}
      </Sider>
      <Layout>
        <Header className="app-header">
          <Space>
            <Button className="mobile-trigger" aria-label="打开导航" onClick={() => setMobileOpen(true)}>☰</Button>
            <Text strong>本地研发工作台</Text>
          </Space>
          {health.status === 'loading' && <Tag>API 连接中</Tag>}
          {health.status === 'ok' && <Tag color="success">API 已连接</Tag>}
          {health.status === 'error' && <Tag color="error">API 未连接</Tag>}
        </Header>
        <Content className="app-content">
          <Breadcrumb className="app-breadcrumb" items={[{ title: '工作台' }, { title: section.label }]} />
          <Title level={3}>{section.label}</Title>
          <Paragraph type="secondary">{section.description}</Paragraph>
          {health.status === 'error' && <Alert type="error" showIcon message="API 连接失败" className="app-alert"
            description={<div><p>{health.error}</p><Button onClick={health.retry}>重试连接</Button></div>} />}
          {section.path === '/settings' ? <Card title="本地外观设置">
            <Form form={settingsForm} layout="vertical" initialValues={{ dark }} onFinish={(values: { dark: boolean }) => {
              setDark(values.dark);
              void messageApi.success('外观已保存到当前浏览器');
            }}>
              <Form.Item name="dark" label="深色模式" valuePropName="checked"><Switch /></Form.Item>
              <Space>
                <Button htmlType="submit" type="primary">保存设置</Button>
                <ConfirmAction label="恢复默认" title="确认恢复默认外观？" onConfirm={() => {
                  settingsForm.setFieldValue('dark', false);
                  setDark(false);
                  void messageApi.success('已恢复默认外观');
                }} />
              </Space>
            </Form>
            <Paragraph className="app-settings-hint" type="secondary">
              模型、Agent、Skill 和 MCP 管理尚未开放（WB-025、WB-026）。
            </Paragraph>
          </Card> : <Card title={<Space><span>{section.label}</span><Tag>待开放 · {section.issue}</Tag></Space>}>
            <Empty description="当前尚无可展示的真实业务数据；此模块未实现" />
            <div className="placeholder-actions"><Button disabled>新增记录（待开放）</Button></div>
          </Card>}
        </Content>
      </Layout>
      <Drawer title="工作台导航" placement="left" open={mobileOpen}
        onClose={() => setMobileOpen(false)} width={270} className="mobile-drawer">
        {menu}
      </Drawer>
    </Layout>
  </ConfigProvider>;
}

export default function App() {
  return <ErrorBoundary><WorkbenchShell /></ErrorBoundary>;
}
