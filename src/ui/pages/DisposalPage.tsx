import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../state/app';
import { KIND_LABEL } from '../../core/engine';
import type { DisposalAction } from '../../core/types';
import { StateBadge, hm, short } from '../components';

const ACTION_LABEL: Record<DisposalAction['action'], string> = {
  ack: '签收',
  assign: '派单',
  close: '关闭',
  annotate: '批注',
  reopen: '重新打开',
};

export default function DisposalPage() {
  const { actions, eventsA, alerts } = useApp();
  const [onlyLocal, setOnlyLocal] = useState(false);

  const kindByRule = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of alerts) map.set(a.ruleId, KIND_LABEL[a.kind]);
    return map;
  }, [alerts]);

  const eventOf = useMemo(() => new Map(eventsA.map((e) => [e.id, e])), [eventsA]);

  const rows = onlyLocal ? actions.filter((a) => a.syncState !== 'synced') : actions;

  return (
    <div>
      <div className="card">
        <h2>⑦ 处置簿：离线行动全量保留</h2>
        <p className="muted small">
          每条行动记录 <span className="mono">baseVersion</span> 乐观锁版本与同步状态；
          离线期间的批注/重开不会覆盖或删除任何历史行动，联网后进入同步对照器处理冲突。
        </p>
        <label className="small">
          <input type="checkbox" checked={onlyLocal} onChange={(e) => setOnlyLocal(e.target.checked)} />{' '}
          只看本地未同步 / 冲突行动
        </label>
      </div>

      <div className="card">
        {rows.length === 0 && (
          <div className="banner warn">暂无处置行动（核验后会自动播种离线巡检行动，也可在事件调查页提交）。</div>
        )}
        <table>
          <thead>
            <tr>
              <th>行动 ID</th>
              <th>事件</th>
              <th>设备</th>
              <th>操作人 / 角色</th>
              <th>动作</th>
              <th>时间</th>
              <th>版本</th>
              <th>同步状态</th>
              <th>意见</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const ev = eventOf.get(a.eventId);
              return (
                <tr key={a.id}>
                  <td className="mono small">{a.id}</td>
                  <td className="small">
                    {ev ? (
                      <Link to={`/events/A/${ev.id}`}>
                        {ev.deviceId} {kindByRule.get(ev.ruleId) ?? ev.ruleId}（
                        {short(ev.id, 8)}）
                      </Link>
                    ) : (
                      short(a.eventId, 10)
                    )}
                  </td>
                  <td className="mono">{a.deviceId}</td>
                  <td className="small">
                    {a.actor}
                    <br />
                    <span className="muted">{a.role}</span>
                  </td>
                  <td><span className="tag">{ACTION_LABEL[a.action]}</span></td>
                  <td>{hm(a.at)}</td>
                  <td className="mono">v{a.baseVersion}</td>
                  <td><StateBadge value={a.syncState} /></td>
                  <td className="small">{a.comment}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
