// ============================================================
// 安全评估自检断言：与 Vitest 共用。
// 覆盖冻结铁律、右删失、按成员时间的暴露拆分、共同支持与门禁回退。
// ============================================================

import type { SafetyEvaluation } from './safetyTypes';

export interface SafetyCheckResult {
  id: string;
  dimension: '冻结账本' | '结果归因' | '可比队列' | '安全界限' | '安全门禁';
  name: string;
  passed: boolean;
  detail: string;
}

const ok = (
  id: string,
  dimension: SafetyCheckResult['dimension'],
  name: string,
  detail: string,
): SafetyCheckResult => ({ id, dimension, name, passed: true, detail });
const bad = (
  id: string,
  dimension: SafetyCheckResult['dimension'],
  name: string,
  detail: string,
): SafetyCheckResult => ({ id, dimension, name, passed: false, detail });

export function runSafetyChecks(ev: SafetyEvaluation): SafetyCheckResult[] {
  const r: SafetyCheckResult[] = [];
  const labelsById = new Map(ev.labels.map((l) => [l.sampleId, l]));

  // ---------- 冻结账本 ----------
  const ledgerComplete = ev.ledger.every(
    (l) =>
      l.observationStart &&
      l.frozenAt &&
      l.labelCutoffAt &&
      l.labelAvailableAt &&
      l.policyVersionAtStart &&
      l.ruleVersionAtStart &&
      Array.isArray(l.visibleMembers) &&
      Array.isArray(l.ignoredPostStartRevisions),
  );
  r.push(
    ledgerComplete
      ? ok('SL-1', '冻结账本', '每个候选事件冻结齐全（起点/成员/策略/规则/区域/负荷/时间线/标签可用时间）', `${ev.ledger.length} 个样本账本字段完整`)
      : bad('SL-1', '冻结账本', '每个候选事件冻结齐全', '存在缺失冻结字段的样本'),
  );

  const revisionsIgnored = ev.ledger
    .filter((l) => l.ignoredPostStartRevisions.length > 0)
    .every((l) => {
      const revs = ev.ledgerRevisions.filter((x) =>
        l.ignoredPostStartRevisions.includes(x.id),
      );
      // 起点之后修订的 toTier 不得等于样本冻结层（否则说明被误用）
      return revs.every((rev) => rev.toTier !== l.initialRiskTier || rev.fromTier !== l.initialRiskTier);
    });
  const anyIgnored = ev.ledger.some((l) => l.ignoredPostStartRevisions.length > 0);
  r.push(
    revisionsIgnored && anyIgnored
      ? ok(
          'SL-2',
          '冻结账本',
          '起点后台账修订只留档、不参与初始分层',
          `${ev.ledger.filter((l) => l.ignoredPostStartRevisions.length > 0).length} 个样本留档忽略修订 ${ev.ledgerRevisions.map((x) => `${x.id}:${x.fromTier}→${x.toTier}`).join('、')}`,
        )
      : bad('SL-2', '冻结账本', '起点后台账修订只留档、不参与初始分层', '发现起点后修订影响了初始分层'),
  );

  const visibleNonEmpty = ev.ledger.filter((l) => l.memberCount > 0).length;
  r.push(
    visibleNonEmpty > 0
      ? ok('SL-3', '冻结账本', '观察起点已包含当时可见的成员告警', `${visibleNonEmpty}/${ev.ledger.length} 个样本冻结了可见成员`)
      : bad('SL-3', '冻结账本', '观察起点已包含当时可见的成员告警', '可见成员为空'),
  );

  const labelsFrozen = ev.ledger.every((l) => {
    const lab = labelsById.get(l.sampleId);
    return lab && lab.labelAvailableAt === l.labelAvailableAt;
  });
  r.push(
    labelsFrozen
      ? ok('SL-4', '冻结账本', '标签可用时间已回填并冻结', '账本 labelAvailableAt 与归因结果一致')
      : bad('SL-4', '冻结账本', '标签可用时间已回填并冻结', '标签可用时间不一致'),
  );

  // ---------- 结果归因 ----------
  const censored = ev.labels.filter((l) => l.status === 'censored');
  const censoredReasons = censored.every((l) => (l.censoredReason ?? '').length > 0);
  r.push(
    censored.length > 0 && censoredReasons
      ? ok(
          'SL-5',
          '结果归因',
          '标签截止后回执保留右删失、不按未发生风险计零',
          `${censored.length} 个右删失样本均有删失理由：${censored.map((l) => l.sampleId).join('、')}`,
        )
      : bad(
          'SL-5',
          '结果归因',
          '标签截止后回执保留右删失、不按未发生风险计零',
          censored.length === 0 ? '未检出右删失样本' : '右删失缺少理由',
        ),
  );

  // 右删失不计入分母
  const esc = ev.metrics.overall.delayedEscalation;
  const censoredExcluded = esc.analyzedCount === esc.positiveCount + esc.negativeCount && esc.censoredCount === censored.length;
  r.push(
    censoredExcluded
      ? ok(
          'SL-6',
          '结果归因',
          '右删失样本不计入延迟升级率分母',
          `分析分母 ${esc.analyzedCount}=正例 ${esc.positiveCount}+阴性 ${esc.negativeCount}，删失 ${esc.censoredCount} 单列`,
        )
      : bad('SL-6', '结果归因', '右删失样本不计入延迟升级率分母', '删失被计入分母'),
  );

  // 按成员时间拆分暴露（跨版样本）
  const mixed = ev.labels.filter((l) => l.exposureByPolicyVersion.length > 1);
  const splitOk = mixed.every((l) => {
    const sum = l.exposureByPolicyVersion.reduce((a, s) => a + s.memberCount, 0);
    const visible = ev.ledger.find((x) => x.sampleId === l.sampleId)!.visibleMembers.length;
    return sum === visible && l.closeTimePolicyVersion !== null;
  });
  r.push(
    mixed.length > 0 && splitOk
      ? ok(
          'SL-7',
          '结果归因',
          '生命周期跨版时按成员时间拆分暴露，不以关闭时版本覆盖',
          `${mixed.map((l) => l.sampleId).join('、')} 拆分：${mixed
            .map((l) => l.exposureByPolicyVersion.map((s) => `${s.policyVersionId}×${s.memberCount}`).join('+'))
            .join('；')}`,
        )
      : bad(
          'SL-7',
          '结果归因',
          '生命周期跨版时按成员时间拆分暴露，不以关闭时版本覆盖',
          mixed.length === 0 ? '未构造跨版样本' : '暴露拆分与可见成员不一致',
        ),
  );

  const noPostStartRevision = ev.labels.every((l) => !l.usedPostStartLedgerRevision && l.stratificationBasis === 'frozen_pre_start_snapshot');
  r.push(
    noPostStartRevision
      ? ok('SL-8', '结果归因', '归因不使用起点后台账修订或人工结论回溯分层', '全部标签 exposureBasis=member_time、stratificationBasis=frozen_pre_start')
      : bad('SL-8', '结果归因', '归因不使用起点后台账修订或人工结论回溯分层', '发现回溯分层'),
  );

  // ---------- 可比队列 ----------
  const hasNonComparable = ev.cohort.strata.some((s) => !s.comparable);
  const reportsUnmatched = ev.cohort.unmatchedAll.length > 0;
  r.push(
    hasNonComparable && reportsUnmatched
      ? ok(
          'SL-9',
          '可比队列',
          '无共同支持的风险层输出不可比较并显式报告未匹配样本',
          `${ev.cohort.strata.filter((s) => !s.comparable).map((s) => s.riskTier).join('、')} 不可比较；未匹配 ${ev.cohort.unmatchedAll.length} 条`,
        )
      : bad('SL-9', '可比队列', '无共同支持的风险层输出不可比较并显式报告未匹配样本', '未检出不可比较层或未报告未匹配'),
  );

  const overlapReported = ev.cohort.strata.every((s) => typeof s.overlapCoefficient === 'number');
  r.push(
    overlapReported
      ? ok('SL-10', '可比队列', '重叠系数与共同支持逐层显式给出', ev.cohort.strata.map((s) => `${s.riskTier}:${s.overlapCoefficient}`).join('，'))
      : bad('SL-10', '可比队列', '重叠系数与共同支持逐层显式给出', '缺少重叠信息'),
  );

  const mixedExcluded = ev.cohort.unmatchedAll.some((u) => u.reason === 'mixed_policy_exposure_split');
  r.push(
    mixed.length > 0 && mixedExcluded
      ? ok('SL-11', '可比队列', '跨版暴露样本不强行归入单一策略臂', `混合暴露 ${ev.cohort.excludedMixedCount} 例单独报告`)
      : bad('SL-11', '可比队列', '跨版暴露样本不强行归入单一策略臂', '混合暴露被错误合并'),
  );

  // ---------- 安全界限 ----------
  const allIntervals = ev.metrics.strata.every(
    (s) =>
      typeof s.retention.interval.lower === 'number' &&
      typeof s.delayedEscalation.interval.lower === 'number',
  );
  r.push(
    allIntervals
      ? ok('SL-12', '安全界限', '关键保留率与延迟升级率均带不确定区间', '逐层给出 Wilson 区间')
      : bad('SL-12', '安全界限', '关键保留率与延迟升级率均带不确定区间', '区间缺失'),
  );

  const maxDelayShown = ev.metrics.strata.every((s) => s.maxVisibleDelay !== null) || ev.metrics.overall.maxVisibleDelay !== null;
  r.push(
    maxDelayShown
      ? ok('SL-13', '安全界限', '确认风险的最长可见延迟已计算', `最长 ${ev.metrics.strata.map((s) => s.maxVisibleDelay?.delayMin ?? '—').join('/')} 分钟`)
      : bad('SL-13', '安全界限', '确认风险的最长可见延迟已计算', '未计算最长可见延迟'),
  );

  const retestShown = ev.metrics.strata.every((s) => s.retestNew.interpretation === 'association_estimate');
  r.push(
    retestShown
      ? ok('SL-14', '安全界限', '复测资源占用逐层给出且标注关联性估计', '新/旧臂复测分钟数按样本均值折算')
      : bad('SL-14', '安全界限', '复测资源占用逐层给出', '缺少复测资源'),
  );

  const allAssociation = ev.metrics.interpretation === 'association_estimate' && ev.metrics.aggregateEffect.interpretation === 'association_estimate';
  r.push(
    allAssociation
      ? ok('SL-15', '安全界限', '所有时效/复测/漏报变化仅标为关联性估计', 'interpretation=association_estimate')
      : bad('SL-15', '安全界限', '所有时效/复测/漏报变化仅标为关联性估计', '存在被宣称真实收益的指标'),
  );

  const retentionGateFails = ev.metrics.strata.filter((s) => !s.retention.passed);
  r.push(
    retentionGateFails.length > 0
      ? ok('SL-16', '安全界限', '关键保留率低于下限或其区间跨越下限的分层被标记', retentionGateFails.map((s) => `${s.riskTier}:保留 ${s.retention.keyRetained}/${s.retention.keyTotal}，区间 [${s.retention.interval.lower},${s.retention.interval.upper}]`).join('；'))
      : bad('SL-16', '安全界限', '关键保留率低于下限或其区间跨越下限的分层被标记', '未检出保留率不达标层'),
  );

  // ---------- 安全门禁 ----------
  const verdictFallback = retentionGateFails.length > 0 && ev.gate.verdict === 'advisory_only';
  r.push(
    verdictFallback
      ? ok('SL-17', '安全门禁', '保留率不达安全下限时回退为仅展示建议、禁止扩大覆盖', `verdict=${ev.gate.verdict}，coverageExpansionAllowed=${ev.gate.coverageExpansionAllowed}`)
      : bad('SL-17', '安全门禁', '保留率不达安全下限时回退为仅展示建议、禁止扩大覆盖', `verdict=${ev.gate.verdict}，coverage=${ev.gate.coverageExpansionAllowed}`),
  );

  const noCov = ev.gate.coverageExpansionAllowed === false;
  r.push(
    noCov
      ? ok('SL-18', '安全门禁', '本批次未执行灰度，覆盖扩大一律关闭', `${ev.gate.advisoryRankingAllowed ? '保留建议性排序' : ''}；灰度状态 ${ev.grayRegistration.status}/executed=${ev.grayRegistration.executed}`)
      : bad('SL-18', '安全门禁', '本批次未执行灰度，覆盖扩大一律关闭', '覆盖扩大被错误开放'),
  );

  const manualAlways = ev.gate.manualQueue.length > 0;
  r.push(
    manualAlways
      ? ok('SL-19', '安全门禁', '原始高浓度/证据冲突事件直达人工队列', `${ev.gate.manualQueue.length} 个事件强制置顶：${ev.gate.manualQueue.map((m) => m.sampleId).join('、')}`)
      : bad('SL-19', '安全门禁', '原始高浓度/证据冲突事件直达人工队列', '人工队列为空'),
  );

  const aggBlocked = !ev.cohort.aggregateComparable && ev.metrics.aggregateEffect.computed === false && ev.gate.blockAggregateEffect;
  r.push(
    aggBlocked
      ? ok('SL-20', '安全门禁', '共同支持不足时阻止总效应汇总', `aggregateComparable=${ev.cohort.aggregateComparable}，效应 computed=${ev.metrics.aggregateEffect.computed}`)
      : bad('SL-20', '安全门禁', '共同支持不足时阻止总效应汇总', '总效应被错误汇总'),
  );

  const grayRegistered = ev.grayRegistration.status === 'registered' && ev.grayRegistration.executed === false && ev.grayIngest.status === 'awaiting_trajectory';
  r.push(
    grayRegistered
      ? ok('SL-21', '安全门禁', '灰度实验登记为后续验证路径并保留执行轨迹接入点', `path=${ev.grayIngest.path}，未执行`)
      : bad('SL-21', '安全门禁', '灰度实验登记为后续验证路径并保留执行轨迹接入点', '灰度登记/接入点缺失'),
  );

  return r;
}
