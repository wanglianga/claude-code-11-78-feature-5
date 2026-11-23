// ============================================================
// 安全界限计算器：分层展示
//   - 关键原始告警保留率（Wilson 区间 + 安全下限）
//   - 延迟升级率（新旧臂 Wilson 区间）
//   - 确认风险的最长可见延迟
//   - 复测资源占用
//   - 效应差值的 Newcombe 区间（仅可比层）
// 所有对比只标注为“关联性估计”，不宣称未执行策略的真实收益。
// ============================================================

import type {
  DelayedLabel,
  EffectEstimate,
  EscalationRateMetric,
  Interval,
  MaxDelayMetric,
  RiskTier,
  RetentionMetric,
  RetestResourceMetric,
  SafetyConfig,
  SafetyDataset,
  SafetyMetrics,
  SampleLedgerRecord,
  StratumSafetyMetrics,
} from './safetyTypes';
import { newcombeDifference, wilsonInterval, zFor } from './safetyStats';

const STRATA: RiskTier[] = ['R1', 'R2', 'R3'];

type Arm = 'old' | 'new' | 'all';

function retentionOf(
  dataset: SafetyDataset,
  rows: SampleLedgerRecord[],
  policyVersionId: string,
  tier: RiskTier,
  config: SafetyConfig,
  z: number,
): RetentionMetric {
  let keyTotal = 0;
  let keyRetained = 0;
  for (const row of rows) {
    const sample = dataset.samples.find((s) => s.id === row.sampleId)!;
    for (const m of sample.members) {
      if (!m.key || m.policyVersionId !== policyVersionId) continue;
      keyTotal += 1;
      if (m.retainedRaw) keyRetained += 1;
    }
  }
  const interval = wilsonInterval(keyRetained, keyTotal, z);
  const belowFloor = keyTotal > 0 && interval.point < config.keyRetentionFloor;
  const ciCrossesFloor = keyTotal > 0 && interval.lower < config.keyRetentionFloor;
  return {
    stratum: tier,
    policyVersionId,
    keyTotal,
    keyRetained,
    interval,
    floor: config.keyRetentionFloor,
    belowFloor,
    ciCrossesFloor,
    passed: !belowFloor && !ciCrossesFloor,
  };
}

function armIds(samples: string[], labels: DelayedLabel[], arm: Arm): string[] {
  if (arm === 'all') return samples;
  return samples.filter((id) => {
    const l = labels.find((x) => x.sampleId === id);
    if (!l) return false;
    const slices = l.exposureByPolicyVersion;
    if (slices.length !== 1) return false; // 混合暴露不计入单臂
    return arm === 'new' ? slices[0].policyVersionId === 'SP-2026.2' : slices[0].policyVersionId === 'SP-2026.1';
  });
}

function escalationOf(
  ids: string[],
  labels: DelayedLabel[],
  tier: RiskTier,
  arm: Arm,
  z: number,
): EscalationRateMetric {
  let positiveCount = 0;
  let negativeCount = 0;
  let censoredCount = 0;
  for (const id of ids) {
    const l = labels.find((x) => x.sampleId === id);
    if (!l) continue;
    if (l.status === 'positive') positiveCount += 1;
    else if (l.status === 'negative') negativeCount += 1;
    else censoredCount += 1;
  }
  const analyzed = positiveCount + negativeCount; // 删失不计入分母（不按未发生风险计零）
  return {
    stratum: tier,
    arm,
    positiveCount,
    negativeCount,
    censoredCount,
    analyzedCount: analyzed,
    interval: wilsonInterval(positiveCount, analyzed, z),
    interpretation: 'association_estimate',
  };
}

function maxDelayOf(
  ids: string[],
  labels: DelayedLabel[],
  tier: RiskTier,
): MaxDelayMetric | null {
  let best: MaxDelayMetric | null = null;
  for (const id of ids) {
    const l = labels.find((x) => x.sampleId === id);
    if (!l || l.delayMin === null) continue;
    if (!best || l.delayMin > best.delayMin) {
      const sig = l.signals.find((s) => s.at === l.earliestSignalAt) ?? null;
      best = { stratum: tier, sampleId: id, delayMin: l.delayMin, signalType: sig?.type ?? null };
    }
  }
  return best;
}

function retestResourceOf(
  dataset: SafetyDataset,
  ids: string[],
  tier: RiskTier,
  arm: Arm,
): RetestResourceMetric {
  let retestCount = 0;
  let resourceMinutes = 0;
  let samples = 0;
  for (const id of ids) {
    const sample = dataset.samples.find((s) => s.id === id);
    if (!sample) continue;
    let counted = false;
    for (const ev of sample.downstream) {
      if (ev.type !== 'retest') continue;
      retestCount += 1;
      resourceMinutes += ev.resourceMin ?? 0;
      counted = true;
    }
    if (counted) samples += 1;
  }
  return {
    stratum: tier,
    arm,
    retestCount,
    resourceMinutes,
    samples,
    minutesPer100Samples: samples > 0 ? +((resourceMinutes / samples) * 100).toFixed(1) : 0,
    interpretation: 'association_estimate',
  };
}

function effectOf(
  newMetric: EscalationRateMetric,
  oldMetric: EscalationRateMetric,
  comparable: boolean,
  blockedReason: string | null,
  z: number,
): EffectEstimate {
  if (!comparable) {
    return {
      stratum: newMetric.stratum,
      newRate: newMetric.interval.point,
      oldRate: oldMetric.interval.point,
      difference: 0,
      interval: {
        point: 0,
        lower: -1,
        upper: 1,
        method: '不可比较：共同支持不足',
        n: newMetric.analyzedCount + oldMetric.analyzedCount,
        k: newMetric.positiveCount + oldMetric.positiveCount,
      },
      interpretation: 'association_estimate',
      computed: false,
      blockedReason,
    };
  }
  const interval = newcombeDifference(
    newMetric.positiveCount,
    newMetric.analyzedCount,
    oldMetric.positiveCount,
    oldMetric.analyzedCount,
    z,
  );
  return {
    stratum: newMetric.stratum,
    newRate: newMetric.interval.point,
    oldRate: oldMetric.interval.point,
    difference: interval.point,
    interval,
    interpretation: 'association_estimate',
    computed: true,
    blockedReason: null,
  };
}

export function computeSafetyMetrics(
  dataset: SafetyDataset,
  ledger: SampleLedgerRecord[],
  labels: DelayedLabel[],
  cohort: { strata: Array<{ riskTier: RiskTier; comparable: boolean; blockingReasons: string[] }>; aggregateComparable: boolean; aggregateBlockedReasons: string[] },
  config: SafetyConfig,
): SafetyMetrics {
  const z = zFor(config.confidenceLevel);
  const strataMetrics: StratumSafetyMetrics[] = [];

  for (const tier of STRATA) {
    const rows = ledger.filter((l) => l.initialRiskTier === tier);
    const stratumCohort = cohort.strata.find((s) => s.riskTier === tier)!;
    const ids = rows.map((r) => r.sampleId);

    const retentionNew = retentionOf(dataset, rows, 'SP-2026.2', tier, config, z);
    const retentionOld = retentionOf(dataset, rows, 'SP-2026.1', tier, config, z);
    // 分层安全界限以新策略保留率为准（旧策略保留全部关键告警时作为对照）
    const delayed = escalationOf(armIds(ids, labels, 'new'), labels, tier, 'new', z);
    const oldEsc = escalationOf(armIds(ids, labels, 'old'), labels, tier, 'old', z);
    const maxDelay = maxDelayOf(ids, labels, tier);
    const retestNew = retestResourceOf(dataset, armIds(ids, labels, 'new'), tier, 'new');
    const retestOld = retestResourceOf(dataset, armIds(ids, labels, 'old'), tier, 'old');
    const blockedReason = stratumCohort.comparable
      ? null
      : stratumCohort.blockingReasons.join('；');

    strataMetrics.push({
      riskTier: tier,
      retention: retentionNew,
      retentionOld,
      delayedEscalation: delayed,
      oldEscalation: oldEsc,
      maxVisibleDelay: maxDelay,
      retestNew,
      retestOld,
      effect: effectOf(delayed, oldEsc, stratumCohort.comparable, blockedReason, z),
    });
  }

  // 总体（全分层合并）：关键保留率、延迟升级率、最长延迟、复测资源、删失
  const allIds = ledger.map((l) => l.sampleId);
  const keyAll = escalationOf(allIds, labels, 'R1', 'all', z);
  // 总体新策略保留率（成员暴露按各自实际策略版本计入）
  const newRetentionAll = retentionOf(dataset, ledger, 'SP-2026.2', 'R1', config, z);
  const overallRetention: RetentionMetric = {
    ...newRetentionAll,
    stratum: 'R1',
  };

  const overallMaxDelay = maxDelayOf(allIds, labels, 'R1');
  const overallRetest = retestResourceOf(dataset, allIds, 'R1', 'all');
  const censoredSamples = labels.filter((l) => l.status === 'censored').map((l) => l.sampleId);
  const newAll = escalationOf(armIds(allIds, labels, 'new'), labels, 'R1', 'new', z);
  const oldAll = escalationOf(armIds(allIds, labels, 'old'), labels, 'R1', 'old', z);

  const aggregateEffect: EffectEstimate = {
    stratum: 'ALL',
    newRate: newAll.interval.point,
    oldRate: oldAll.interval.point,
    difference: 0,
    interval: cohort.aggregateComparable
      ? newcombeDifference(newAll.positiveCount, newAll.analyzedCount, oldAll.positiveCount, oldAll.analyzedCount, z)
      : { point: 0, lower: -1, upper: 1, method: '不可比较：存在无共同支持的风险层', n: newAll.analyzedCount + oldAll.analyzedCount, k: newAll.positiveCount + oldAll.positiveCount },
    interpretation: 'association_estimate',
    computed: cohort.aggregateComparable,
    blockedReason: cohort.aggregateComparable ? null : cohort.aggregateBlockedReasons.join('；'),
  };
  if (cohort.aggregateComparable) {
    aggregateEffect.difference = aggregateEffect.interval.point;
  }

  return {
    strata: strataMetrics,
    overall: {
      keyRetention: overallRetention,
      delayedEscalation: keyAll,
      maxVisibleDelay: overallMaxDelay,
      retestResource: overallRetest,
      censoredCount: censoredSamples.length,
      censoredSamples,
    },
    aggregateEffect,
    interpretation: 'association_estimate',
  };
}

export { wilsonInterval, newcombeDifference, zFor };
export type { Interval, Arm };
