import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp, useDict } from '../../state/app';
import { decodeWitness, verifyBoundary, type DecodedMember } from '../../core/compression';
import { KIND_LABEL } from '../../core/engine';
import type { Alert, MembershipRecord } from '../../core/types';
import { SeverityBadge, StateBadge, hm, short } from '../components';

interface Row {
  alert: Alert;
  score: number;
  rationale: string;
  recommendation: string;
}

export default function EventDetailPage() {
  const { route, id } = useParams<{ route: 'A' | 'B'; id: string }>();
  const { eventsA, eventsB, alerts, memberships, actions, addDisposal } = useApp();
  const dict = useDict(useApp().dictValues);
  const [comment, setComment] = useState('');
  const [actionKind, setActionKind] = useState<'ack' | 'annotate' | 'close' | 'reopen'>('annotate');

  const event = (route === 'A' ? eventsA : eventsB).find((e) => e.id === id);
  const alertsById = useMemo(() => new Map(alerts.map((a) => [a.id, a])), [alerts]);

  const { rows, decodeMs } = useMemo<{
    rows: Row[];
    decodedRaw: DecodedMember[] | null;
    decodeMs: number | null;
  }>(() => {
    if (!event) return { rows: [], decodedRaw: null, decodeMs: null };
    if (event.route === 'A') {
      const ms: MembershipRecord[] = memberships.filter((m) => m.eventId === event.id);
      return {
        rows: ms
          .map((m) => {
            const alert = alertsById.get(m.alertId);
            if (!alert) return null;
            return {
              alert,
              score: m.severityContribution,
              rationale: alert.contribution.rationale,
              recommendation: m.recommendationContribution,
            } as Row;
          })
          .filter((x): x is Row => !!x)
          .sort((a, b) => a.alert.observedAt.localeCompare(b.alert.observedAt)),
        decodedRaw: null,
        decodeMs: null,
      };
    }
    if (!event.witness) return { rows: [], decodedRaw: null, decodeMs: null };
    const t0 = performance.now();
    const decoded = decodeWitness(event.witness, alertsById, dict);
    const ms = +(performance.now() - t0).toFixed(3);
    return {
      decodedRaw: decoded,
      decodeMs: ms,
      rows: decoded
        .map((d) => ({
          alert: d.alert,
          score: d.severityScore,
          rationale: d.rationale,
          recommendation: d.recommendation,
        }))
        .sort((a, b) => a.alert.observedAt.localeCompare(b.alert.observedAt)),
    };
  }, [event, memberships, alertsById, dict]);

  if (!event) {
    return (
      <div className="card">
        事件不存在或尚未核验。<Link to="/events">返回事件列表</Link>
      </div>
    );
  }

  const counterpart = (route === 'A' ? eventsB : eventsA).find(
    (e) =>
      e.deviceId === event.deviceId &&
      e.ruleId === event.ruleId &&
      e.ruleVersionId === event.ruleVersionId &&
      e.windowStart === event.windowStart &&
      e.windowEnd === event.windowEnd,
  );
  const eventActions = actions.filter((a) => a.eventId === event.id);
  const boundary = event.route === 'B' ? event.witness?.boundary : null;
  const recheck = event.route === 'B' && event.witness
    ? verifyBoundary(event.witness, alerts, new Date().toISOString())
    : null;

  return (
    <div>
      <div className="card">
        <Link to="/events">← 返回事件列表</Link>
        <h2 style={{ marginTop: 10 }}>
          事件调查 <span className={`badge route-${event.route}`}>路线 {event.route}</span>{' '}
          <span className="mono small">{short(event.id, 20)}</span>
        </h2>
        <div className="grid-3">
          <div>
            <div className="small muted">设备 / 规则</div>
            <strong>{event.deviceId}</strong> / <span className="mono">{event.ruleId}</span>（
            {KIND_LABEL[rows[0]?.alert.kind ?? 'missing']}）
          </div>
          <div>
            <div className="small muted">时间窗 / 严重度</div>
            {hm(event.windowStart)}–{hm(event.windowEnd)} <SeverityBadge value={event.severity} />
          </div>
          <div>
            <div className="small muted">生成时版本戳记</div>
            <span className="mono small">
              {event.ruleVersionId} + {event.ledgerVersion}
            </span>
          </div>
        </div>
        {event.parentEventId && (
          <div className="small" style={{ marginTop: 8 }}>
            重算链父事件：<span className="mono">{short(event.parentEventId, 16)}</span>
            （规则换版后局部重算生成，旧事件未被改写）
          </div>
        )}
        {counterpart && (
          <div className="small" style={{ marginTop: 8 }}>
            对侧路线{route === 'A' ? ' B' : ' A'}同键事件：
            <Link to={`/events/${route === 'A' ? 'B' : 'A'}/${counterpart.id}`}>
              <span className="mono">{short(counterpart.id, 16)}</span>
            </Link>
            ，成员数 {counterpart.memberCount}，可交叉核对还原结果。
          </div>
        )}
      </div>

      {event.route === 'B' && event.witness && (
        <div className="card">
          <h2>路线 B 见证编码与解码过程</h2>
          <ul className="tight small">
            <li>
              见证哈希 <span className="mono">{short(event.witness.witnessHash, 24)}</span>，槽位粒度{' '}
              {event.witness.windowSlotMinutes} 分钟，槽位序列{' '}
              <span className="mono">[{event.witness.memberSlots.join(', ')}]</span>
            </li>
            <li>
              内容寻址告警引用 {event.witness.alertRefs.length} 个；贡献说明字典码{' '}
              <span className="mono">[{event.witness.rationaleCodes.join(', ')}]</span>
            </li>
            <li>
              本次调查页确定性解码耗时：
              <strong>{decodeMs ?? '—'} ms</strong>（路线 A 直接读关系，无需解码等待）
            </li>
            <li>
              边界校验（生成时）：
              <span className={boundary?.passed ? 'diff-add' : 'diff-del'}>
                {boundary?.passed ? '通过' : '未通过'}
              </span>
              ，{boundary?.note}
              {boundary?.prevSlotAlertId && `；前槽告警 ${short(boundary.prevSlotAlertId, 8)}`}
              {boundary?.nextSlotAlertId && `；后槽告警 ${short(boundary.nextSlotAlertId, 8)}`}
            </li>
            <li>
              现场重新边界校验：
              <span className={recheck?.passed ? 'diff-add' : 'diff-del'}>
                {recheck?.passed ? '通过' : '失败'}
              </span>
              （{recheck?.note}）
            </li>
          </ul>
        </div>
      )}

      <div className="card">
        <h2>
          成员告警（{rows.length} 条）——每条成员的严重度贡献与处置建议贡献均可独立列出
        </h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>成员告警 ID</th>
              <th>时间</th>
              <th>严重度</th>
              <th>贡献分</th>
              <th>严重度贡献说明</th>
              <th>处置建议贡献</th>
              <th>证据签名</th>
              <th>版本</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.alert.id}>
                <td>{i + 1}</td>
                <td className="mono small">{short(r.alert.id, 12)}</td>
                <td>{hm(r.alert.observedAt)}</td>
                <td><SeverityBadge value={r.alert.severity} /></td>
                <td>
                  <strong>{r.score}</strong>
                </td>
                <td className="small">{r.rationale}</td>
                <td className="small">{r.recommendation}</td>
                <td className="mono small">
                  {r.alert.evidenceRefs.map((s) => short(s, 8)).join('、')}
                </td>
                <td className="mono small">
                  {r.alert.ruleVersionId}
                  <br />
                  {r.alert.ledgerVersion}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>处置行动（保留全部历史，不做批量关闭）</h2>
        {eventActions.length === 0 && <p className="muted small">暂无行动。</p>}
        <div className="timeline">
          {eventActions.map((a) => (
            <div className="item" key={a.id}>
              <div className="small">
                <strong>{a.actor}</strong>（{a.role}）于 {hm(a.at)} 执行 <span className="tag">{a.action}</span>{' '}
                <StateBadge value={a.syncState} /> <span className="mono muted">v{a.baseVersion}</span>
              </div>
              <div className="small">{a.comment}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select value={actionKind} onChange={(e) => setActionKind(e.target.value as typeof actionKind)}>
            <option value="annotate">批注 annotate</option>
            <option value="ack">签收 ack</option>
            <option value="close">关闭 close</option>
            <option value="reopen">重新打开 reopen</option>
          </select>
          <input
            style={{ flex: 1, minWidth: 260, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7 }}
            placeholder="填写处置意见…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button
            className="primary"
            disabled={!comment.trim()}
            onClick={async () => {
              await addDisposal(event.id, event.deviceId, actionKind, comment.trim());
              setComment('');
            }}
          >
            提交本地行动
          </button>
        </div>
      </div>
    </div>
  );
}
