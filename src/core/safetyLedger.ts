// ============================================================
// 样本账本：为每个候选事件冻结观察起点、当时可见的成员告警、
// 归并策略与规则版本、区域风险分层、值班负荷、后续复测/派单/
// 整改时间线与标签可用时间。
//
// 铁律：
// 1. 观察起点之后才发生的台账修订只留档，绝不用于决定样本最初分层；
// 2. 标签可用时间由结果归因器回填后冻结。
// ============================================================

import type {
  FrozenMemberRef,
  RiskTier,
  SafetyDataset,
  SampleLedgerRecord,
} from './safetyTypes';

function visibleMembersAt(floorIso: string, sample: SafetyDataset['samples'][number]): FrozenMemberRef[] {
  const floor = new Date(floorIso).getTime();
  return sample.members
    .filter((m) => new Date(m.arrivedAt).getTime() <= floor)
    .map((m) => ({
      id: m.id,
      observedAt: m.observedAt,
      arrivedAt: m.arrivedAt,
      kind: m.kind,
      severity: m.severity,
      key: m.key,
      policyVersionId: m.policyVersionId,
    }));
}

/** 冻结区域风险层：只取观察起点之前发布的台账快照版本 */
function frozenTier(
  dataset: SafetyDataset,
  regionId: string,
  observationStart: string,
): { tier: RiskTier; basis: string; ignored: string[] } {
  const region = dataset.regions.find((r) => r.regionId === regionId);
  if (!region) throw new Error(`未知区域 ${regionId}`);
  const startMs = new Date(observationStart).getTime();
  // 仅在观察起点之前已生效的台账版本方可作为分层依据
  const revisionsAfter = dataset.ledgerRevisions.filter(
    (rev) =>
      rev.regionId === regionId && new Date(rev.at).getTime() > startMs,
  );
  const revisionsBefore = dataset.ledgerRevisions.filter(
    (rev) =>
      rev.regionId === regionId && new Date(rev.at).getTime() <= startMs,
  );
  // 理论上冻结基线在观察起点之前；若起点之后有修订，则以修订前的层级为准
  let tier: RiskTier = region.riskTierAtFreeze;
  for (const rev of revisionsBefore) tier = rev.toTier;
  return {
    tier,
    basis: `区域冻结层 ${tier}（台账 ${region.ledgerVersionAtFreeze}，观察起点前可见）`,
    ignored: revisionsAfter.map((r) => r.id),
  };
}

export function buildSampleLedger(dataset: SafetyDataset): SampleLedgerRecord[] {
  return dataset.samples.map((s) => {
    const { tier, basis, ignored } = frozenTier(dataset, s.regionId, s.observationStart);
    const visible = visibleMembersAt(s.observationStart, s);
    // 观察起点时刻生效的策略 / 规则版本（成员已各自记录其发生时刻的版本）
    const policy = strategyAt(dataset, s.observationStart);
    const rule = ruleAt(dataset, s.observationStart);
    return {
      sampleId: s.id,
      deviceId: s.deviceId,
      regionId: s.regionId,
      deviceType: s.deviceType,
      constructionState: s.constructionState,
      concentrationBand: s.concentrationBand,
      shiftLoad: s.shiftLoad,
      observationStart: s.observationStart,
      lifecycleStart: s.lifecycleStart,
      lifecycleClose: s.lifecycleClose,
      visibleMembers: visible,
      memberCount: visible.length,
      policyVersionAtStart: policy,
      ruleVersionAtStart: rule,
      initialRiskTier: tier,
      riskTierBasis: basis,
      ignoredPostStartRevisions: ignored,
      downstreamTimeline: s.downstream,
      rectification: s.rectification,
      labelCutoffAt: dataset.labelCutoffAt,
      labelAvailableAt: dataset.labelCutoffAt, // 占位，归因器回填后冻结
      evidenceConflict: s.evidenceConflict,
      peakConcentration: s.peakConcentration,
      frozenAt: dataset.frozenAt,
    };
  });
}

function strategyAt(dataset: SafetyDataset, at: string): string {
  const ms = new Date(at).getTime();
  const active = dataset.policies
    .filter((p) => new Date(p.effectiveFrom).getTime() <= ms)
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
  return active[0]?.id ?? dataset.policies[0].id;
}

function ruleAt(dataset: SafetyDataset, at: string): string {
  const ms = new Date(at).getTime();
  const active = dataset.ruleVersions
    .filter((r) => new Date(r.publishedAt).getTime() <= ms)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return active[0]?.id ?? dataset.ruleVersions[0].id;
}
