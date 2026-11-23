import { useState } from 'react';
import { useAuth, ROLE_LABEL } from '../../state/auth';

const ACCOUNTS = [
  { name: '王监管', role: 'supervisor' as const, password: 'supervisor123' },
  { name: '张巡检', role: 'inspector' as const, password: 'inspector123' },
  { name: '陈审计', role: 'auditor' as const, password: 'auditor123' },
];

export default function LoginPage() {
  const { login } = useAuth();
  const [name, setName] = useState('王监管');
  const [password, setPassword] = useState('supervisor123');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const err = login(name, password);
    setError(err);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>燃气观测一致性与处置工具</h1>
        <p className="muted small" style={{ marginTop: 4 }}>
          离线运行 · 数据仅存本地 IndexedDB · 全程签名留痕
        </p>
        <div style={{ margin: '16px 0 6px' }} className="small muted">
          测试账号（点击可自动填充）：
        </div>
        {ACCOUNTS.map((a) => (
          <div
            key={a.name}
            className="login-account"
            onClick={() => {
              setName(a.name);
              setPassword(a.password);
              setError(null);
            }}
          >
            <strong>{a.name}</strong> · {ROLE_LABEL[a.role]} · 密码 <span className="mono">{a.password}</span>
          </div>
        ))}
        <label className="small">账号</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label className="small">密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="error-text">{error}</div>}
        <button className="primary" style={{ width: '100%' }} onClick={submit}>
          登录
        </button>
      </div>
    </div>
  );
}
