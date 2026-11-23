import { useEffect, useMemo, useState } from 'react';
import { repository } from '../../core/repository';
import { buildEvidenceGraph, subgraphFrom } from '../../core/evidence';
import type {
  Alert,
  CompressionEvent,
  ConstructionZone,
  DeviceLedger,
  EvidenceEdge,
  EvidenceNode,
  RawRecord,
  Rectification,
} from '../../core/types';

const TYPE_COLOR: Record<EvidenceNode['type'], string> = {
  observation: '#175cd3',
  ledger: '#14466e',
  construction: '#b25e09',
  rectification: '#1a7f4b',
  alert: '#b42318',
  event: '#5b3db8',
};
const TYPE_LABEL: Record<EvidenceNode['type'], string> = {
  observation: '观测',
  ledger: '台账',
  construction: '施工',
  rectification: '回执',
  alert: '告警',
  event: '事件',
};
const LEVEL: Record<EvidenceNode['type'], number> = {
  event: 0,
  alert: 1,
  observation: 2,
  ledger: 2,
  construction: 2,
  rectification: 2,
};

// 确定性分层布局（不引入第三方图库）
function layout(nodes: EvidenceNode[]) {
  const groups = new Map<number, EvidenceNode[]>();
  for (const n of nodes) {
    const l = LEVEL[n.type];
    groups.set(l, [...(groups.get(l) ?? []), n]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const colX = [110, 410, 770, 1040];
  for (const [l, ns] of [...groups].sort((a, b) => a[0] - b[0])) {
    const step = Math.min(96, 540 / Math.max(1, ns.length));
    ns.forEach((n, i) => {
      pos.set(n.id, { x: colX[l] ?? 1040, y: 54 + i * (step + 24) + (l % 2) * 18 });
    });
  }
  return pos;
}

export default function EvidencePage() {
  const [data, setData] = useState<{
    nodes: EvidenceNode[];
    edges: EvidenceEdge[];
    events: CompressionEvent[];
  } | null>(null);
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    Promise.all([
      repository.raw(),
      repository.ledger(),
      repository.zones(),
      repository.rectifications(),
      repository.alerts(),
      repository.events(),
    ]).then(([raw, ledger, zones, rectifications, alerts, events]) => {
      const graph = buildEvidenceGraph({
        raw: raw as RawRecord[],
        ledger: ledger as DeviceLedger[],
        zones: zones as ConstructionZone[],
        rectifications: rectifications as Rectification[],
        alerts: alerts as Alert[],
        events: events as CompressionEvent[],
        membershipAlertIds: new Set((alerts as Alert[]).map((a) => a.id)),
      });
      setData({ ...graph, events: events as CompressionEvent[] });
    });
  }, []);

  const graph = useMemo(() => {
    if (!data) return null;
    if (!selected) return { nodes: data.nodes, edges: data.edges };
    return subgraphFrom({ nodes: data.nodes, edges: data.edges }, selected);
  }, [data, selected]);

  if (!data) return <div className="card">加载证据图中…（如未核验，请先运行核验）</div>;

  const pos = layout(graph!.nodes);

  return (
    <div>
      <div className="card">
        <h2>⑥ 证据图：观测 → 告警 → 事件 → 回执的完整证据链</h2>
        <p className="muted small">
          节点均由 IndexedDB 中的签名记录派生；选择一个聚合事件可查看其可达证据子图，
          <span className="mono">responded_by</span> 边同时覆盖“上游告警 ID 缺失、按设备+时间窗关联”的回执。
        </p>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">全图（{data.nodes.length} 节点 / {data.edges.length} 边）</option>
          {data.events.map((e) => (
            <option key={`${e.route}-${e.id}`} value={`event:${e.id}`}>
              [{e.route}] {e.deviceId} {e.ruleId} {e.windowStart.slice(11, 16)} 窗
            </option>
          ))}
        </select>
        <div className="legend">
          {Object.entries(TYPE_COLOR).map(([k, c]) => (
            <span key={k}>
              <span style={{ background: c, display: 'inline-block', width: 11, height: 11, borderRadius: 3, marginRight: 5 }} />
              {TYPE_LABEL[k as EvidenceNode['type']]}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <svg className="ev-graph" viewBox="0 0 1180 620">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#8aa0b5" />
            </marker>
          </defs>
          {graph!.edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2 - 6;
            return (
              <g key={e.id} className="ev-edge">
                <path
                  d={`M${a.x + 92},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x - 8},${b.y}`}
                  markerEnd="url(#arrow)"
                />
                <text x={mx} y={my} textAnchor="middle">
                  {e.relation}
                </text>
              </g>
            );
          })}
          {graph!.nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <g key={n.id} className="ev-node" transform={`translate(${p.x - 95},${p.y - 22})`}>
                <rect width={190} height={44} rx={8} fill="#fff" stroke={TYPE_COLOR[n.type]} />
                <circle cx={12} cy={14} r={6} fill={TYPE_COLOR[n.type]} />
                <text x={26} y={17} fontWeight={600}>
                  {n.label.length > 22 ? `${n.label.slice(0, 22)}…` : n.label}
                </text>
                <text x={26} y={33} fill="#667085">
                  {TYPE_LABEL[n.type]} · {n.sub.length > 26 ? `${n.sub.slice(0, 26)}…` : n.sub}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
