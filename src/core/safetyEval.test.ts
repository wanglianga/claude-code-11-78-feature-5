// ============================================================
// Vitest：压缩策略安全评估工作台
// 覆盖冻结铁律、右删失、按成员时间的暴露拆分、共同支持与门禁回退，
// 以及评估产物在 IndexedDB 上的落盘 / 回读。
// ============================================================

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSafetyDataset } from './safetyScenario';
import { evaluateSafety } from './safetyEval';
import { runSafetyChecks } from './safetyCheck';
import { buildSampleLedger } from './safetyLedger';
import { wilsonInterval, newcombeDifference } from './safetyStats';
import { resetAll } from './db';
import { repository } from './repository';

const dataset = buildSafetyDataset();
const evaluation = evaluateSafety(dataset);

describe('安全评估：冻结账本与结果归因', () => {
  it('观察起点冻结当时可见成员，且起点后台账修订只留档不参与分层', () => {
    const ledger = buildSampleLedger(dataset);
    const withMembers = ledger.filter((l) => l.memberCount > 0);
    expect(withMembers.length).toBeGreaterThan(0);
    // 所有可见成员到达时间均早于观察起点
    for (const l of ledger) {
      for (const m of l.visibleMembers) {
        expect(new Date(m.arrivedAt).getTime()).toBeLessThanOrEqual(new Date(l.observationStart).getTime());
      }
    }
    // 工业园/城南样本带起点后修订留档，初始层沿用冻结快照
    const ind = ledger.find((l) => l.sampleId === 'S-310')!;
    expect(ind.ignoredPostStartRevisions).toContain('LR-001');
    expect(ind.initialRiskTier).toBe('R2'); // 起点前冻结层，未受 11-12 上调影响
    const sub = ledger.find((l) => l.sampleId === 'S-306')!;
    expect(sub.ignoredPostStartRevisions).toContain('LR-002');
    expect(sub.initialRiskTier).toBe('R1');
  });

  it('标签截止后到达整改回执保留右删失，不按未发生风险计零', () => {
    const censored = evaluation.labels.filter((l) => l.status === 'censored');
    expect(censored.map((l) => l.sampleId).sort()).toEqual(['S-311', 'S-403']);
    for (const c of censored) expect(c.censoredReason).toBeTruthy();
    const overall = evaluation.metrics.overall.delayedEscalation;
    // 分母不含删失
    expect(overall.analyzedCount).toBe(overall.positiveCount + overall.negativeCount);
    expect(overall.censoredCount).toBe(censored.length);
  });

  it('生命周期跨策略换版时按成员时间拆分暴露，不以关闭时版本覆盖', () => {
    const mixed = evaluation.labels.filter((l) => l.exposureByPolicyVersion.length > 1);
    expect(mixed.length).toBeGreaterThanOrEqual(2);
    for (const l of mixed) {
      const memberSum = l.exposureByPolicyVersion.reduce((a, s) => a + s.memberCount, 0);
      const visible = evaluation.ledger.find((x) => x.sampleId === l.sampleId)!.visibleMembers.length;
      expect(memberSum).toBe(visible);
      expect(l.closeTimePolicyVersion).toBe('SP-2026.2');
    }
    // S-201：换版前成员应记在 SP-2026.1
    const s201 = evaluation.labels.find((l) => l.sampleId === 'S-201')!;
    expect(s201.exposureByPolicyVersion.map((s) => s.policyVersionId).sort()).toEqual([
      'SP-2026.1',
      'SP-2026.2',
    ]);
  });

  it('不依赖起点后台账修订打标签（exposureBasis / stratificationBasis 显式声明）', () => {
    for (const l of evaluation.labels) {
      expect(l.usedPostStartLedgerRevision).toBe(false);
      expect(l.stratificationBasis).toBe('frozen_pre_start_snapshot');
      expect(l.exposureBasis).toBe('member_time');
    }
  });
});

describe('安全评估：可比队列与门禁', () => {
  it('同一风险层无共同支持时输出不可比较并显式报告未匹配样本', () => {
    const r1 = evaluation.cohort.strata.find((s) => s.riskTier === 'R1')!;
    expect(r1.comparable).toBe(false);
    expect(r1.newSamples).toBe(0);
    expect(r1.blockingReasons.join('')).toContain('无共同支持');
    expect(evaluation.cohort.unmatchedAll.some((u) => u.reason === 'mixed_policy_exposure_split')).toBe(true);
    expect(evaluation.cohort.unmatchedAll.length).toBeGreaterThan(0);
  });

  it('R3 层在新旧策略间存在共同支持并给出重叠系数', () => {
    const r3 = evaluation.cohort.strata.find((s) => s.riskTier === 'R3')!;
    expect(r3.comparable).toBe(true);
    expect(r3.matchedPairs).toBeGreaterThan(0);
    expect(r3.overlapCoefficient).toBeGreaterThan(0);
  });

  it('存在无共同支持层时阻止总效应汇总', () => {
    expect(evaluation.cohort.aggregateComparable).toBe(false);
    expect(evaluation.metrics.aggregateEffect.computed).toBe(false);
    expect(evaluation.gate.blockAggregateEffect).toBe(true);
  });

  it('关键保留率低于下限的分层触发表决回退为仅展示建议、禁止扩大覆盖', () => {
    const failing = evaluation.metrics.strata.filter((s) => !s.retention.passed);
    expect(failing.length).toBeGreaterThan(0);
    expect(evaluation.gate.verdict).toBe('advisory_only');
    expect(evaluation.gate.advisoryRankingAllowed).toBe(true);
    expect(evaluation.gate.coverageExpansionAllowed).toBe(false);
  });

  it('原始高浓度 / 证据冲突事件直达人工队列且不受开关影响', () => {
    const ids = evaluation.gate.manualQueue.map((m) => m.sampleId);
    expect(ids).toContain('S-104'); // 峰值 24%LEL 证据冲突
    expect(ids).toContain('S-501');
    expect(evaluation.gate.manualQueue.every((m) => m.reason !== undefined)).toBe(true);
  });

  it('灰度实验仅登记为后续验证路径并保留接入点', () => {
    expect(evaluation.grayRegistration.executed).toBe(false);
    expect(evaluation.grayRegistration.status).toBe('registered');
    expect(evaluation.grayRegistration.constraints.suppressKeyAlerts).toBe(false);
    expect(evaluation.grayIngest.status).toBe('awaiting_trajectory');
    expect(evaluation.grayIngest.path).toBe('gray-trajectory');
  });

  it('所有时效/复测/漏报指标均标注为关联性估计', () => {
    expect(evaluation.metrics.interpretation).toBe('association_estimate');
    expect(evaluation.metrics.aggregateEffect.interpretation).toBe('association_estimate');
    for (const s of evaluation.metrics.strata) {
      expect(s.effect.interpretation).toBe('association_estimate');
      expect(s.delayedEscalation.interpretation).toBe('association_estimate');
      expect(s.retestNew.interpretation).toBe('association_estimate');
    }
  });

  it('区间估计：Wilson 与 Newcombe 落在合理边界内', () => {
    const w = wilsonInterval(2, 10, 1.959964);
    expect(w.lower).toBeGreaterThan(0);
    expect(w.upper).toBeLessThanOrEqual(1);
    const n = newcombeDifference(4, 5, 1, 4, 1.959964);
    expect(n.point).toBeCloseTo(0.55, 6);
    expect(n.lower).toBeGreaterThanOrEqual(-1);
    expect(n.upper).toBeLessThanOrEqual(1);
  });

  it('全部安全自检断言通过', () => {
    const checks = runSafetyChecks(evaluation);
    const failed = checks.filter((c) => !c.passed);
    for (const f of failed) console.error(`安全自检失败 ${f.id}: ${f.detail}`);
    expect(failed).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(21);
  });
});

describe('安全评估产物落盘', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('评估产物保存到 IndexedDB 并可完整回读', async () => {
    await repository.saveSafetyEval(evaluation);
    const row = await repository.loadSafetyEval();
    expect(row?.value.id).toBe(evaluation.id);
    expect(row?.value.ledger.length).toBe(evaluation.ledger.length);
    expect(row?.value.labels.length).toBe(evaluation.labels.length);
    expect(row?.value.gate.verdict).toBe(evaluation.gate.verdict);
    // 回读后自检仍通过
    const checks = runSafetyChecks(row!.value);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it('结构不完整的产物被拒绝落盘', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repository.saveSafetyEval({ id: 'BAD' } as any),
    ).rejects.toThrow();
  });
});
