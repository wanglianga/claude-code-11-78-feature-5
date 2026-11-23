// ============================================================
// 安全门禁编排器：
//   - 评估合格的策略只允许用于“建议性排序”；
//   - 任一分层关键原始告警保留率低于安全下限、或其不确定区间跨越下限
//     → 回退为仅展示建议、禁止扩大覆盖；
//   - 风险层内新旧策略无共同支持 → 不可比较并阻止总效应汇总；
//   - 原始高浓度 / 证据冲突事件始终直达人工队列（不受任何开关影响）。
//
// 本批次不执行灰度：覆盖扩大一律不开放，灰度仅登记为后续验证路径。
// ============================================================

import type {
  CohortResult,
  GateResult,
  GateRule,
  ManualQueueItem,
  SafetyConfig,
  SafetyDataset,
  SafetyMetrics,
  SampleLedgerRecord,
} from './safetyTypes';

export function buildGate(
  _dataset: SafetyDataset,
  ledger: SampleLedgerRecord[],
  metrics: SafetyMetrics,
  cohort: CohortResult,
  config: SafetyConfig,
): GateResult {
  const rules: GateRule[] = [];

  // 规则 1：逐层关键原始告警保留率安全界限
  for (const s of metrics.strata) {
    const r = s.retention;
    const passed = r.passed;
    rules.push({
      id: `G-RET-${s.riskTier}`,
      name: `${s.riskTier} 层关键原始告警保留率安全界限`,
      passed,
      detail:
        r.keyTotal === 0
          ? `${s.riskTier} 层无关键原始告警或新策略未覆盖，保留率不可估计`
          : `新策略保留 ${r.keyRetained}/${r.keyTotal}=${(r.interval.point * 100).toFixed(1)}%，` +
            `区间 [${(r.interval.lower * 100).toFixed(1)}%, ${(r.interval.upper * 100).toFixed(1)}%]，` +
            `下限 ${(r.floor * 100).toFixed(0)}%` +
            (r.belowFloor ? '（点估计低于下限）' : '') +
            (r.ciCrossesFloor ? '（区间跨越下限）' : ''),
    });
  }

  // 规则 2：原始高浓度 / 证据冲突直达人工队列（结构性保证）
  const manualQueue: ManualQueueItem[] = [];
  for (const row of ledger) {
    const high = row.peakConcentration >= config.riskConcentrationThreshold;
    const conflict = row.evidenceConflict;
    if (!high && !conflict) continue;
    manualQueue.push({
      sampleId: row.sampleId,
      reason: high && conflict ? 'both' : high ? 'high_concentration' : 'evidence_conflict',
      detail:
        `峰值 ${row.peakConcentration}%LEL（阈值 ${config.riskConcentrationThreshold}）` +
        (conflict ? '；证据冲突' : '') +
        '：绕过排序建议，直达人工队列',
    });
  }
  rules.push({
    id: 'G-MANUAL',
    name: '原始高浓度 / 证据冲突事件直达人工队列',
    passed: manualQueue.length > 0,
    detail: `${manualQueue.length} 个事件被强制置顶人工队列（阈值 ${config.riskConcentrationThreshold}%LEL 或证据冲突）`,
  });

  // 规则 3：共同支持 / 可比较性
  for (const s of cohort.strata) {
    rules.push({
      id: `G-COH-${s.riskTier}`,
      name: `${s.riskTier} 层新旧策略共同支持`,
      passed: s.comparable,
      detail: s.comparable
        ? `匹配 ${s.matchedPairs} 对，重叠系数 ${s.overlapCoefficient}`
        : s.blockingReasons.join('；'),
    });
  }

  // 规则 4：右删失不得计零
  const censoredZeroBug =
    metrics.overall.censoredSamples.length > 0 && metrics.overall.delayedEscalation.analyzedCount === 0;
  rules.push({
    id: 'G-CENSOR',
    name: '右删失样本不计入分母、不按未发生风险计零',
    passed: !censoredZeroBug,
    detail: `${metrics.overall.censoredCount} 个样本保留右删失${metrics.overall.censoredSamples.length ? `（${metrics.overall.censoredSamples.join('、')}）` : ''}，未计入延迟升级率分母`,
  });

  // 规则 5：总效应可比性
  rules.push({
    id: 'G-AGG',
    name: '分层可比较方可汇总总效应',
    passed: cohort.aggregateComparable,
    detail: cohort.aggregateComparable
      ? '全部风险层共同支持充分，可汇总关联性总效应'
      : `阻止总效应汇总：${cohort.aggregateBlockedReasons.join('；')}`,
  });

  const retentionFails = metrics.strata.filter((s) => !s.retention.passed);
  const anyRetentionFail = retentionFails.length > 0;

  let verdict: GateResult['verdict'];
  if (anyRetentionFail) verdict = 'advisory_only';
  else if (!cohort.aggregateComparable) verdict = 'blocked';
  else verdict = 'pass';

  const allRulesPassed = rules.every((r) => r.passed);
  const recommendationMode =
    verdict === 'pass'
      ? '评估合格：新策略仅可用于建议性排序；覆盖扩大须先执行分层随机灰度'
      : verdict === 'advisory_only'
        ? (allRulesPassed
            ? '回退为仅展示建议：关键原始告警保留率安全界限未达标，禁止扩大压缩覆盖'
            : '回退为仅展示建议：存在未过门禁项，禁止扩大压缩覆盖')
        : '阻止总效应汇总：存在风险层无共同支持，仅可比层可作建议性排序';

  return {
    verdict,
    advisoryRankingAllowed: true, // 合格策略仅用于建议性排序
    coverageExpansionAllowed: false, // 本批次未执行灰度，一律不开放覆盖扩大
    blockAggregateEffect: !cohort.aggregateComparable || anyRetentionFail,
    rules,
    manualQueue,
    recommendationMode,
  };
}
