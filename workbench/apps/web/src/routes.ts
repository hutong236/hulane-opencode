export const sections = [
  { path: '/projects', label: '项目管理', issue: 'WB-004', description: '本地 Git 仓库与项目健康状态' },
  { path: '/requirements', label: '需求中心', issue: 'WB-005', description: '全局需求、版本和差分' },
  { path: '/workflows', label: '工作流中心', issue: 'WB-013', description: '编排受控执行流程' },
  { path: '/runs', label: '执行监控', issue: 'WB-014', description: '真实 Agent 运行、日志与审批' },
  { path: '/integration', label: '集成测试', issue: 'WB-023', description: '跨项目环境与服务验证' },
  { path: '/settings', label: '系统配置', issue: 'WB-025', description: '模型、Agent、Skill 与 MCP' },
] as const;

export type Section = (typeof sections)[number];
export const defaultSection: Section = sections[0];

export function getSection(pathname: string): Section {
  const path = pathname.replace(/\/+$/, '') || '/';
  return sections.find(item => item.path === path) ?? defaultSection;
}

export function isSection(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return sections.some(item => item.path === path);
}
