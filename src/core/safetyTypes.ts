// ============================================================
// 压缩策略安全评估工作台：领域类型
// 独立处理“策略是否掩盖应升级风险”的推断问题。本批次只做
// 冻结历史窗口的可比性评估；灰度实验仅登记为后续验证路径。
// 所有时效改善 / 复测节省 / 漏报变化均只能标为关联性估计。
// ============================================================

import type { RuleKind, Severity } from './types';

export type RiskTier = 'R1' | 'R2' | 'R3';
export type DeviceType = 'valve_well' | 'pressure_sensor' | 'flow_sensor';
export type ConstructionState = 'none' | 'active';
export type ConcentrationBand = 'low' | 'mid' | 'high';
export type ShiftLoad = 'light' | 'normal' | 'heavy';

export type AttributionMode = 'historical_comparability';
export type LabelStatus = 'positive' | 'negative' | 'censored';
export type LabelSignalType =
  | 'retest_confirmed'
  | 'high_concentration_recurrence'
  | 'manual_escalation'
  | 'rectification_overdue';

// ---------------- 策略 / 规则 / 区域 -------------
export interface MergePolicy {
  id: string;
  effectiveFrom: string;
  mergeWindowMin: number;
  retainKeyRawAlerts: boolean;
  aggressiveMerge: boolean;
  note: string;
}

export interface EvalRuleVersion {
  id: string;
  publishedAt: string;
  changelog: string;
}

export interface RiskRegion {
  regionId: string;
  name: string;
  riskTierAtFreeze: RiskTier; // 冻结基线（观察窗口开始前的台账快照）
  ledgerVersionAtFreeze: string;
  note: string;
}

/** 观察起点之后发生的台账修订：只能留档，绝不能用于决定样本最初分层 */
export interface LedgerRevision {
  id: string;
  regionId: string;
  at: string;
  fromTier: RiskTier;
  toTier: RiskTier;
  reason: string;
}

// ---------------- 候选事件的成员告警 -------------
export interface SafetyMemberAlert {
  id: string;
  deviceId: string;
  observedAt: string;
  arrivedAt: string;
  kind: RuleKind;
  severity: Severity;
  concentration: number; // 浓度（%LEL 当量）
  key: boolean; // 关键原始告警（critical / 高浓度 / 证据冲突）
  evidenceConflict: boolean;
  /** 实际告警时刻生效的压缩策略版本（换版按成员时间拆分，而非关闭时版本） */
  policyVersionId: string;
  ruleVersionId: string;
  /** 该策略下是否保留为独立原始告警（false = 被折入聚合建议） */
  retainedRaw: boolean;
}

export type DownstreamEventType =
  | 'retest'
  | 'dispatch'
  | 'rectification'
  | 'manual_escalation'
  | 'high_concentration_recurrence';

export interface DownstreamEvent {
  id: string;
  type: DownstreamEventType;
  at: string;
  outcome: 'confirmed' | 'cleared' | 'pending' | 'overdue' | 'on_time';
  note: string;
  /** 复测资源占用（分钟），仅 retest 填写 */
  resourceMin?: number;
  concentration?: number;
}

export interface RectificationTrack {
  dueAt: string;
  /** 回执到达时间；null 表示标签截止时仍未收到 */
  receiptAt: string | null;
  status: 'pending' | 'done';
  note: string;
}

// ---------------- 原始候选事件（冻结前） -------------
export interface CandidateSample {
  id: string;
  deviceId: string;
  regionId: string;
  deviceType: DeviceType;
  constructionState: ConstructionState;
  shiftLoad: ShiftLoad;
  concentrationBand: ConcentrationBand;
  observationStart: string; // 观察起点（冻结后不可变）
  lifecycleStart: string;
  lifecycleClose: string | null; // null = 生命周期尚未关闭（标签截止）
  evidenceConflict: boolean;
  peakConcentration: number;
  members: SafetyMemberAlert[];
  downstream: DownstreamEvent[];
  rectification: RectificationTrack | null;
}

export interface SafetyDataset {
  frozenAt: string;
  windowStart: string;
  windowEnd: string;
  labelCutoffAt: string;
  policySwitchAt: string;
  policies: MergePolicy[];
  ruleVersions: EvalRuleVersion[];
  regions: RiskRegion[];
  ledgerRevisions: LedgerRevision[];
  samples: CandidateSample[];
  config: SafetyConfig;
}

export interface SafetyConfig {
  keyRetentionFloor: number; // 关键原始告警保留率安全下限
  minOverlapCoefficient: number; // 新旧策略共同支持的最低重叠
  minCellSupport: number; // 匹配单元每臂最少样本
  riskConcentrationThreshold: number; // 高浓度直达人工阈值
  lateEscalationSlaMin: number;
  rectificationGraceMin: number;
  confidenceLevel: number;
}

// ---------------- 冻结样本账本 -------------
export interface FrozenMemberRef {
  id: string;
  observedAt: string;
  arrivedAt: string;
  kind: RuleKind;
  severity: Severity;
  key: boolean;
  policyVersionId: string;
}

export interface SampleLedgerRecord {
  sampleId: string;
  deviceId: string;
  regionId: string;
  deviceType: DeviceType;
  constructionState: ConstructionState;
  concentrationBand: ConcentrationBand;
  shiftLoad: ShiftLoad;
  observationStart: string;
  lifecycleStart: string;
  lifecycleClose: string | null;
  // 冻结：观察起点当时可见的成员告警
  visibleMembers: FrozenMemberRef[];
  memberCount: number;
  // 冻结：策略 / 规则版本（按观察起点时刻）
  policyVersionAtStart: string;
  ruleVersionAtStart: string;
  // 冻结：区域风险分层（仅使用观察起点之前的台账快照）
  initialRiskTier: RiskTier;
  riskTierBasis: string;
  ignoredPostStartRevisions: string[];
  // 冻结：后续时间线、标签截止与标签可用时间
  downstreamTimeline: DownstreamEvent[];
  rectification: RectificationTrack | null;
  labelCutoffAt: string;
  labelAvailableAt: string; // 由结果归因器回填并冻结
  evidenceConflict: boolean;
  peakConcentration: number;
  frozenAt: string;
}

// ---------------- 结果归因 -------------
export interface ExposureSlice {
  policyVersionId: string;
  memberCount: number;
  keyMemberCount: number;
  retainedKeyCount: number;
}

export interface LabelSignal {
  type: LabelSignalType;
  at: string;
  delayMin: number; // 相对观察起点的可见延迟
  note: string;
}

export interface DelayedLabel {
  sampleId: string;
  status: LabelStatus;
  signals: LabelSignal[];
  earliestSignalAt: string | null;
  delayMin: number | null; // 最早确认风险的可见延迟
  labelAvailableAt: string;
  cutoffAt: string;
  censoredReason: string | null;
  exposureByPolicyVersion: ExposureSlice[];
  /** 生命周期关闭时生效的策略版本（仅留档，不参与暴露拆分） */
  closeTimePolicyVersion: string | null;
  exposureBasis: 'member_time';
  usedPostStartLedgerRevision: false;
  stratificationBasis: 'frozen_pre_start_snapshot';
}

// ---------------- 可比队列 -------------
export interface CohortCell {
  cellKey: string;
  riskTier: RiskTier;
  constructionState: ConstructionState;
  deviceType: DeviceType;
  concentrationBand: ConcentrationBand;
  shiftLoad: ShiftLoad;
  oldCount: number;
  newCount: number;
  matchedPairs: number;
}

export interface UnmatchedSample {
  sampleId: string;
  arm: 'old' | 'new' | 'excluded';
  reason:
    | 'mixed_policy_exposure_split'
    | 'excluded_manual_queue'
    | 'no_old_counterpart_in_cell'
    | 'no_new_counterpart_in_cell'
    | 'surplus_in_cell';
  detail: string;
}

export interface StratumCohort {
  riskTier: RiskTier;
  oldSamples: number;
  newSamples: number;
  matchedPairs: number;
  overlapCoefficient: number;
  commonSupport: boolean;
  comparable: boolean;
  cells: CohortCell[];
  unmatched: UnmatchedSample[];
  blockingReasons: string[];
  treatedSamples: string[];
  controlSamples: string[];
}

export interface CohortResult {
  mode: AttributionMode;
  strata: StratumCohort[];
  unmatchedAll: UnmatchedSample[];
  aggregateComparable: boolean;
  aggregateBlockedReasons: string[];
  excludedMixedCount: number;
}

// ---------------- 安全指标 -------------
export type MetricInterpretation = 'association_estimate';

export interface Interval {
  point: number;
  lower: number;
  upper: number;
  method: string;
  n: number;
  k: number;
}

export interface RetentionMetric {
  stratum: RiskTier;
  policyVersionId: string;
  keyTotal: number;
  keyRetained: number;
  interval: Interval;
  floor: number;
  belowFloor: boolean;
  ciCrossesFloor: boolean;
  passed: boolean;
}

export interface EscalationRateMetric {
  stratum: RiskTier;
  arm: 'old' | 'new' | 'all';
  positiveCount: number;
  negativeCount: number;
  censoredCount: number;
  analyzedCount: number;
  interval: Interval;
  interpretation: MetricInterpretation;
}

export interface MaxDelayMetric {
  stratum: RiskTier;
  sampleId: string;
  delayMin: number;
  signalType: LabelSignalType | null;
}

export interface RetestResourceMetric {
  stratum: RiskTier;
  arm: 'old' | 'new' | 'all';
  retestCount: number;
  resourceMinutes: number;
  samples: number;
  minutesPer100Samples: number;
  interpretation: MetricInterpretation;
}

export interface EffectEstimate {
  stratum: RiskTier | 'ALL';
  newRate: number;
  oldRate: number;
  difference: number;
  interval: Interval;
  interpretation: MetricInterpretation;
  computed: boolean;
  blockedReason: string | null;
}

export interface StratumSafetyMetrics {
  riskTier: RiskTier;
  retention: RetentionMetric; // 新策略关键原始告警保留率
  retentionOld: RetentionMetric; // 旧策略对照保留率
  delayedEscalation: EscalationRateMetric;
  oldEscalation: EscalationRateMetric;
  maxVisibleDelay: MaxDelayMetric | null;
  retestNew: RetestResourceMetric;
  retestOld: RetestResourceMetric;
  effect: EffectEstimate;
}

export interface SafetyMetrics {
  strata: StratumSafetyMetrics[];
  overall: {
    keyRetention: RetentionMetric;
    delayedEscalation: EscalationRateMetric;
    maxVisibleDelay: MaxDelayMetric | null;
    retestResource: RetestResourceMetric;
    censoredCount: number;
    censoredSamples: string[];
  };
  aggregateEffect: EffectEstimate;
  interpretation: MetricInterpretation;
}

// ---------------- 安全门禁 -------------
export type GateVerdict = 'pass' | 'advisory_only' | 'blocked';

export interface GateRule {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface ManualQueueItem {
  sampleId: string;
  reason: 'high_concentration' | 'evidence_conflict' | 'both';
  detail: string;
}

export interface GateResult {
  verdict: GateVerdict;
  advisoryRankingAllowed: boolean;
  coverageExpansionAllowed: boolean;
  blockAggregateEffect: boolean;
  rules: GateRule[];
  manualQueue: ManualQueueItem[];
  recommendationMode: string;
}

// ---------------- 灰度执行轨迹（接入点，未执行） -------------
export interface GrayTrajectoryRegistration {
  id: string;
  status: 'registered';
  executed: false;
  registeredAt: string;
  mode: AttributionMode;
  reason: string;
  constraints: {
    suppressKeyAlerts: false;
    minObservationDays: number;
    requiredStrata: RiskTier[];
    assignment: 'stratified_random';
  };
  prerequisites: string[];
  nextStep: string;
}

export interface GrayTrajectoryIngestPoint {
  path: string;
  accepts: string;
  status: 'awaiting_trajectory';
  note: string;
}

export interface SafetyRegisterItem {
  sampleId: string;
  deviceId: string;
  regionName: string;
}

// ---------------- 评估总产物 -------------
export interface SafetyEvaluation {
  id: string;
  dataset: {
    frozenAt: string;
    windowStart: string;
    windowEnd: string;
    labelCutoffAt: string;
    policySwitchAt: string;
  };
  policies: MergePolicy[];
  ruleVersions: EvalRuleVersion[];
  regions: RiskRegion[];
  ledgerRevisions: LedgerRevision[];
  config: SafetyConfig;
  ledger: SampleLedgerRecord[];
  labels: DelayedLabel[];
  cohort: CohortResult;
  metrics: SafetyMetrics;
  gate: GateResult;
  grayRegistration: GrayTrajectoryRegistration;
  grayIngest: GrayTrajectoryIngestPoint;
  notes: string[];
}
