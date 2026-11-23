// ============================================================
// 可比队列构造器：在同一风险层、施工状态、设备类型、浓度区间与
// 班次负荷内匹配新旧策略覆盖事件，并显式报告未匹配样本与重叠不足。
//
// 风险层内新旧策略几乎无共同支持时输出“不可比较”，并阻止总效应汇总。
// 混合策略暴露的事件不强行归入任一臂，按成员时间拆分后单独报告。
// ============================================================

import type {
  CohortCell,
  CohortResult,
  DelayedLabel,
  RiskTier,
  SafetyConfig,
  SafetyDataset,
  SampleLedgerRecord,
  StratumCohort,
  UnmatchedSample,
} from './safetyTypes';

const STRATA: RiskTier[] = ['R1', 'R2', 'R3'];

function cellKeyOf(l: SampleLedgerRecord): string {
  return [
    l.initialRiskTier,
    l.constructionState,
    l.deviceType,
    l.concentrationBand,
    l.shiftLoad,
  ].join('|');
}

export interface ArmAssignment {
  arm: 'old' | 'new' | 'mixed' | 'excluded';
  detail: string;
}

/** 依据成员时间暴露判定所属策略臂；跨版暴露不归入任何单一臂 */
export function assignArm(
  dataset: SafetyDataset,
  ledger: SampleLedgerRecord,
  label: DelayedLabel,
): ArmAssignment {
  if (ledger.evidenceConflict || ledger.peakConcentration >= dataset.config.riskConcentrationThreshold) {
    return {
      arm: 'excluded',
      detail: `证据冲突或峰值 ${ledger.peakConcentration}%LEL ≥ 人工直达阈值，不进入压缩覆盖比较`,
    };
  }
  const slices = label.exposureByPolicyVersion;
  if (slices.length > 1) {
    return {
      arm: 'mixed',
      detail: `生命周期跨策略换版，成员暴露拆分为 ${slices
        .map((s) => `${s.policyVersionId}×${s.memberCount}`)
        .join('、')}，不以关闭时版本覆盖`,
    };
  }
  return slices[0]?.policyVersionId === 'SP-2026.2'
    ? { arm: 'new', detail: '全部成员告警暴露于新策略 SP-2026.2' }
    : { arm: 'old', detail: '全部成员告警暴露于旧策略 SP-2026.1' };
}

export function buildCohort(
  dataset: SafetyDataset,
  ledger: SampleLedgerRecord[],
  labels: DelayedLabel[],
  config: SafetyConfig,
): CohortResult {
  const labelById = new Map(labels.map((l) => [l.sampleId, l]));
  const strata: StratumCohort[] = [];
  const globalUnmatched: UnmatchedSample[] = [];
  let excludedMixedCount = 0;

  for (const tier of STRATA) {
    const rows = ledger.filter((l) => l.initialRiskTier === tier);
    const unmatched: UnmatchedSample[] = [];
    const cells = new Map<string, { oldIds: string[]; newIds: string[]; row: SampleLedgerRecord }>();
    let oldTotal = 0;
    let newTotal = 0;

    for (const row of rows) {
      const label = labelById.get(row.sampleId)!;
      const assignment = assignArm(dataset, row, label);
      if (assignment.arm === 'excluded') {
        unmatched.push({
          sampleId: row.sampleId,
          arm: 'excluded',
          reason: 'excluded_manual_queue',
          detail: assignment.detail,
        });
        continue;
      }
      if (assignment.arm === 'mixed') {
        excludedMixedCount += 1;
        unmatched.push({
          sampleId: row.sampleId,
          arm: 'excluded',
          reason: 'mixed_policy_exposure_split',
          detail: assignment.detail,
        });
        continue;
      }
      const key = cellKeyOf(row);
      const cell = cells.get(key) ?? { oldIds: [], newIds: [], row };
      if (assignment.arm === 'old') {
        cell.oldIds.push(row.sampleId);
        oldTotal += 1;
      } else {
        cell.newIds.push(row.sampleId);
        newTotal += 1;
      }
      cells.set(key, cell);
    }

    const cohortCells: CohortCell[] = [];
    let matchedPairs = 0;
    for (const [key, cell] of [...cells.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const pairs = Math.min(cell.oldIds.length, cell.newIds.length);
      matchedPairs += pairs;
      cohortCells.push({
        cellKey: key,
        riskTier: tier,
        constructionState: cell.row.constructionState,
        deviceType: cell.row.deviceType,
        concentrationBand: cell.row.concentrationBand,
        shiftLoad: cell.row.shiftLoad,
        oldCount: cell.oldIds.length,
        newCount: cell.newIds.length,
        matchedPairs: pairs,
      });
      // 显式报告未匹配样本
      const surplusOld = cell.oldIds.slice(pairs).map((id) => ({
        sampleId: id,
        arm: 'old' as const,
        reason: 'no_new_counterpart_in_cell' as const,
        detail: `单元 ${key} 无新策略对照组`,
      }));
      const surplusNew = cell.newIds.slice(pairs).map((id) => ({
        sampleId: id,
        arm: 'new' as const,
        reason: 'no_old_counterpart_in_cell' as const,
        detail: `单元 ${key} 无旧策略对照组`,
      }));
      const isolatedOld = cell.newIds.length === 0
        ? cell.oldIds.map((id) => ({
            sampleId: id,
            arm: 'old' as const,
            reason: 'no_new_counterpart_in_cell' as const,
            detail: `单元 ${key} 仅旧策略覆盖`,
          }))
        : [];
      const isolatedNew = cell.oldIds.length === 0
        ? cell.newIds.map((id) => ({
            sampleId: id,
            arm: 'new' as const,
            reason: 'no_old_counterpart_in_cell' as const,
            detail: `单元 ${key} 仅新策略覆盖`,
          }))
        : [];
      const reported = cell.oldIds.length > 0 && cell.newIds.length > 0
        ? [...surplusOld, ...surplusNew]
        : [...isolatedOld, ...isolatedNew];
      unmatched.push(...reported);
    }

    const supportBase = Math.min(oldTotal, newTotal);
    const overlapCoefficient = supportBase > 0 ? +(matchedPairs / supportBase).toFixed(4) : 0;
    const commonSupport = supportBase > 0 && matchedPairs > 0;
    const blocking: string[] = [];
    if (oldTotal === 0 || newTotal === 0) {
      blocking.push(`风险层 ${tier} 仅单臂覆盖（旧 ${oldTotal} / 新 ${newTotal}），无共同支持`);
    } else if (matchedPairs === 0) {
      blocking.push(`风险层 ${tier} 新旧策略无同单元匹配，无共同支持`);
    } else if (overlapCoefficient < config.minOverlapCoefficient) {
      blocking.push(
        `风险层 ${tier} 重叠系数 ${overlapCoefficient} < 下限 ${config.minOverlapCoefficient}，共同支持不足`,
      );
    }

    const treatedSamples = [...cells.values()].flatMap((c) => c.newIds).filter(Boolean);
    const controlSamples = [...cells.values()].flatMap((c) => c.oldIds).filter(Boolean);
    strata.push({
      riskTier: tier,
      oldSamples: oldTotal,
      newSamples: newTotal,
      matchedPairs,
      overlapCoefficient,
      commonSupport,
      comparable: blocking.length === 0,
      cells: cohortCells,
      unmatched,
      blockingReasons: blocking,
      treatedSamples,
      controlSamples,
    });
  }

  const blocking = strata.filter((s) => !s.comparable);
  const aggregateComparable = blocking.length === 0;
  const aggregateBlockedReasons = blocking.flatMap((s) => s.blockingReasons);
  globalUnmatched.push(...strata.flatMap((s) => s.unmatched));

  return {
    mode: 'historical_comparability',
    strata,
    unmatchedAll: globalUnmatched,
    aggregateComparable,
    aggregateBlockedReasons,
    excludedMixedCount,
  };
}
