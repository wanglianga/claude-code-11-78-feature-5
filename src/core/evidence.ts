// ============================================================
// 证据图：连接观测、台账、施工、回执、告警与聚合事件。
// 任一聚合事件都能沿边回溯到原始签名记录，满足“证据链”要求。
// ============================================================

import type {
  Alert,
  CompressionEvent,
  ConstructionZone,
  DeviceLedger,
  EvidenceEdge,
  EvidenceNode,
  RawRecord,
  Rectification,
} from './types';

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

export function buildEvidenceGraph(input: {
  raw: RawRecord[];
  ledger: DeviceLedger[];
  zones: ConstructionZone[];
  rectifications: Rectification[];
  alerts: Alert[];
  events: CompressionEvent[];
  membershipAlertIds: Set<string>; // 实际属于事件的告警（两路线并集）
}): EvidenceGraph {
  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (n: EvidenceNode) => {
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      nodes.push(n);
    }
  };
  const addEdge = (from: string, to: string, relation: EvidenceEdge['relation']) => {
    const id = `${from}->${relation}->${to}`;
    if (!edgeIds.has(id)) {
      edgeIds.add(id);
      edges.push({ id, from, to, relation });
    }
  };

  const rawBySignature = new Map(input.raw.map((r) => [r.signature, r]));

  for (const d of input.ledger) {
    addNode({ id: `ledger:${d.deviceId}`, type: 'ledger', label: d.deviceId, sub: d.name });
  }
  for (const z of input.zones) {
    addNode({ id: `zone:${z.id}`, type: 'construction', label: z.id, sub: z.name });
    for (const dev of z.affectedDevices) addEdge(`zone:${z.id}`, `ledger:${dev}`, 'in_zone');
  }
  for (const rc of input.rectifications) {
    addNode({
      id: `rc:${rc.id}`,
      type: 'rectification',
      label: rc.id,
      sub: `${rc.status} / 截止 ${rc.dueAt.slice(11, 16)}`,
    });
    addEdge(`rc:${rc.id}`, `ledger:${rc.deviceId}`, 'about_device');
  }

  for (const a of input.alerts) {
    addNode({
      id: `alert:${a.id}`,
      type: 'alert',
      label: `${a.ruleId}`,
      sub: `${a.deviceId} @ ${a.observedAt.slice(11, 16)} · ${a.severity}`,
    });
    addEdge(`alert:${a.id}`, `ledger:${a.deviceId}`, 'about_device');
    if (a.context.constructionId) {
      addEdge(`alert:${a.id}`, `zone:${a.context.constructionId}`, 'in_zone');
    }
    for (const sig of a.evidenceRefs) {
      const rawRec = rawBySignature.get(sig);
      if (!rawRec) continue;
      const oid = `raw:${rawRec.id}`;
      addNode({
        id: oid,
        type: 'observation',
        label: rawRec.sourceId,
        sub: `${rawRec.kind} · 采样 ${rawRec.sampledAt.slice(11, 16)}`,
      });
      addEdge(`alert:${a.id}`, oid, 'derived_from');
      addEdge(oid, `ledger:${a.deviceId}`, 'about_device');
    }
    // 回执关联：有上游 ID 直接关联，缺失时按设备+时间窗做证据关联
    const linked = input.rectifications.find(
      (rc) =>
        (rc.alertSourceId &&
          rawBySignature.get(a.evidenceRefs[0])?.sourceId?.includes(rc.alertSourceId)) ||
        (rc.deviceId === a.deviceId &&
          new Date(rc.dueAt).getTime() >= new Date(a.windowStart).getTime() - 3600_000 &&
          new Date(rc.dueAt).getTime() <= new Date(a.windowEnd).getTime() + 3600_000),
    );
    if (linked) addEdge(`alert:${a.id}`, `rc:${linked.id}`, 'responded_by');
    if (a.kind === 'contradiction') addEdge(`alert:${a.id}`, `ledger:${a.deviceId}`, 'contradicts');
  }

  for (const ev of input.events) {
    addNode({
      id: `event:${ev.id}`,
      type: 'event',
      label: ev.route === 'A' ? '事件 A' : '事件 B',
      sub: `${ev.title} · ${ev.severity}`,
    });
    const memberIds =
      ev.route === 'A'
        ? (ev.memberships ?? []).map((m) => m.alertId)
        : (ev.witness?.alertRefs ?? []);
    for (const alertId of memberIds) {
      addEdge(`event:${ev.id}`, `alert:${alertId}`, 'member_of');
    }
    if (ev.parentEventId) addEdge(`event:${ev.id}`, `event:${ev.parentEventId}`, 'derived_from');
  }

  return { nodes, edges };
}

/** 从事件出发的可达证据子图（调查页使用） */
export function subgraphFrom(graph: EvidenceGraph, startNodeId: string): EvidenceGraph {
  const keep = new Set<string>([startNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of graph.edges) {
      if (keep.has(e.from) && !keep.has(e.to)) {
        keep.add(e.to);
        changed = true;
      }
    }
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}
