// ============================================================
// 同步对照器：
// 1) 统计两条路线的本地索引/载荷体积差异；
// 2) 对任何聚合事件核验 A/B 还原的成员集合、严重度、贡献完全相同；
// 3) 模拟离线补传后的本地/远端冲突（乐观锁版本号），保留全部行动。
// ============================================================

import { byteSize, canonicalize } from './crypto';
import {
  ContributionDict,
  decodeWitness,
  verifyBoundary,
} from './compression';
import type {
  Alert,
  CompressionEvent,
  DisposalAction,
  EquivalenceCheck,
  MembershipRecord,
  Rectification,
  RouteStat,
  SyncConflict,
  SyncReport,
} from './types';

const eventKey = (e: CompressionEvent) =>
  `${e.deviceId}|${e.ruleId}|${e.ruleVersionId}|${e.windowStart}|${e.windowEnd}`;

export function computeRouteStats(
  eventsA: CompressionEvent[],
  memberships: MembershipRecord[],
  eventsB: CompressionEvent[],
  dict: ContributionDict,
): Record<'A' | 'B', RouteStat> {
  return {
    A: {
      payloadBytes:
        eventsA.reduce((n, e) => n + byteSize(canonicalize(e)), 0) +
        memberships.reduce((n, m) => n + byteSize(canonicalize(m)), 0),
      membershipCount: memberships.length,
      witnessCount: 0,
      indexCount: eventsA.length + memberships.length,
    },
    B: {
      payloadBytes:
        eventsB.reduce((n, e) => n + byteSize(canonicalize(e)), 0) +
        byteSize(canonicalize(dict.toJSON())),
      membershipCount: 0,
      witnessCount: eventsB.length,
      indexCount: eventsB.length + dict.toJSON().length,
    },
  };
}

/** A/B 等价性核验：成员集合、严重度、逐成员贡献，并测量 B 的解码耗时 */
export function checkEquivalence(
  eventsA: CompressionEvent[],
  eventsB: CompressionEvent[],
  alertsById: Map<string, Alert>,
  dict: ContributionDict,
): EquivalenceCheck[] {
  const bByKey = new Map(eventsB.map((e) => [eventKey(e), e]));
  const out: EquivalenceCheck[] = [];
  for (const evA of eventsA) {
    const evB = bByKey.get(eventKey(evA));
    if (!evB) {
      out.push({
        eventKey: eventKey(evA),
        sameMembers: false,
        sameSeverity: false,
        sameContributions: false,
        memberCountA: evA.memberCount,
        memberCountB: 0,
        decodeMsB: 0,
        missingBoundary: true,
      });
      continue;
    }
    const t0 = performance.now();
    const decoded = evB.witness
      ? decodeWitness(evB.witness, alertsById, dict)
      : [];
    const decodeMsB = +(performance.now() - t0).toFixed(3);

    const membersA = (evA.memberships ?? []).map((m) => m.alertId).sort();
    const membersB = [...(evB.witness?.alertRefs ?? [])].sort();
    const sameMembers = canonicalize(membersA) === canonicalize(membersB);

    const sameSeverity = evA.severity === evB.severity;

    const bScoreById = new Map(decoded.map((d) => [d.alert.id, d]));
    const sameContributions = (evA.memberships ?? []).every((m) => {
      const d = bScoreById.get(m.alertId);
      const alert = alertsById.get(m.alertId);
      if (!d || !alert) return false;
      return (
        d.severityScore === m.severityContribution &&
        d.rationale === alert.contribution.rationale &&
        d.recommendation === m.recommendationContribution &&
        d.recommendation === alert.contribution.recommendation
      );
    });

    out.push({
      eventKey: eventKey(evA),
      sameMembers,
      sameSeverity,
      sameContributions,
      memberCountA: membersA.length,
      memberCountB: membersB.length,
      decodeMsB,
      missingBoundary: evB.witness ? !evB.witness.boundary.passed : true,
    });
  }
  return out;
}

// ---------------- 离线补传冲突模拟 ----------------
export interface RemoteSnapshot {
  closedEventKeys: string[]; // 远端已关闭事件（设备+规则）
  remoteActions: Array<{ eventKey: string; actor: string; at: string; comment: string; baseVersion: number }>;
  rectificationStatus: Record<string, Rectification['status']>;
  rev: number;
}

/** 确定性的“监管端”远端快照：离线窗口内远端也在处置同一批事件 */
export function buildMockRemote(): RemoteSnapshot {
  const DAY = '2026-11-23';
  const iso = (h: number, m: number) =>
    `${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`;
  return {
    closedEventKeys: ['VW-001|R-CONTRA'],
    remoteActions: [
      {
        eventKey: 'VW-001|R-CONTRA',
        actor: '李督导',
        at: iso(17, 5),
        comment: '监管端远程复核：现场阀门已复位，关闭事件',
        baseVersion: 1,
      },
    ],
    rectificationStatus: { 'RC-001': 'done' },
    rev: 17,
  };
}

export function compareLocalRemote(
  events: CompressionEvent[],
  actions: DisposalAction[],
  rectifications: Rectification[],
  remote: RemoteSnapshot,
): SyncConflict[] {
  const conflicts: SyncConflict[] = [];
  const pushConflict = (c: Omit<SyncConflict, 'id'>) =>
    conflicts.push({ ...c, id: `${c.entityType}:${c.entityId}:${conflicts.length}` });
  const routeAEvents = events.filter((e) => e.route === 'A');

  for (const ev of routeAEvents) {
    const shortKey = `${ev.deviceId}|${ev.ruleId}`;
    if (!remote.closedEventKeys.includes(shortKey)) continue;
    const localClosed = actions.some((a) => a.eventId === ev.id && a.action === 'close');
    const localReopen = actions.find((a) => a.eventId === ev.id && a.action === 'reopen');
    if (localReopen && !localClosed) {
      pushConflict({
        entityType: 'event_status',
        entityId: ev.id,
        local: `本地 ${localReopen.at.slice(11, 16)} 由 ${localReopen.actor} 重新打开（baseVersion=${localReopen.baseVersion}）：${localReopen.comment}`,
        remote: `远端 rev=${remote.rev} 已关闭该事件（${shortKey}）`,
        resolution: 'pending',
      });
    }
    const remoteAction = remote.remoteActions.find((r) => r.eventKey === shortKey);
    if (remoteAction && localReopen) {
      pushConflict({
        entityType: 'action',
        entityId: ev.id,
        local: `本地行动基于 baseVersion=${localReopen.baseVersion}，与远端写入版本冲突`,
        remote: `远端行动 ${remoteAction.at.slice(11, 16)} ${remoteAction.actor}：${remoteAction.comment}`,
        resolution: 'pending',
      });
    }
  }

  for (const rc of rectifications) {
    const remoteStatus = remote.rectificationStatus[rc.id];
    if (remoteStatus && remoteStatus !== rc.status) {
      pushConflict({
        entityType: 'rectification',
        entityId: rc.id,
        local: `本地回执状态：${rc.status}`,
        remote: `远端回执状态：${remoteStatus}（rev=${remote.rev}）`,
        resolution: 'pending',
      });
    }
  }
  return conflicts;
}

export async function buildSyncReport(input: {
  eventsA: CompressionEvent[];
  eventsB: CompressionEvent[];
  memberships: MembershipRecord[];
  alertsById: Map<string, Alert>;
  dict: ContributionDict;
  allAlerts: Alert[];
  actions: DisposalAction[];
  rectifications: Rectification[];
  localRev: number;
  nowIso: string;
  id: string;
}): Promise<{ report: SyncReport; eventsB: CompressionEvent[] }> {
  // 报告生成时补做 B 路线边界校验，确保见证未遗漏边界成员
  const eventsB = input.eventsB.map((e) =>
    e.witness
      ? { ...e, witness: { ...e.witness, boundary: verifyBoundary(e.witness, input.allAlerts, input.nowIso) } }
      : e,
  );
  const remote = buildMockRemote();
  const conflicts = compareLocalRemote(
    [...input.eventsA, ...eventsB],
    input.actions,
    input.rectifications,
    remote,
  );
  const report: SyncReport = {
    id: input.id,
    generatedAt: input.nowIso,
    localRev: input.localRev,
    remoteRev: remote.rev,
    routeStats: computeRouteStats(input.eventsA, input.memberships, eventsB, input.dict),
    conflicts,
    equivalence: checkEquivalence(input.eventsA, eventsB, input.alertsById, input.dict),
  };
  return { report, eventsB };
}
