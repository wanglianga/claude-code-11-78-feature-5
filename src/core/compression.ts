// ============================================================
// 告警压缩双路线：
// 路线 A —— 规范化的不可变“成员—事件”关系，逐成员贡献直接可读，
//           规则更新后仅对受影响窗口局部重算，旧关系永不改写。
// 路线 B —— 按设备 / 连续时间窗 / 规则版本编码的压缩成员见证，
//           成员以内容寻址告警引用 + 时间槽位 + 贡献字典码表示，
//           查询时确定性解码，并强制校验见证未遗漏边界成员。
// 两条路线对同一组告警必须还原出相同的成员集合、严重度与贡献。
// ============================================================

import { canonicalize, contentId, sha256Hex } from './crypto';
import { maxSeverity, KIND_LABEL } from './engine';
import type {
  Alert,
  CompressedWitness,
  CompressionEvent,
  MembershipRecord,
  Severity,
} from './types';

export const WINDOW_GAP_MIN = 60; // 连续时间窗：同键告警间隔超过 60 分钟则切窗
export const SLOT_MIN = 5; // 路线 B 时间槽粒度

// ---------------- 连续时间窗分组（两路线共用，保证同一切分） ----------------
export function buildGroups(alerts: Alert[]): Alert[][] {
  const groups: Alert[][] = [];
  const keyOf = (a: Alert) =>
    `${a.deviceId}|${a.ruleId}|${a.ruleVersionId}|${a.ledgerVersion}`;
  const sorted = [...alerts].sort(
    (a, b) =>
      a.deviceId.localeCompare(b.deviceId) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.ruleVersionId.localeCompare(b.ruleVersionId) ||
      new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime() ||
      a.id.localeCompare(b.id),
  );
  let current: Alert[] = [];
  let currentKey = '';
  for (const a of sorted) {
    const key = keyOf(a);
    const last = current[current.length - 1];
    const gapMin = last
      ? (new Date(a.observedAt).getTime() - new Date(last.observedAt).getTime()) / 60000
      : Infinity;
    if (!last || key !== currentKey || gapMin > WINDOW_GAP_MIN) {
      if (current.length) groups.push(current);
      current = [a];
      currentKey = key;
    } else {
      current.push(a);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

const eventTitle = (members: Alert[]) =>
  `${members[0].deviceId} ${KIND_LABEL[members[0].kind]}聚合事件（${members.length} 条成员告警）`;

const aggregateSeverity = (members: Alert[]): Severity =>
  members.reduce<Severity>((acc, m) => maxSeverity(acc, m.severity), 'info');

// ============================================================
// 路线 A：规范化不可变成员—事件关系
// ============================================================
export async function compressRouteA(
  groups: Alert[][],
  nowIso: string,
): Promise<{ events: CompressionEvent[]; memberships: MembershipRecord[] }> {
  const events: CompressionEvent[] = [];
  const memberships: MembershipRecord[] = [];
  for (const members of groups) {
    const first = members[0];
    const eventId = await contentId({
      route: 'A',
      deviceId: first.deviceId,
      ruleId: first.ruleId,
      ruleVersionId: first.ruleVersionId,
      ledgerVersion: first.ledgerVersion,
      windowStart: members[0].observedAt,
      windowEnd: members[members.length - 1].observedAt,
      memberIds: members.map((m) => m.id).sort(),
    });
    for (const m of members) {
      memberships.push({
        eventId,
        alertId: m.id,
        immutable: true,
        severityContribution: m.contribution.severityScore,
        recommendationContribution: m.contribution.recommendation,
        ruleVersionId: m.ruleVersionId,
        ledgerVersion: m.ledgerVersion,
        createdAt: nowIso,
      });
    }
    events.push({
      id: eventId,
      route: 'A',
      deviceId: first.deviceId,
      ruleId: first.ruleId,
      ruleVersionId: first.ruleVersionId,
      ledgerVersion: first.ledgerVersion,
      // 与路线 B 保持同一时间窗定义：首/末成员的观测时间
      windowStart: members[0].observedAt,
      windowEnd: members[members.length - 1].observedAt,
      severity: aggregateSeverity(members),
      title: eventTitle(members),
      memberCount: members.length,
      status: 'open',
      createdAt: nowIso,
      parentEventId: null,
    });
  }
  return { events, memberships };
}

// ============================================================
// 路线 B：压缩成员见证 + 内容寻址引用
// ============================================================
export class ContributionDict {
  private readonly codes = new Map<string, number>();
  private readonly values: string[] = [];

  intern(text: string): number {
    const existing = this.codes.get(text);
    if (existing !== undefined) return existing;
    const code = this.values.length;
    this.values.push(text);
    this.codes.set(text, code);
    return code;
  }

  lookup(code: number): string {
    const v = this.values[code];
    if (v === undefined) throw new Error(`贡献字典码越界：${code}`);
    return v;
  }

  toJSON(): string[] {
    return [...this.values];
  }

  static fromJSON(values: string[]): ContributionDict {
    const d = new ContributionDict();
    values.forEach((v, i) => {
      d.values[i] = v;
      d.codes.set(v, i);
    });
    return d;
  }
}

function slotOf(windowStart: string, observedAt: string): number {
  const diffMin =
    (new Date(observedAt).getTime() - new Date(windowStart).getTime()) / 60000;
  return Math.floor(diffMin / SLOT_MIN);
}

export async function compressRouteB(
  groups: Alert[][],
  dict: ContributionDict,
  nowIso: string,
): Promise<{ events: CompressionEvent[] }> {
  const events: CompressionEvent[] = [];
  for (const members of groups) {
    const first = members[0];
    const windowStart = members[0].observedAt;
    const windowEnd = members[members.length - 1].observedAt;
    const memberSlots = members.map((m) => slotOf(windowStart, m.observedAt));
    const alertRefs = members.map((m) => m.id); // 内容寻址的原始告警引用
    const severityScores = members.map((m) => m.contribution.severityScore);
    const rationaleCodes = members.map((m) => dict.intern(m.contribution.rationale));
    // 处置建议同样字典化，保证逐成员建议可还原
    members.forEach((m) => dict.intern(m.contribution.recommendation));

    const witnessBody = {
      deviceId: first.deviceId,
      ruleId: first.ruleId,
      ruleVersionId: first.ruleVersionId,
      ledgerVersion: first.ledgerVersion,
      windowStart,
      windowEnd,
      windowSlotMinutes: SLOT_MIN,
      memberSlots,
      alertRefs,
      severityScores,
      rationaleCodes,
    };
    const witnessHash = await sha256Hex(canonicalize(witnessBody));
    const witness: CompressedWitness = {
      ...witnessBody,
      witnessHash,
      boundary: {
        prevSlotAlertId: null,
        nextSlotAlertId: null,
        passed: false,
        verifiedAt: null,
        note: '待边界校验',
      },
    };
    const eventId = await contentId({ route: 'B', witnessHash });
    events.push({
      id: eventId,
      route: 'B',
      deviceId: first.deviceId,
      ruleId: first.ruleId,
      ruleVersionId: first.ruleVersionId,
      ledgerVersion: first.ledgerVersion,
      windowStart,
      windowEnd,
      severity: aggregateSeverity(members),
      title: eventTitle(members),
      memberCount: members.length,
      status: 'open',
      createdAt: nowIso,
      witness,
      parentEventId: null,
    });
  }
  return { events };
}

// ---------------- 确定性解码 ----------------
export interface DecodedMember {
  alert: Alert;
  slot: number;
  severityScore: number;
  rationale: string;
  recommendation: string;
}

/** 解码见证：解析槽位/引用/字典码，并验证槽位与引用一致 */
export function decodeWitness(
  witness: CompressedWitness,
  alertsById: Map<string, Alert>,
  dict: ContributionDict,
): DecodedMember[] {
  const out: DecodedMember[] = [];
  for (let i = 0; i < witness.alertRefs.length; i++) {
    const alert = alertsById.get(witness.alertRefs[i]);
    if (!alert) throw new Error(`见证引用的内容寻址告警缺失：${witness.alertRefs[i]}`);
    const expectSlot = slotOf(witness.windowStart, alert.observedAt);
    if (expectSlot !== witness.memberSlots[i]) {
      throw new Error(
        `见证槽位解码不一致：事件 ${witness.deviceId}/${witness.ruleId} 成员 ${alert.id}`,
      );
    }
    out.push({
      alert,
      slot: witness.memberSlots[i],
      severityScore: witness.severityScores[i],
      rationale: dict.lookup(witness.rationaleCodes[i]),
      recommendation: alert.contribution.recommendation,
    });
  }
  return out;
}

/**
 * 边界校验：扫描同设备/同规则/同台账版本的告警，
 * 确认时间窗两侧各一个槽位内不存在被遗漏的成员。
 */
export function verifyBoundary(
  witness: CompressedWitness,
  allAlerts: Alert[],
  nowIso: string,
): CompressedWitness['boundary'] {
  const startMs = new Date(witness.windowStart).getTime();
  const endMs = new Date(witness.windowEnd).getTime();
  const slotMs = SLOT_MIN * 60000;
  const refs = new Set(witness.alertRefs);
  const sameKey = allAlerts.filter(
    (a) =>
      a.deviceId === witness.deviceId &&
      a.ruleId === witness.ruleId &&
      a.ruleVersionId === witness.ruleVersionId &&
      a.ledgerVersion === witness.ledgerVersion,
  );
  let prevSlotAlertId: string | null = null;
  let nextSlotAlertId: string | null = null;
  const missing: string[] = [];
  for (const a of sameKey) {
    const ms = new Date(a.observedAt).getTime();
    if (ms >= startMs - slotMs && ms < startMs) {
      prevSlotAlertId = a.id;
      if (!refs.has(a.id)) missing.push(a.id);
    }
    if (ms > endMs && ms <= endMs + slotMs) {
      nextSlotAlertId = a.id;
      if (!refs.has(a.id)) missing.push(a.id);
    }
  }
  const passed = missing.length === 0;
  return {
    prevSlotAlertId,
    nextSlotAlertId,
    passed,
    verifiedAt: nowIso,
    note: passed
      ? '边界校验通过：两侧相邻槽位无遗漏成员'
      : `边界校验失败：遗漏成员 ${missing.join(', ')}`,
  };
}

// ---------------- 规则换版：局部重算链 ----------------
/** 将新版本事件与旧版本事件按 设备+规则+时间窗重叠 串联 parentEventId */
export function linkRecalcChain(
  newEvents: CompressionEvent[],
  oldEvents: CompressionEvent[],
): CompressionEvent[] {
  return newEvents.map((ev) => {
    const parent = oldEvents.find(
      (old) =>
        old.route === ev.route &&
        old.deviceId === ev.deviceId &&
        old.ruleId === ev.ruleId &&
        new Date(old.windowStart).getTime() <= new Date(ev.windowEnd).getTime() &&
        new Date(old.windowEnd).getTime() >= new Date(ev.windowStart).getTime(),
    );
    return parent ? { ...ev, parentEventId: parent.id } : ev;
  });
}
