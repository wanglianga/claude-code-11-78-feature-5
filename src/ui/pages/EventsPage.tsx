import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../state/app';
import { KIND_LABEL } from '../../core/engine';
import type { CompressionRoute } from '../../core/types';
import { SeverityBadge, hm, short } from '../components';

export default function EventsPage() {
  const { eventsA, eventsB, alerts } = useApp();
  const [route, setRoute] = useState<CompressionRoute | 'both'>('both');

  const alertCountByEvent = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of [...eventsA, ...eventsB]) {
      map.set(e.id, e.route === 'A' ? (e.memberships?.length ?? 0) : (e.witness?.alertRefs.length ?? 0));
    }
    return map;
  }, [eventsA, eventsB]);

  const rows = [
    ...(route !== 'B' ? eventsA : []),
    ...(route !== 'A' ? eventsB : []),
  ];

  return (
    <div>
      <div className="card">
        <h2>⑤ 压缩事件：双路线同源对照</h2>
        <p className="muted small">
          路线 A 保存规范化的不可变成员—事件关系及逐成员贡献；路线 B 保存按设备/连续时间窗/规则版本编码的压缩成员见证，
          加内容寻址原始告警引用，调查时确定性解码。两路线对同一事件还原相同成员与贡献。
        </p>
        <div className="tabs">
          {(['both', 'A', 'B'] as const).map((r) => (
            <button key={r} className={route === r ? 'active' : ''} onClick={() => setRoute(r)}>
              {r === 'both' ? '两路线并列' : `仅路线 ${r}`}
            </button>
          ))}
        </div>
        {alerts.length === 0 && (
          <div className="banner warn">尚未核验，请先到「时序核验器」运行双路线核验。</div>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>路线</th>
              <th>事件 ID</th>
              <th>设备 / 规则</th>
              <th>类型</th>
              <th>时间窗</th>
              <th>成员数</th>
              <th>聚合严重度</th>
              <th>规则 / 台账版本</th>
              <th>重算父事件</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={`${e.route}-${e.id}`}>
                <td><span className={`badge route-${e.route}`}>路线 {e.route}</span></td>
                <td className="mono small">{short(e.id, 12)}</td>
                <td className="small">
                  <strong>{e.deviceId}</strong>
                  <br />
                  <span className="mono">{e.ruleId}</span>
                </td>
                <td>{KIND_LABEL[alerts.find((a) => a.ruleId === e.ruleId)?.kind ?? 'missing']}</td>
                <td className="small">
                  {hm(e.windowStart)}–{hm(e.windowEnd)}
                </td>
                <td>{alertCountByEvent.get(e.id) ?? e.memberCount}</td>
                <td><SeverityBadge value={e.severity} /></td>
                <td className="small mono">
                  {e.ruleVersionId}
                  <br />
                  {e.ledgerVersion}
                </td>
                <td className="mono small">{e.parentEventId ? short(e.parentEventId, 10) : '—'}</td>
                <td>
                  <Link to={`/events/${e.route}/${e.id}`}>
                    <button className="ghost tiny">调查 / 还原成员</button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
