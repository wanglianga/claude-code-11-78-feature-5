import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth, ROLE_LABEL } from '../state/auth';
import { useApp } from '../state/app';

const NAV_GROUPS: Array<{ title: string; items: Array<{ to: string; label: string }> }> = [
  {
    title: '数据底座',
    items: [
      { to: '/loader', label: '装载器与签名' },
      { to: '/alignment', label: '语义对齐器' },
      { to: '/rules', label: '规则浏览器' },
    ],
  },
  {
    title: '核验与压缩',
    items: [
      { to: '/verification', label: '时序核验器' },
      { to: '/events', label: '压缩事件双路线' },
      { to: '/evidence', label: '证据图' },
    ],
  },
  {
    title: '处置与同步',
    items: [
      { to: '/disposal', label: '处置簿' },
      { to: '/sync', label: '同步对照器' },
      { to: '/safety', label: '策略安全评估' },
      { to: '/selfcheck', label: '自检与验证' },
    ],
  },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { workerMessage, workerBusy } = useApp();
  const navigate = useNavigate();
  return (
    <div>
      <header className="app-header">
        <h1>燃气观测一致性与处置工具</h1>
        <span className="offline-pill">● 离线模式 · IndexedDB · WebWorker</span>
        <span className="spacer" />
        <span className="user-box">
          {user?.name}（{ROLE_LABEL[user!.role]}）
        </span>
        <button
          onClick={() => {
            logout();
            navigate('/');
          }}
        >
          退出
        </button>
      </header>
      <div className="layout">
        <nav className="sidebar">
          {NAV_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="group-title">{g.title}</div>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
          <div className="group-title">Worker 状态</div>
          <div style={{ padding: '6px 22px', fontSize: 12, color: workerBusy ? '#8fc7f5' : '#8fa6bb' }}>
            {workerBusy ? '运行中：' : ''}{workerMessage}
          </div>
        </nav>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
