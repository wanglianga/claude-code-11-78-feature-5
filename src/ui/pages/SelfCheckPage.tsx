import { useState } from 'react';
import { runPipeline } from '../../core/pipeline';
import { runSelfCheck, type CheckResult } from '../../core/selfcheck';
import { repository } from '../../core/repository';
import { useApp, NOW_ISO } from '../../state/app';

const DIMENSIONS: CheckResult['dimension'][] = [
  '漂移与施工',
  '规则换版',
  '离线补传',
  '双路线一致性',
  '证据完整性',
];

export default function SelfCheckPage() {
  const { loaded } = useApp();
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const run = async () => {
    setRunning(true);
    const t0 = performance.now();
    const [raw, ledger, zones, rectifications, ruleVersions, mappingRow] = await Promise.all([
      repository.raw(),
      repository.ledger(),
      repository.zones(),
      repository.rectifications(),
      repository.ruleVersions(),
      repository.loadMapping(),
    ]);
    const out = await runPipeline({
      raw,
      ledger,
      zones,
      rectifications,
      mapping: mappingRow!.value,
      ruleVersions,
      nowIso: NOW_ISO,
      localRev: 18,
      seedOfflineActions: true,
    });
    const checks = await runSelfCheck(out, raw.length, new Set(raw.map((r) => r.signature)));
    setElapsed(+(performance.now() - t0).toFixed(1));
    setResults(checks);
    setRunning(false);
  };

  const passed = results?.filter((r) => r.passed).length ?? 0;

  return (
    <div>
      <div className="card">
        <h2>⑨ 自检与验证：三阶段样例 × 双路线核验</h2>
        <p className="muted small">
          断言覆盖：网络漂移与施工扰动重叠、规则换版局部重算、离线补传冲突，
          以及两路线的成员集合、严重度、贡献说明、重算影响与同步差异。与 CI 中的{' '}
          <span className="mono">npm test</span>（Vitest）共用同一断言库。
        </p>
        <button className="primary" disabled={!loaded || running} onClick={run}>
          {running ? '自检运行中（主线程复算完整管线）…' : '运行全量自检'}
        </button>
        {results && (
          <span style={{ marginLeft: 12 }}>
            <strong className={passed === results.length ? 'diff-add' : 'diff-del'}>
              {passed}/{results.length}
            </strong>{' '}
            通过，耗时 {elapsed} ms
          </span>
        )}
      </div>

      {DIMENSIONS.map((dim) => {
        const rows = results?.filter((r) => r.dimension === dim) ?? [];
        return (
          <div className="card" key={dim}>
            <h2>{dim}</h2>
            {results === null && <p className="muted small">待运行。</p>}
            <table>
              <thead>
                <tr>
                  <th style={{ width: 70 }}>编号</th>
                  <th>断言</th>
                  <th style={{ width: 80 }}>结果</th>
                  <th>实测证据</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{r.name}</td>
                    <td>
                      <span className={`badge ${r.passed ? 'ok' : 'bad'}`}>
                        {r.passed ? '通过' : '失败'}
                      </span>
                    </td>
                    <td className="small">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      <div className="card">
        <h2>样例场景时间线（验证用）</h2>
        <div className="timeline">
          <div className="item small">
            <strong>08:00–12:00 阶段一</strong>：VW-001 读数迟到（09:15 延迟 25 分钟）、10:30 乱序到达；
            CZ-01 施工 09:00–11:00，11:00 回落跳变按清单抑制但保留成员；09:15→10:00 60 分钟缺测；
            PS-002 施工区外 09:30 跳变不抑制。
          </div>
          <div className="item small">
            <strong>12:00 规则换版</strong>：RV-2026.1 → RV-2026.2，缺测 30→20 分钟、跳变比 0.40→0.25 升 critical、
            矛盾容忍 10→5 升 critical、逾期宽限 60→30 分钟；v2 事件经 parentEventId 挂接 v1 事件。
          </div>
          <div className="item small">
            <strong>16:00–18:00 阶段三</strong>：FS-003 16:00 缺测与 70 分钟延迟补传；巡检端 16:40 批注、
            17:10 离线重开监管端已关闭事件；RC-001 回执状态与远端冲突。
          </div>
        </div>
      </div>
    </div>
  );
}
