// ============================================================
// 核验编排管线：对齐 -> 分版本核验 -> 双路线压缩 -> 重算链
// -> 见证边界校验 -> 证据图 -> 同步报告。
// 纯函数编排，浏览器主线程 / WebWorker / Vitest 三处复用。
// ============================================================

import { alignAll } from './aligner';
import {
  ContributionDict,
  buildGroups,
  compressRouteA,
  compressRouteB,
  linkRecalcChain,
  verifyBoundary,
} from './compression';
import { verify } from './engine';
import { buildEvidenceGraph, type EvidenceGraph } from './evidence';
import { buildSyncReport } from './sync';
import type {
  Alert,
  CanonicalObservation,
  CompressionEvent,
  ConstructionZone,
  DeviceLedger,
  DisposalAction,
  MembershipRecord,
  RawRecord,
  Rectification,
  RuleVersion,
  SemanticMapping,
  SyncReport,
} from './types';
import { t } from './scenario';

export interface PipelineInput {
  raw: RawRecord[];
  ledger: DeviceLedger[];
  zones: ConstructionZone[];
  rectifications: Rectification[];
  mapping: SemanticMapping;
  ruleVersions: RuleVersion[];
  nowIso: string;
  localRev: number;
  seedOfflineActions: boolean;
}

export interface PipelineOutput {
  observations: CanonicalObservation[];
  alignmentFailures: Array<{ rawId: string; reason: string }>;
  alerts: Alert[];
  eventsA: CompressionEvent[];
  eventsB: CompressionEvent[];
  memberships: MembershipRecord[];
  dict: ContributionDict;
  graph: EvidenceGraph;
  report: SyncReport;
  seededActions: DisposalAction[];
}

const PHASE2_START = t(12, 0);

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { observations, failures } = alignAll(
    input.raw,
    input.ledger,
    input.mapping,
    input.zones,
  );

  const v1 = input.ruleVersions.find((r) => r.id === 'RV-2026.1')!;
  const v2 = input.ruleVersions.find((r) => r.id === 'RV-2026.2')!;
  const phase2Ms = new Date(PHASE2_START).getTime();

  // 版本化核验：v1 只看换版前的观测与到期回执；v2 全量重算
  const alertsV1 = await verify({
    observations: observations.filter((o) => new Date(o.sampledAt).getTime() < phase2Ms),
    ledger: input.ledger,
    zones: input.zones,
    rectifications: input.rectifications.filter(
      (rc) => new Date(rc.dueAt).getTime() < phase2Ms,
    ),
    ruleVersion: v1,
    mappingVersion: input.mapping.version,
    nowIso: PHASE2_START,
  });
  const alertsV2 = await verify({
    observations,
    ledger: input.ledger,
    zones: input.zones,
    rectifications: input.rectifications,
    ruleVersion: v2,
    mappingVersion: input.mapping.version,
    nowIso: input.nowIso,
  });
  const alerts = [...alertsV1, ...alertsV2];

  // 双路线压缩（共用同一分组，保证切窗一致）
  const groups = buildGroups(alerts);
  const dict = new ContributionDict();
  const now = input.nowIso;
  const [a, b] = await Promise.all([
    compressRouteA(groups, now),
    compressRouteB(groups, dict, now),
  ]);

  // 规则换版局部重算链 + B 路线见证边界校验
  const memByEvent = new Map<string, MembershipRecord[]>();
  for (const m of a.memberships) {
    const arr = memByEvent.get(m.eventId) ?? [];
    arr.push(m);
    memByEvent.set(m.eventId, arr);
  }
  const withMemberships = (evs: CompressionEvent[]): CompressionEvent[] =>
    evs.map((e) => ({ ...e, memberships: memByEvent.get(e.id) ?? [] }));
  const eventsA = withMemberships(linkRecalcChain(a.events, []));
  const v1EventsA = eventsA.filter((e) => e.ruleVersionId === v1.id);
  const v2EventsA = withMemberships(
    linkRecalcChain(
      eventsA.filter((e) => e.ruleVersionId === v2.id),
      v1EventsA,
    ),
  );
  const eventsBv1 = b.events.filter((e) => e.ruleVersionId === v1.id).map((e) =>
    e.witness
      ? { ...e, witness: { ...e.witness, boundary: verifyBoundary(e.witness, alerts, now) } }
      : e,
  );
  const eventsBv2 = linkRecalcChain(
    b.events
      .filter((e) => e.ruleVersionId === v2.id)
      .map((e) =>
        e.witness
          ? { ...e, witness: { ...e.witness, boundary: verifyBoundary(e.witness, alerts, now) } }
          : e,
      ),
    eventsBv1,
  );
  const eventsB = [...eventsBv1, ...eventsBv2];
  const allEventsA = [...v1EventsA, ...v2EventsA];

  // 离线处置样例：巡检端 16:40 批注、17:10 基于过期版本重新打开监管端已关闭事件
  const seededActions: DisposalAction[] = [];
  if (input.seedOfflineActions) {
    const contraEvent = allEventsA.find(
      (e) => e.deviceId === 'VW-001' && e.ruleId === 'R-CONTRA' && e.ruleVersionId === v2.id,
    );
    if (contraEvent) {
      seededActions.push(
        {
          id: 'ACT-SEED-1',
          eventId: contraEvent.id,
          deviceId: 'VW-001',
          actor: '张巡检',
          role: 'inspector',
          action: 'annotate',
          comment: '离线巡检：阀门井室仍有气流声，状态矛盾未消除，补充现场照片编号 IMG-7781',
          at: t(16, 40),
          baseVersion: 1,
          syncState: 'local',
        },
        {
          id: 'ACT-SEED-2',
          eventId: contraEvent.id,
          deviceId: 'VW-001',
          actor: '张巡检',
          role: 'inspector',
          action: 'reopen',
          comment: '离线重开：现场复核与监管端关闭结论不一致，待联网对照',
          at: t(17, 10),
          baseVersion: 2,
          syncState: 'conflict',
        },
      );
    }
  }

  const membershipAlertIds = new Set(a.memberships.map((m) => m.alertId));
  const graph = buildEvidenceGraph({
    raw: input.raw,
    ledger: input.ledger,
    zones: input.zones,
    rectifications: input.rectifications,
    alerts,
    events: [...allEventsA, ...eventsB],
    membershipAlertIds,
  });

  const alertsById = new Map(alerts.map((x) => [x.id, x]));
  const { report } = await buildSyncReport({
    eventsA: allEventsA,
    eventsB,
    memberships: a.memberships,
    alertsById,
    dict,
    allAlerts: alerts,
    actions: seededActions,
    rectifications: input.rectifications,
    localRev: input.localRev,
    nowIso: now,
    id: `SYNC-${now.slice(0, 10)}`,
  });

  return {
    observations,
    alignmentFailures: failures,
    alerts,
    eventsA: allEventsA,
    eventsB,
    memberships: a.memberships,
    dict,
    graph,
    report,
    seededActions,
  };
}
