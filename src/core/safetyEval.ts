// ============================================================
// 安全评估编排：冻结账本 → 结果归因 → 可比队列 → 安全指标 → 门禁
// 纯函数编排（浏览器主线程 / Vitest 复用）。
// 本次只实施历史可比性评估，灰度实验登记为后续验证路径。
// ============================================================

import { attributeAll } from './safetyAttribution';
import { buildCohort } from './safetyCohort';
import { buildGate } from './safetyGate';
import { buildSampleLedger } from './safetyLedger';
import { computeSafetyMetrics } from './safetyMetrics';
import type { SafetyDataset, SafetyEvaluation, GrayTrajectoryRegistration, GrayTrajectoryIngestPoint } from './safetyTypes';

export const GRAY_TRAJECTORY_PATH = 'gray-trajectory';

export function buildGrayRegistration(dataset: SafetyDataset): GrayTrajectoryRegistration {
  return {
    id: 'GRAY-2026-Q4',
    status: 'registered',
    executed: false,
    registeredAt: dataset.frozenAt,
    mode: 'historical_comparability',
    reason:
      '先用冻结历史窗口的倾向匹配/分层重加权做低成本可比性评估；灰度实验成本更高（需更长观察期、受样本量限制）且不得抑制关键原始告警，登记为后续验证路径。',
    constraints: {
      suppressKeyAlerts: false,
      minObservationDays: 21,
      requiredStrata: ['R1', 'R2', 'R3'],
      assignment: 'stratified_random',
    },
    prerequisites: [
      '每个风险层关键原始告警保留率 ≥ 安全下限且不确定区间不跨越下限',
      '分层随机分配低风险排序建议，原始高浓度/证据冲突事件仍直达人工队列',
      '按成员告警当时策略版本拆分暴露，避免换版污染',
      '观察到实际处置时效，观察期不少于 21 天且满足各层最小样本量',
    ],
    nextStep: '历史可比性评估通过门禁后，在低风险排序建议上启动分层随机灰度；时效改善只能标为关联性估计。',
  };
}

export function buildGrayIngest(): GrayTrajectoryIngestPoint {
  return {
    path: GRAY_TRAJECTORY_PATH,
    accepts: 'gray_trajectory.v1（分层随机分配的策略臂、观察窗口、按成员时间的实际处置时效与延迟标签）',
    status: 'awaiting_trajectory',
    note: '接入点预留：灰度实际执行后，将其时间线灌入本工作台以替换历史可比性估计；当前未执行任何灰度。',
  };
}

export function evaluateSafety(dataset: SafetyDataset): SafetyEvaluation {
  const ledgerFrozen = buildSampleLedger(dataset);
  const { labels, ledger } = attributeAll(dataset, ledgerFrozen, 'historical_comparability');
  const config = dataset.config;
  const cohort = buildCohort(dataset, ledger, labels, config);
  const metrics = computeSafetyMetrics(dataset, ledger, labels, cohort, config);
  const gate = buildGate(dataset, ledger, metrics, cohort, config);
  const grayRegistration = buildGrayRegistration(dataset);
  const grayIngest = buildGrayIngest();

  const notes = [
    '本评估只使用冻结历史窗口与观察起点之前可见的台账快照分层。',
    '任何时效改善、复测节省或漏报变化均为关联性估计，不能宣称为未执行策略的真实收益。',
    `标签截止 ${dataset.labelCutoffAt}；截止后到达的整改回执保留右删失。`,
    `策略换版 ${dataset.policySwitchAt}；跨版生命周期按成员时间拆分暴露。`,
    '本次未执行灰度；覆盖扩大门禁关闭，灰度登记为后续验证路径。',
  ];

  return {
    id: `SAFE-${dataset.frozenAt.slice(0, 10)}`,
    dataset: {
      frozenAt: dataset.frozenAt,
      windowStart: dataset.windowStart,
      windowEnd: dataset.windowEnd,
      labelCutoffAt: dataset.labelCutoffAt,
      policySwitchAt: dataset.policySwitchAt,
    },
    policies: dataset.policies,
    ruleVersions: dataset.ruleVersions,
    regions: dataset.regions,
    ledgerRevisions: dataset.ledgerRevisions,
    config,
    ledger,
    labels,
    cohort,
    metrics,
    gate,
    grayRegistration,
    grayIngest,
    notes,
  };
}
