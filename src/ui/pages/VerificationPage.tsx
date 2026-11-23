import { useMemo, useState } from 'react';
import { useApp } from '../../state/app';
import { KIND_LABEL } from '../../core/engine';
import type { Alert, RuleKind, Severity } from '../../core/types';
import { SeverityBadge, hm, short } from '../components';

export default function VerificationPage() {
  const { alerts, loaded, runVerify, workerBusy, lastElapsedMs, lastDecodeMs, report } = useApp();
  const [kind, setKind] = useState<RuleKind | 'ALL'>('ALL');
  const [version, setVersion] = useState('ALL');

  const filtered = useMemo(
    () =>
      alerts.filter(
        (a) =>
          (kind === 'ALL' || a.kind === kind) &&
          (version === 'ALL' || a.ruleVersionId === version),
      ),
    [alerts, kind, version],
  );

  const counts = useMemo(() => {
    const byKind: Record<string, number> = {};
    const bySeverity: Record<Severity, number> = { info: 0, minor: 0, major: 0, critical: 0 };
    for (const a of alerts) {
      byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
      bySeverity[a.severity] += 1;
    }
    return { byKind, bySeverity };
  }, [alerts]);

  return (
    <div>
      <div className="card">
        <h2>④ 时序核验器（WebWorker 后台计算）</h2>
        <p className="muted small">
          缺测、跳变、状态矛盾、处置逾期四类冲突按规则版本分别核验；施工扰动按清单抑制项处理，
          网络漂移仅作上下文，<strong>不会批量关闭相似告警</strong>——每条告警保留独立签名证据与贡献。
        </p>
        <button className="primary" disabled={!loaded || workerBusy} onClick={runVerify}>
          {workerBusy ? 'Worker 运行中…' : '运行双路线核验与压缩'}
        </button>
        {lastElapsedMs > 0 && (
          <span className="small muted" style={{ marginLeft: 12 }}>
            上次管线耗时 {lastElapsedMs} ms；B 路线见证解码合计 {lastDecodeMs} ms
          </span>
        )}
        {alerts.length > 0 && (
          <div className="kpi-grid" style={{ marginTop: 14 }}>
            {(['missing', 'jump', 'contradiction', 'overdue'] as RuleKind[]).map((k) => (
              <div className="kpi" key={k}>
                <div className="num">{counts.byKind[k] ?? 0}</div>
                <div className="label">{KIND_LABEL[k]}告警</div>
              </div>
            ))}
            {(['critical', 'major', 'minor', 'info'] as Severity[]).map((s) => (
              <div className="kpi" key={s}>
                <div className="num">{counts.bySeverity[s]}</div>
                <div className="label">{s}</div>
              </div>
            ))}
          </div>
        )}
        {report && (
          <div className="small muted" style={{ marginTop: 8 }}>
            最新同步报告：<span className="mono">{report.id}</span>，A/B 等价事件{' '}
            {report.equivalence.filter((e) => e.sameMembers && e.sameSeverity && e.sameContributions).length}/
            {report.equivalence.length} 全部一致
          </div>
        )}
      </div>

      {alerts.length > 0 && (
        <div className="card">
          <h2>告警明细（{filtered.length} / {alerts.length}，内容寻址 ID 不可变）</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <select value={kind} onChange={(e) => setKind(e.target.value as RuleKind | 'ALL')}>
              <option value="ALL">全部类型</option>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <select value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="ALL">全部规则版本</option>
              <option value="RV-2026.1">RV-2026.1（换版前）</option>
              <option value="RV-2026.2">RV-2026.2（换版后）</option>
            </select>
          </div>
          <table>
            <thead>
              <tr>
                <th>告警 ID</th>
                <th>类型</th>
                <th>设备</th>
                <th>严重度</th>
                <th>观测时间</th>
                <th>规则 / 台账版本</th>
                <th>上下文</th>
                <th>贡献分</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a: Alert) => (
                <tr key={a.id}>
                  <td className="mono small">{short(a.id, 12)}</td>
                  <td>{KIND_LABEL[a.kind]}</td>
                  <td className="mono">{a.deviceId}</td>
                  <td><SeverityBadge value={a.severity} /></td>
                  <td>{hm(a.observedAt)}</td>
                  <td className="small mono">
                    {a.ruleVersionId}
                    <br />
                    {a.ledgerVersion}
                  </td>
                  <td className="small">
                    {a.context.inConstruction && <span className="tag">施工</span>}
                    {a.context.networkDrift && <span className="tag">漂移</span>}
                    {a.context.backfilled && <span className="tag">补传</span>}
                  </td>
                  <td>{a.contribution.severityScore}</td>
                  <td className="small">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
