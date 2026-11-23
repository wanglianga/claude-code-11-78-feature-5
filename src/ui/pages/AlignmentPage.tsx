import { useEffect, useMemo, useState } from 'react';
import { alignAll } from '../../core/aligner';
import { repository } from '../../core/repository';
import type {
  CanonicalObservation,
  ConstructionZone,
  DeviceLedger,
  RawRecord,
  SemanticMapping,
} from '../../core/types';
import { short } from '../components';

export default function AlignmentPage() {
  const [raw, setRaw] = useState<RawRecord[]>([]);
  const [ledger, setLedger] = useState<DeviceLedger[]>([]);
  const [zones, setZones] = useState<ConstructionZone[]>([]);
  const [mapping, setMapping] = useState<SemanticMapping | null>(null);
  const [deviceFilter, setDeviceFilter] = useState('ALL');

  useEffect(() => {
    Promise.all([
      repository.raw(),
      repository.ledger(),
      repository.zones(),
      repository.loadMapping(),
    ]).then(([r, l, z, m]) => {
      setRaw(r);
      setLedger(l);
      setZones(z);
      setMapping(m?.value ?? null);
    });
  }, []);

  const result = useMemo(() => {
    if (!mapping || raw.length === 0) return null;
    return alignAll(raw, ledger, mapping, zones);
  }, [raw, ledger, zones, mapping]);

  if (!mapping) {
    return <div className="card">请先在「装载器与签名」页装载场景。</div>;
  }

  const shown: CanonicalObservation[] = (result?.observations ?? []).filter(
    (o) => deviceFilter === 'ALL' || o.deviceId === deviceFilter,
  );

  return (
    <div>
      <div className="card">
        <h2>② 语义对齐器：别名 / 量程单位 / 坐标 / 施工范围</h2>
        <div className="grid-2">
          <div>
            <h3>别名映射（map-v2）</h3>
            <table>
              <thead>
                <tr><th>源系统别名</th><th>规范设备 ID</th></tr>
              </thead>
              <tbody>
                {Object.entries(mapping.aliasMap).map(([alias, id]) => (
                  <tr key={alias}>
                    <td className="mono small">{alias}</td>
                    <td className="mono">{id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3>单位与坐标换算</h3>
            <ul className="tight small">
              {Object.entries(mapping.unitConversions).map(([u, c]) => (
                <li key={u}>
                  <span className="mono">{u}</span> → 标准单位：value × {c.factor}
                  {c.offset ? ` + ${c.offset}` : ''}
                </li>
              ))}
              <li>
                坐标：{mapping.coordSystem} → WGS84，修正偏移 dLng={mapping.coordOffset.dLng}、dLat=
                {mapping.coordOffset.dLat}
              </li>
            </ul>
            <h3>施工范围（地理包围盒 + 影响设备 + 时段）</h3>
            {zones.map((z) => (
              <div key={z.id} className="small" style={{ marginBottom: 6 }}>
                <span className="tag">{z.id}</span>
                {z.name}；{z.startAt.slice(11, 16)}–{z.endAt.slice(11, 16)}；
                影响 {z.affectedDevices.join('、')}；宽限 {z.graceIntervalMin} 分钟；抑制{' '}
                {z.suppressKinds.join('、')}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>对齐后的规范观测（{result?.observations.length ?? 0} 条）</h2>
        <div className="small muted" style={{ marginBottom: 8 }}>
          对齐失败 {result?.failures.length ?? 0} 条；网络漂移判定：到达延迟 ≥10 分钟或乱序。
        </div>
        <div style={{ marginBottom: 10 }}>
          <select value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)}>
            <option value="ALL">全部设备</option>
            {ledger.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.deviceId}（{d.name}）
              </option>
            ))}
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>设备</th>
              <th>标准值</th>
              <th>源单位</th>
              <th>状态</th>
              <th>采样 / 到达</th>
              <th>可信度</th>
              <th>漂移</th>
              <th>施工</th>
              <th>补传</th>
              <th>WGS84 坐标</th>
              <th>原始签名</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 60).map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.deviceId}</td>
                <td>{o.value}</td>
                <td>{o.sourceUnit}</td>
                <td>{o.status}</td>
                <td className="small">
                  {o.sampledAt.slice(11, 16)} / {o.arrivedAt.slice(11, 16)}
                </td>
                <td>{o.confidence}</td>
                <td>{o.networkDrift ? <span className="badge bad">漂移</span> : '—'}</td>
                <td>{o.inConstruction ? <span className="badge minor">{o.constructionId}</span> : '—'}</td>
                <td>{o.backfilled ? '是' : '—'}</td>
                <td className="mono small">
                  {o.location.lng}, {o.location.lat}
                </td>
                <td className="mono small">{short(o.rawSignature, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > 60 && <p className="small muted">仅展示前 60 条，全量在本地存储。</p>}
      </div>
    </div>
  );
}
