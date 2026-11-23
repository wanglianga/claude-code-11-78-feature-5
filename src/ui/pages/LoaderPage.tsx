import { useEffect, useState } from 'react';
import { useApp } from '../../state/app';
import { repository } from '../../core/repository';
import { verifySignatures } from '../../core/loader';
import type { RawRecord } from '../../core/types';
import { short } from '../components';

export default function LoaderPage() {
  const { loaded, loaderStats, signatureBad, loadScenario, runVerify, workerBusy, resetWorkspace } =
    useApp();
  const [rows, setRows] = useState<RawRecord[]>([]);
  const [recheckBad, setRecheckBad] = useState<string[] | null>(null);

  useEffect(() => {
    repository.raw().then(setRows);
  }, [loaded]);

  const kindLabel: Record<string, string> = {
    trajectory: '巡检轨迹',
    valve_reading: '阀井读数',
    ledger: '设备台账',
    construction: '施工清单',
    rectification: '整改回执',
  };

  return (
    <div>
      <div className="card">
        <h2>① 装载器：原始记录、采样/到达时间、可信度与签名</h2>
        <p className="muted small">
          装载时对每条记录的业务字段计算 SHA-256 内容签名并固化，签名随记录进入 IndexedDB，
          后续对齐、核验、压缩均只引用签名，不允许改写原始字节。
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button className="primary" onClick={loadScenario}>
            装载确定性场景（三阶段样例）
          </button>
          <button className="ghost" disabled={!loaded || workerBusy} onClick={runVerify}>
            交给 WebWorker 执行核验
          </button>
          <button
            className="danger"
            disabled={!loaded}
            onClick={async () => {
              await resetWorkspace();
              setRows([]);
              setRecheckBad(null);
            }}
          >
            清空工作区
          </button>
        </div>
        {loaderStats && (
          <div className="kpi-grid" style={{ marginTop: 16 }}>
            <div className="kpi">
              <div className="num">{loaderStats.rawCount}</div>
              <div className="label">原始记录</div>
            </div>
            <div className="kpi">
              <div className="num">{loaderStats.signedCount}</div>
              <div className="label">已固化签名</div>
            </div>
            <div className="kpi">
              <div className="num">{loaderStats.backfilledCount}</div>
              <div className="label">离线补传记录</div>
            </div>
            <div className="kpi">
              <div className="num">{signatureBad.length}</div>
              <div className="label">装载验签失败</div>
            </div>
          </div>
        )}
        <div className="small muted" style={{ marginTop: 10 }}>
          批次：{loaderStats?.batchIds.join('、') || '—'}
        </div>
      </div>

      {loaded && (
        <div className="card">
          <h2>原始记录抽样（前 12 条，全量在 IndexedDB raw_records）</h2>
          <div style={{ marginBottom: 10 }}>
            <button
              className="ghost tiny"
              onClick={async () => setRecheckBad(await verifySignatures(rows))}
            >
              重新验签全量记录
            </button>
            {recheckBad !== null && (
              <span style={{ marginLeft: 10 }} className={recheckBad.length ? 'diff-del' : 'diff-add'}>
                {recheckBad.length === 0 ? '验签全部通过' : `失败 ${recheckBad.length} 条`}
              </span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>本地 ID</th>
                <th>类型</th>
                <th>上游 ID</th>
                <th>采样时间</th>
                <th>到达时间</th>
                <th>可信度</th>
                <th>补传</th>
                <th>签名（前 12 位）</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>{kindLabel[r.kind]}</td>
                  <td className="mono small">{r.sourceId}</td>
                  <td>{r.sampledAt.slice(11, 16)}</td>
                  <td>{r.arrivedAt.slice(11, 16)}</td>
                  <td>
                    <span className={`badge ${r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'minor' : 'bad'}`}>
                      {r.confidence}
                    </span>
                  </td>
                  <td>{r.backfilled ? '是' : '—'}</td>
                  <td className="mono small">{short(r.signature, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
