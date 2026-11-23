// ============================================================
// 结果归因器：将复测确认、后续高浓度重现、人工升级、整改逾期
// 组合为延迟标签。
// 铁律：
// 1. 只使用观察起点之后的处置结果作为标签，绝不用其决定样本最初分层；
// 2. 标签截止后才到达整改回执的事件保留右删失（censored），不按未发生风险计零；
// 3. 策略换版发生在事件生命周期内时，按成员告警当时的策略版本拆分暴露，
//    不以关闭时策略版本覆盖。
// ============================================================

import type {
  AttributionMode,
  DelayedLabel,
  ExposureSlice,
  LabelSignal,
  LabelSignalType,
  SafetyDataset,
  SampleLedgerRecord,
} from './safetyTypes';

const SIGNAL_LABEL: Record<LabelSignalType, string> = {
  retest_confirmed: '复测确认泄漏',
  high_concentration_recurrence: '后续高浓度重现',
  manual_escalation: '人工升级',
  rectification_overdue: '整改逾期',
};

function minutesBetween(a: string, b: string): number {
  return +((new Date(b).getTime() - new Date(a).getTime()) / 60000).toFixed(2);
}

/** 以成员告警时间为基准拆分暴露：跨版事件不得统一记在关闭时版本 */
function splitExposure(dataset: SafetyDataset, ledger: SampleLedgerRecord): ExposureSlice[] {
  const sample = dataset.samples.find((s) => s.id === ledger.sampleId)!;
  const byPolicy = new Map<string, ExposureSlice>();
  for (const m of sample.members) {
    const slice = byPolicy.get(m.policyVersionId) ?? {
      policyVersionId: m.policyVersionId,
      memberCount: 0,
      keyMemberCount: 0,
      retainedKeyCount: 0,
    };
    slice.memberCount += 1;
    if (m.key) {
      slice.keyMemberCount += 1;
      if (m.retainedRaw) slice.retainedKeyCount += 1;
    }
    byPolicy.set(m.policyVersionId, slice);
  }
  return [...byPolicy.values()].sort((a, b) =>
    a.policyVersionId.localeCompare(b.policyVersionId),
  );
}

function closeTimePolicy(dataset: SafetyDataset, ledger: SampleLedgerRecord): string | null {
  if (!ledger.lifecycleClose) return null;
  const ms = new Date(ledger.lifecycleClose).getTime();
  const active = dataset.policies
    .filter((p) => new Date(p.effectiveFrom).getTime() <= ms)
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
  return active[0]?.id ?? null;
}

export function attributeDelayedLabel(
  dataset: SafetyDataset,
  ledger: SampleLedgerRecord,
): DelayedLabel {
  const start = ledger.observationStart;
  const cutoffMs = new Date(ledger.labelCutoffAt).getTime();
  const positiveSignals: LabelSignal[] = [];

  // 1) 复测确认 / 后续高浓度重现 / 人工升级（来自处置时间线）
  for (const ev of ledger.downstreamTimeline) {
    let type: LabelSignalType | null = null;
    if (ev.type === 'retest' && ev.outcome === 'confirmed') type = 'retest_confirmed';
    if (ev.type === 'high_concentration_recurrence') {
      type = 'high_concentration_recurrence';
    }
    if (ev.type === 'manual_escalation' && ev.outcome === 'confirmed') type = 'manual_escalation';
    if (ev.type === 'rectification' && ev.outcome === 'overdue') type = 'rectification_overdue';
    if (!type) continue;
    if (new Date(ev.at).getTime() > cutoffMs) continue; // 截止后不计入标签
    positiveSignals.push({
      type,
      at: ev.at,
      delayMin: minutesBetween(start, ev.at),
      note: `${SIGNAL_LABEL[type]}：${ev.note}`,
    });
  }

  // 标签截止之后（或截止时仍未到达）的整改回执属于右删失，不能据此判定逾期正例
  const receiptAfterCutoff =
    !!ledger.rectification?.receiptAt &&
    new Date(ledger.rectification.receiptAt).getTime() > cutoffMs;
  const receiptMissingAtCutoff =
    !!ledger.rectification && !ledger.rectification.receiptAt;
  const lifecycleOpen = !ledger.lifecycleClose;

  // 2) 整改逾期：仅在回执于标签截止之前到达且晚于截止+宽限时成立
  if (ledger.rectification && !receiptAfterCutoff && !receiptMissingAtCutoff) {
    const { dueAt, receiptAt } = ledger.rectification;
    const latenessMin = (new Date(receiptAt!).getTime() - new Date(dueAt).getTime()) / 60000;
    if (latenessMin > dataset.config.rectificationGraceMin) {
      positiveSignals.push({
        type: 'rectification_overdue',
        at: receiptAt!,
        delayMin: minutesBetween(start, receiptAt!),
        note: `整改逾期 ${latenessMin.toFixed(0)} 分钟（回执 ${receiptAt!.slice(5, 16)} 晚于截止）`,
      });
    }
  }

  const exposureByPolicyVersion = splitExposure(dataset, ledger);

  if (positiveSignals.length > 0) {
    const earliest = positiveSignals
      .map((s) => s.at)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
    return {
      sampleId: ledger.sampleId,
      status: 'positive',
      signals: positiveSignals,
      earliestSignalAt: earliest,
      delayMin: minutesBetween(start, earliest),
      labelAvailableAt: earliest,
      cutoffAt: ledger.labelCutoffAt,
      censoredReason: null,
      exposureByPolicyVersion,
      closeTimePolicyVersion: closeTimePolicy(dataset, ledger),
      exposureBasis: 'member_time',
      usedPostStartLedgerRevision: false,
      stratificationBasis: 'frozen_pre_start_snapshot',
    };
  }

  // 无确认信号：区分 阴性（已观察至截止且闭环）与 右删失
  if (receiptAfterCutoff || receiptMissingAtCutoff || (lifecycleOpen && !ledger.rectification)) {
    const reason = receiptAfterCutoff
      ? `整改回执 ${ledger.rectification!.receiptAt!.slice(5, 16)} 晚于标签截止 ${ledger.labelCutoffAt.slice(5, 16)}，保留右删失`
      : receiptMissingAtCutoff
        ? '标签截止时仍未收到整改回执，保留右删失'
        : '事件生命周期在标签截止时仍未关闭，保留右删失';
    return {
      sampleId: ledger.sampleId,
      status: 'censored',
      signals: [],
      earliestSignalAt: null,
      delayMin: null,
      labelAvailableAt: ledger.labelCutoffAt,
      cutoffAt: ledger.labelCutoffAt,
      censoredReason: reason,
      exposureByPolicyVersion,
      closeTimePolicyVersion: closeTimePolicy(dataset, ledger),
      exposureBasis: 'member_time',
      usedPostStartLedgerRevision: false,
      stratificationBasis: 'frozen_pre_start_snapshot',
    };
  }

  return {
    sampleId: ledger.sampleId,
    status: 'negative',
    signals: [],
    earliestSignalAt: null,
    delayMin: null,
    labelAvailableAt: ledger.labelCutoffAt,
    cutoffAt: ledger.labelCutoffAt,
    censoredReason: null,
    exposureByPolicyVersion,
    closeTimePolicyVersion: closeTimePolicy(dataset, ledger),
    exposureBasis: 'member_time',
    usedPostStartLedgerRevision: false,
    stratificationBasis: 'frozen_pre_start_snapshot',
  };
}

export function attributeAll(
  dataset: SafetyDataset,
  ledger: SampleLedgerRecord[],
  _mode: AttributionMode,
): { labels: DelayedLabel[]; ledger: SampleLedgerRecord[] } {
  const labels = ledger.map((l) => attributeDelayedLabel(dataset, l));
  // 回填并冻结标签可用时间
  const updated = ledger.map((l, i) => ({
    ...l,
    labelAvailableAt: labels[i].labelAvailableAt,
  }));
  return { labels, ledger: updated };
}

export { SIGNAL_LABEL };
