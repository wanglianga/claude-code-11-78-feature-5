// ============================================================
// 安全评估样例账本（确定性、无随机数）
// 冻结历史窗口 2026-11-10 → 2026-11-16，标签截止 2026-11-20。
// 中途发生一次策略换版（SP-2026.1 → SP-2026.2，11-13 00:00），
// 因此部分事件生命周期的成员暴露跨两个策略版本，用于验证
// “按成员告警当时策略版本拆分暴露、不以关闭时版本覆盖”。
// 另含标签截止后才到达的整改回执（右删失）与区域风险台账修订
// （发生在观察起点之后，只可留档、不得用于最初分层）。
// ============================================================

import type {
  CandidateSample,
  DownstreamEvent,
  EvalRuleVersion,
  LedgerRevision,
  MergePolicy,
  RiskRegion,
  SafetyConfig,
  SafetyDataset,
  SafetyMemberAlert,
} from './safetyTypes';
import type { RuleKind, Severity } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
const t = (day: number, h: number, m = 0) =>
  `2026-11-${pad(day)}T${pad(h)}:${pad(m)}:00+08:00`;
const plusHoursIso = (iso: string, h: number) => plusMinIso(iso, h * 60);
const plusMinIso = (iso: string, min: number) => {
  const ms = new Date(iso).getTime() + min * 60_000;
  const d = new Date(ms + 8 * 3600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
};

export const FROZEN_AT = t(9, 9, 0); // 冻结基线 11-09 09:00（观察窗口开始前冻结）
export const WINDOW_START = t(10, 0, 0); // 11-10 00:00
export const WINDOW_END = t(16, 23, 45); // 11-16 23:45
export const LABEL_CUTOFF = t(20, 12, 0); // 11-20 12:00 标签截止
export const POLICY_SWITCH_AT = t(13, 0, 0); // 11-13 00:00 策略换版

export function buildSafetyPolicies(): MergePolicy[] {
  return [
    {
      id: 'SP-2026.1',
      effectiveFrom: t(1, 0, 0),
      mergeWindowMin: 45,
      retainKeyRawAlerts: true,
      aggressiveMerge: false,
      note: '旧策略：45 分钟归并窗，保留关键原始告警为独立条目',
    },
    {
      id: 'SP-2026.2',
      effectiveFrom: POLICY_SWITCH_AT,
      mergeWindowMin: 120,
      retainKeyRawAlerts: false,
      aggressiveMerge: true,
      note: '新策略：归并窗 120 分钟、激进折叠，不再单列部分关键原始告警（待评估是否掩盖升级风险）',
    },
  ];
}

export function buildSafetyRuleVersions(): EvalRuleVersion[] {
  return [
    { id: 'EVR-2026.A', publishedAt: t(1, 0, 0), changelog: '评估基线规则：跳变 0.40、矛盾容忍 10、逾期宽限 60 分钟' },
    { id: 'EVR-2026.B', publishedAt: t(13, 0, 0), changelog: '评估规则收紧：跳变 0.25 升 critical、矛盾容忍 5、逾期宽限 30 分钟' },
  ];
}

export function buildSafetyRegions(): RiskRegion[] {
  return [
    { regionId: 'RG-CBD', name: '中心商圈', riskTierAtFreeze: 'R3', ledgerVersionAtFreeze: 'ledger-2026-11-08', note: '学校/商圈密集，冻结前台账定为高风险层' },
    { regionId: 'RG-OLD', name: '老城棚改区', riskTierAtFreeze: 'R3', ledgerVersionAtFreeze: 'ledger-2026-11-08', note: '老旧管网高密度，冻结前定为高风险层' },
    { regionId: 'RG-IND', name: '工业园南区', riskTierAtFreeze: 'R2', ledgerVersionAtFreeze: 'ledger-2026-11-08', note: '中风险，施工频繁' },
    { regionId: 'RG-GATE', name: '城北门站区', riskTierAtFreeze: 'R2', ledgerVersionAtFreeze: 'ledger-2026-11-08', note: '中风险门站周边' },
    { regionId: 'RG-SUB', name: '城南居住区', riskTierAtFreeze: 'R1', ledgerVersionAtFreeze: 'ledger-2026-11-08', note: '低风险居住区' },
  ];
}

/** 观察起点之后的台账修订：只能留档，不能决定最初分层 */
export function buildLedgerRevisions(): LedgerRevision[] {
  return [
    {
      id: 'LR-001',
      regionId: 'RG-IND',
      at: t(12, 0, 0),
      fromTier: 'R2',
      toTier: 'R3',
      reason: '11-12 突发燃气泄漏投诉，评估期临时上调风险层（发生于观察起点之后，不得回溯用于分层）',
    },
    {
      id: 'LR-002',
      regionId: 'RG-SUB',
      at: t(14, 0, 0),
      fromTier: 'R1',
      toTier: 'R2',
      reason: '11-14 新增商业体接入，临时上调（同样只留档）',
    },
  ];
}

// ---------------- 样本构造助手 ----------------
interface MemberSpec {
  h: number; // 相对观察起点小时数（可用小数）
  kind: RuleKind;
  severity: Severity;
  concentration: number;
  key?: boolean;
  conflict?: boolean;
  /** 默认按成员时间自动判定策略版本；可显式覆盖 */
  policy?: string;
}

interface SampleSpec {
  id: string;
  deviceId: string;
  regionId: string;
  deviceType: CandidateSample['deviceType'];
  startDay: number;
  startH: number;
  construction: boolean;
  shift: CandidateSample['shiftLoad'];
  band: CandidateSample['concentrationBand'];
  closeH: number | null; // 相对观察起点小时数；null=标签截止仍未关闭
  peak: number;
  members: MemberSpec[];
  downstream?: DownstreamEvent[];
  rectification?: { dueH: number; receiptH: number | null; status: 'pending' | 'done'; note: string } | null;
  conflict?: boolean;
}

let mseq = 0;

function policyAt(at: string): string {
  return new Date(at).getTime() >= new Date(POLICY_SWITCH_AT).getTime() ? 'SP-2026.2' : 'SP-2026.1';
}
function ruleAt(at: string): string {
  return new Date(at).getTime() >= new Date(POLICY_SWITCH_AT).getTime() ? 'EVR-2026.B' : 'EVR-2026.A';
}

function buildSample(spec: SampleSpec): CandidateSample {
  mseq = 0;
  const start = t(spec.startDay, spec.startH, 0);
  const members: SafetyMemberAlert[] = spec.members.map((m) => {
    const at = plusHoursIso(start, m.h);
    const arrived = plusMinIso(at, 1 + (mseq % 3));
    const policy = m.policy ?? policyAt(at);
    const retainedRaw = policy === 'SP-2026.2'
      ? !(m.key ?? false) && !(m.conflict ?? false) // 新策略激进折叠关键/冲突告警
      : true;
    mseq += 1;
    return {
      id: `${spec.id}-M${String(mseq).padStart(4, '0')}`,
      deviceId: spec.deviceId,
      observedAt: at,
      arrivedAt: arrived,
      kind: m.kind,
      severity: m.severity,
      concentration: m.concentration,
      key: !!m.key || m.concentration >= 18 || m.severity === 'critical',
      evidenceConflict: !!m.conflict,
      policyVersionId: policy,
      ruleVersionId: ruleAt(at),
      retainedRaw,
    };
  });
  // 观察起点 = 事件全部成员告警到达并冻结的时刻（事件形成时点）；
  // 其后发生的复测/派单/整改时间线与台账修订均属“观察起点之后”。
  const lastArrived = members
    .map((m) => m.arrivedAt)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const observationStart = plusMinIso(lastArrived, 2);
  const closeIso = spec.closeH === null ? null : plusHoursIso(start, spec.closeH);
  const rect = spec.rectification
    ? {
        dueAt: plusHoursIso(start, spec.rectification.dueH),
        receiptAt:
          spec.rectification.receiptH === null ? null : plusHoursIso(start, spec.rectification.receiptH),
        status: spec.rectification.status,
        note: spec.rectification.note,
      }
    : null;
  return {
    id: spec.id,
    deviceId: spec.deviceId,
    regionId: spec.regionId,
    deviceType: spec.deviceType,
    constructionState: spec.construction ? 'active' : 'none',
    shiftLoad: spec.shift,
    concentrationBand: spec.band,
    observationStart,
    lifecycleStart: start,
    lifecycleClose: closeIso,
    evidenceConflict: !!spec.conflict,
    peakConcentration: spec.peak,
    members,
    downstream: spec.downstream ?? [],
    rectification: rect,
  };
}
/** 每条样本的观察起点不同（窗口内错开），用于验证按起点冻结 */
export function buildSafetySamples(): CandidateSample[] {
  const specs: SampleSpec[] = [
    // ===== R3 高风险层：旧/新策略在同一单元内成对覆盖 =====
    {
      id: 'S-301', deviceId: 'VW-401', regionId: 'RG-CBD', deviceType: 'valve_well',
      startDay: 11, startH: 8, construction: false, shift: 'heavy', band: 'high', closeH: 7, peak: 16,
      members: [
        { h: 0.2, kind: 'contradiction', severity: 'critical', concentration: 16, key: true },
        { h: 2.4, kind: 'jump', severity: 'major', concentration: 15 },
      ],
      downstream: [
        { id: 'D-301a', type: 'retest', at: t(11, 15, 0), outcome: 'confirmed', note: '复测确认浓度持续', resourceMin: 50, concentration: 16 },
        { id: 'D-301b', type: 'manual_escalation', at: t(11, 18, 0), outcome: 'confirmed', note: '人工升级' },
      ],
      rectification: { dueH: 9, receiptH: 10, status: 'done', note: '旧策略下按时闭环' },
    },
    {
      id: 'S-107', deviceId: 'VW-407', regionId: 'RG-CBD', deviceType: 'valve_well',
      startDay: 15, startH: 8, construction: false, shift: 'heavy', band: 'high', closeH: 6, peak: 20,
      members: [
        { h: 0.2, kind: 'contradiction', severity: 'critical', concentration: 18, key: true },
        { h: 1.8, kind: 'jump', severity: 'critical', concentration: 20, key: true },
      ],
      downstream: [
        { id: 'D-107a', type: 'retest', at: t(15, 14, 0), outcome: 'confirmed', note: '复测确认高浓度', resourceMin: 60, concentration: 20 },
      ],
      rectification: { dueH: 9, receiptH: 20, status: 'done', note: '回执晚于截止 11 小时（早于标签截止），按逾期' },
    },
    {
      id: 'S-309', deviceId: 'PS-409', regionId: 'RG-OLD', deviceType: 'pressure_sensor',
      startDay: 12, startH: 10, construction: false, shift: 'normal', band: 'mid', closeH: 7, peak: 14,
      members: [
        { h: 0.2, kind: 'contradiction', severity: 'major', concentration: 13 },
        { h: 3.2, kind: 'jump', severity: 'major', concentration: 14 },
      ],
      rectification: { dueH: 7, receiptH: 7, status: 'done', note: '旧策略按时' },
    },
    {
      id: 'S-102', deviceId: 'PS-202', regionId: 'RG-OLD', deviceType: 'pressure_sensor',
      startDay: 15, startH: 10, construction: false, shift: 'normal', band: 'mid', closeH: 8, peak: 13,
      members: [
        { h: 0.5, kind: 'missing', severity: 'major', concentration: 9 },
        { h: 4.5, kind: 'jump', severity: 'major', concentration: 12 },
      ],
      downstream: [
        { id: 'D-102a', type: 'high_concentration_recurrence', at: t(17, 2, 0), outcome: 'confirmed', note: '数日后高浓度重现（迟滞确认）' },
      ],
      rectification: { dueH: 8, receiptH: 22, status: 'done', note: '回执晚于截止 14 小时（早于标签截止）' },
    },
    {
      id: 'S-303', deviceId: 'FW-403', regionId: 'RG-IND', deviceType: 'flow_sensor',
      startDay: 12, startH: 8, construction: true, shift: 'light', band: 'low', closeH: 5, peak: 6,
      members: [ { h: 0.3, kind: 'missing', severity: 'info', concentration: 5 } ],
      rectification: null,
      downstream: [],
    },
    {
      id: 'S-103', deviceId: 'FS-203', regionId: 'RG-IND', deviceType: 'flow_sensor',
      startDay: 15, startH: 6, construction: true, shift: 'light', band: 'low', closeH: 5, peak: 7,
      members: [ { h: 0.3, kind: 'missing', severity: 'info', concentration: 5 } ],
      rectification: null,
      downstream: [],
    },
    // 旧策略独占单元（无新策略对照）→ 显式未匹配
    {
      id: 'S-311', deviceId: 'FS-411', regionId: 'RG-OLD', deviceType: 'flow_sensor',
      startDay: 12, startH: 15, construction: false, shift: 'light', band: 'low', closeH: null, peak: 9,
      members: [ { h: 0.4, kind: 'missing', severity: 'minor', concentration: 6 } ],
      rectification: { dueH: 6, receiptH: null, status: 'pending', note: '事件生命周期未关闭 → 右删失' },
    },
    // 混合生命周期：起点在换版前、关闭在换版后 → 不可归入单一臂
    {
      id: 'S-201', deviceId: 'VW-301', regionId: 'RG-CBD', deviceType: 'valve_well',
      startDay: 12, startH: 20, construction: false, shift: 'heavy', band: 'high', closeH: 22, peak: 18,
      members: [
        { h: 0.3, kind: 'contradiction', severity: 'major', concentration: 17 }, // 换版前 SP-2026.1
        { h: 7.0, kind: 'jump', severity: 'critical', concentration: 18, key: true, conflict: true }, // 换版后 SP-2026.2
      ],
      downstream: [ { id: 'D-201a', type: 'manual_escalation', at: t(14, 12, 0), outcome: 'confirmed', note: '人工升级确认' } ],
      rectification: { dueH: 20, receiptH: 26, status: 'done', note: '跨版事件最终按时整改' },
    },
    {
      id: 'S-202', deviceId: 'PS-302', regionId: 'RG-OLD', deviceType: 'pressure_sensor',
      startDay: 12, startH: 18, construction: false, shift: 'normal', band: 'mid', closeH: 24, peak: 13,
      members: [
        { h: 1.0, kind: 'missing', severity: 'major', concentration: 10 },
        { h: 8.5, kind: 'jump', severity: 'critical', concentration: 13, conflict: true },
      ],
      rectification: { dueH: 10, receiptH: 12, status: 'done', note: '跨版事件，最终按时整改' },
    },
    // 原始高浓度 / 证据冲突 → 始终直达人工队列，不参与压缩覆盖比较
    {
      id: 'S-104', deviceId: 'VW-204', regionId: 'RG-OLD', deviceType: 'valve_well',
      startDay: 14, startH: 8, construction: false, shift: 'heavy', band: 'high', closeH: 7, peak: 24,
      members: [
        { h: 0.2, kind: 'contradiction', severity: 'critical', concentration: 23, key: true, conflict: true },
        { h: 3.0, kind: 'jump', severity: 'critical', concentration: 24, conflict: true },
      ],
      downstream: [ { id: 'D-104a', type: 'retest', at: t(14, 16, 0), outcome: 'confirmed', note: '证据冲突复测确认', resourceMin: 55, concentration: 24 } ],
      rectification: { dueH: 10, receiptH: 11, status: 'done', note: '证据冲突直达人工' },
    },

    // ===== R2 中风险层：旧/新策略成对覆盖 =====
    {
      id: 'S-305', deviceId: 'PS-405', regionId: 'RG-GATE', deviceType: 'pressure_sensor',
      startDay: 12, startH: 9, construction: false, shift: 'normal', band: 'mid', closeH: 7, peak: 12,
      members: [ { h: 0.6, kind: 'jump', severity: 'major', concentration: 11 } ],
      rectification: { dueH: 7, receiptH: 7, status: 'done', note: '旧策略按时复测' },
    },
    {
      id: 'S-105', deviceId: 'PS-205', regionId: 'RG-GATE', deviceType: 'pressure_sensor',
      startDay: 16, startH: 9, construction: false, shift: 'normal', band: 'mid', closeH: 9, peak: 12,
      members: [ { h: 0.6, kind: 'jump', severity: 'major', concentration: 11 } ],
      rectification: { dueH: 9, receiptH: 11, status: 'done', note: '回执晚于截止 2 小时（早于标签截止），按逾期' },
    },
    {
      id: 'S-310', deviceId: 'PS-410', regionId: 'RG-IND', deviceType: 'pressure_sensor',
      startDay: 11, startH: 13, construction: true, shift: 'normal', band: 'mid', closeH: 8, peak: 12,
      members: [ { h: 0.6, kind: 'missing', severity: 'major', concentration: 10 } ],
      rectification: { dueH: 8, receiptH: 8, status: 'done', note: '施工期，旧策略按时' },
    },
    {
      id: 'S-403', deviceId: 'PS-203', regionId: 'RG-IND', deviceType: 'pressure_sensor',
      startDay: 16, startH: 15, construction: true, shift: 'normal', band: 'mid', closeH: 6, peak: 13,
      members: [ { h: 0.6, kind: 'jump', severity: 'major', concentration: 12 } ],
      rectification: { dueH: 7, receiptH: 100, status: 'done', note: '回执在标签截止（11-20 12:00）之后到达 → 右删失' },
    },
    {
      id: 'S-501', deviceId: 'PS-601', regionId: 'RG-GATE', deviceType: 'pressure_sensor',
      startDay: 15, startH: 11, construction: false, shift: 'normal', band: 'high', closeH: 6, peak: 26, conflict: true,
      members: [
        { h: 0.4, kind: 'jump', severity: 'critical', concentration: 26, key: true, conflict: true },
        { h: 1.2, kind: 'contradiction', severity: 'critical', concentration: 25, conflict: true },
      ],
      downstream: [ { id: 'D-501a', type: 'retest', at: t(15, 20, 0), outcome: 'confirmed', note: '证据冲突复测确认', resourceMin: 60, concentration: 26 } ],
      rectification: { dueH: 9, receiptH: 12, status: 'done', note: '证据冲突直达人工队列' },
    },

    // ===== R1 低风险层：仅旧策略覆盖 → 无共同支持 =====
    {
      id: 'S-306', deviceId: 'FS-406', regionId: 'RG-SUB', deviceType: 'flow_sensor',
      startDay: 10, startH: 7, construction: false, shift: 'light', band: 'low', closeH: 4, peak: 6,
      members: [ { h: 0.4, kind: 'missing', severity: 'minor', concentration: 6 } ],
      rectification: { dueH: 4, receiptH: 4, status: 'done', note: '旧策略低风险按期' },
    },
    {
      id: 'S-308', deviceId: 'PS-408', regionId: 'RG-SUB', deviceType: 'pressure_sensor',
      startDay: 10, startH: 12, construction: false, shift: 'light', band: 'low', closeH: 5, peak: 7,
      members: [ { h: 0.5, kind: 'missing', severity: 'minor', concentration: 7 } ],
      rectification: { dueH: 5, receiptH: 5, status: 'done', note: '低风险按期' },
    },
  ];
  return specs.map(buildSample);
}

export function buildSafetyConfig(): SafetyConfig {
  return {
    keyRetentionFloor: 0.95, // 关键原始告警保留率安全下限
    minOverlapCoefficient: 0.6, // 共同支持最低重叠
    minCellSupport: 1,
    riskConcentrationThreshold: 18, // 高浓度直达人工阈值（%LEL）
    lateEscalationSlaMin: 120, // 延迟升级 SLA
    rectificationGraceMin: 60,
    confidenceLevel: 0.95,
  };
}

export function buildSafetyDataset(): SafetyDataset {
  return {
    frozenAt: FROZEN_AT,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    labelCutoffAt: LABEL_CUTOFF,
    policySwitchAt: POLICY_SWITCH_AT,
    policies: buildSafetyPolicies(),
    ruleVersions: buildSafetyRuleVersions(),
    regions: buildSafetyRegions(),
    ledgerRevisions: buildLedgerRevisions(),
    samples: buildSafetySamples(),
    config: buildSafetyConfig(),
  };
}
