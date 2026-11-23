import { useApp } from '../../state/app';
import { fmtBytes, short } from '../components';
import type { SyncConflict } from '../../core/types';

const RES_LABEL: Record<SyncConflict['resolution'], string> = {
  pending: '待处理',
  keep_local: '保留本地',
  take_remote: '采用远端',
  merge: '合并双方',
};

export default function SyncPage() {
  const { report, conflicts, resolveConflict } = useApp();

  if (!report) {
    return <div className="card">尚未生成同步报告，请先运行双路线核验。</div>;
  }

  const eqAll = report.equivalence.every(
    (e) => e.sameMembers && e.sameSeverity && e.sameContributions && !e.missingBoundary,
  );
  const saving =
    report.routeStats.A.payloadBytes - report.routeStats.B.payloadBytes;
  const savingPct =
    report.routeStats.A.payloadBytes > 0
      ? ((saving / report.routeStats.A.payloadBytes) * 100).toFixed(1)
      : '0';

  return (
    <div>
      <div className="card">
        <h2>⑧ 同步对照器：双路线存储差异、等价性与离线冲突</h2>
        <p className="muted small">
          本地 rev={report.localRev}，远端 rev={report.remoteRev}；远端快照为确定性模拟（监管端在离线窗口内的写入）。
        </p>
        <div className={`banner ${eqAll ? 'ok' : 'bad'}`}>
          {eqAll
            ? `两路线 ${report.equivalence.length} 个同键事件的成员集合、严重度、逐成员贡献全部一致，且 B 路线见证边界校验全部通过。`
            : '存在不一致事件，请检查等价性明细表。'}
        </div>

        <div className="route-compare">
          <div className="route-box">
            <h4>
              <span className="badge route-A">路线 A</span> 规范化成员—事件关系
            </h4>
            <ul className="tight small">
              <li>载荷体积：<strong>{fmtBytes(report.routeStats.A.payloadBytes)}</strong></li>
              <li>不可变成员关系：{report.routeStats.A.membershipCount} 条</li>
              <li>本地索引条目：{report.routeStats.A.indexCount}</li>
              <li>特点：解释直接、可局部重算；索引与同步量较大</li>
            </ul>
          </div>
          <div className="route-box">
            <h4>
              <span className="badge route-B">路线 B</span> 压缩成员见证
            </h4>
            <ul className="tight small">
              <li>
                载荷体积：<strong>{fmtBytes(report.routeStats.B.payloadBytes)}</strong>
                （较 A {saving >= 0 ? `减少 ${fmtBytes(saving)}（${savingPct}%）` : `增加 ${fmtBytes(-saving)}（${-Number(savingPct)}%）`}）
              </li>
              <li>见证数量：{report.routeStats.B.witnessCount}；字典条目：{report.routeStats.B.indexCount - report.routeStats.B.witnessCount}</li>
              <li>本地索引条目：{report.routeStats.B.indexCount}</li>
              <li>特点：离线存储小；调查页需解码等待并验证边界成员</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>A/B 等价性明细（每个聚合事件都可从两条路线还原相同来源）</h2>
        <table>
          <thead>
            <tr>
              <th>事件键（设备|规则|版本|窗）</th>
              <th>成员 A/B</th>
              <th>成员集合</th>
              <th>严重度</th>
              <th>逐成员贡献</th>
              <th>B 解码耗时</th>
              <th>边界校验</th>
            </tr>
          </thead>
          <tbody>
            {report.equivalence.map((e) => (
              <tr key={e.eventKey}>
                <td className="mono small">{e.eventKey}</td>
                <td>
                  {e.memberCountA} / {e.memberCountB}
                </td>
                <td>{e.sameMembers ? <span className="diff-add">一致</span> : <span className="diff-del">不一致</span>}</td>
                <td>{e.sameSeverity ? <span className="diff-add">一致</span> : <span className="diff-del">不一致</span>}</td>
                <td>{e.sameContributions ? <span className="diff-add">一致</span> : <span className="diff-del">不一致</span>}</td>
                <td className="mono">{e.decodeMsB} ms</td>
                <td>{e.missingBoundary ? <span className="diff-del">遗漏边界</span> : <span className="diff-add">通过</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>离线补传冲突（{conflicts.length} 项，保留双方原值，不静默覆盖）</h2>
        {conflicts.length === 0 && <div className="banner ok">无冲突。</div>}
        {conflicts.map((c) => (
          <div key={c.id} className="route-box" style={{ marginBottom: 12 }}>
            <div className="small" style={{ marginBottom: 6 }}>
              <span className="tag">{c.entityType}</span>
              <span className="mono">{short(c.entityId, 18)}</span>
              <span className={`badge ${c.resolution === 'pending' ? 'bad' : 'ok'}`} style={{ marginLeft: 8 }}>
                {RES_LABEL[c.resolution]}
              </span>
            </div>
            <div className="grid-2">
              <div className="small">
                <div className="muted">本地（离线写入）</div>
                {c.local}
              </div>
              <div className="small">
                <div className="muted">远端（监管端 rev={report.remoteRev}）</div>
                {c.remote}
              </div>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              {(['keep_local', 'take_remote', 'merge'] as const).map((r) => (
                <button
                  key={r}
                  className="ghost tiny"
                  disabled={c.resolution === r}
                  onClick={() => resolveConflict(c.id, r)}
                >
                  {RES_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
