import { useEffect, useState } from 'react';
import { repository } from '../../core/repository';
import type { RuleVersion } from '../../core/types';
import { SeverityBadge } from '../components';

export default function RulesPage() {
  const [versions, setVersions] = useState<RuleVersion[]>([]);
  useEffect(() => {
    repository.ruleVersions().then(setVersions);
  }, []);

  return (
    <div>
      <div className="card">
        <h2>③ 规则浏览器：版本、发布时间、变更说明与激活状态</h2>
        <p className="muted small">
          每条告警与聚合事件都固化 <span className="mono">ruleVersionId</span> 与{' '}
          <span className="mono">ledgerVersion</span>，规则更新不重写历史事件，仅通过重算链生成新版本事件。
        </p>
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>发布时间</th>
              <th>状态</th>
              <th>变更说明</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="mono">
                  <strong>{v.id}</strong>
                </td>
                <td>{v.publishedAt.slice(11, 16)}</td>
                <td>
                  <span className={`badge ${v.active ? 'ok' : 'neutral'}`}>
                    {v.active ? '初始激活' : '换版生效'}
                  </span>
                </td>
                <td className="small">{v.changelog}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {versions.map((v) => (
        <div className="card" key={v.id}>
          <h2>
            规则集 <span className="mono">{v.id}</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>规则</th>
                <th>类型</th>
                <th>参数</th>
                <th>基础严重度</th>
                <th>施工宽限</th>
                <th>启用</th>
              </tr>
            </thead>
            <tbody>
              {v.rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="mono">{r.id}</span>
                    <div className="small muted">{r.name}</div>
                  </td>
                  <td>{r.kind}</td>
                  <td className="small mono">{JSON.stringify(r.params)}</td>
                  <td>
                    <SeverityBadge value={r.baseSeverity} />
                  </td>
                  <td>{r.constructionGrace ? '是' : '否'}</td>
                  <td>{r.enabled ? '是' : '否'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
