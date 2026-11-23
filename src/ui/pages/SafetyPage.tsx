import { useMemo, useState } from 'react';
import { useApp } from '../../state/app';
import { runSafetyChecks } from '../../core/safetyCheck';
import { SIGNAL_LABEL } from '../../core/safetyAttribution';
import type {
  DelayedLabel,
  GateResult,
  RiskTier,
  SafetyEvaluation,
  SampleLedgerRecord,
} from '../../core/safetyTypes';

type Tab = 'overview' | 'ledger' | 'labels' | 'cohort' | 'metrics' | 'gate' | 'gray';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: '评估总览' },
  { key: 'ledger', label: '冻结样本账本' },
  { key: 'labels', label: '结果归因 / 延迟标签' },
  { key: 'cohort', label: '可比性诊断' },
  { key: 'metrics', label: '分层指标与区间' },
  { key: 'gate', label: '安全门禁' },
  { key: 'gray', label: '灰度执行轨迹' },
];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const int = (i: { lower: number; upper: number; point: number }) =>
  `[${(i.lower * 100).toFixed(1)}%, ${(i.upper * 100).toFixed(1)}%]`;

const VERDICT_META: Record<GateResult['verdict'], { cls: string; text: string }> = {
  pass: { cls: 'ok', text: '评估合格（仅建议性排序）' },
  advisory_only: { cls: 'minor', text: '回退：仅展示建议' },
  blocked: { cls: 'bad', text: '阻止汇总' },
};

function StatusBadge({ label }: { label: DelayedLabel }) {
  const map: Record<DelayedLabel['status'], { cls: string; text: string }> = {
    positive: { cls: 'bad', text: '延迟确认' },
    negative: { cls: 'ok', text: '观察期内阴性' },
    censored: { cls: 'neutral', text: '右删失' },
  };
  return <span className={`badge ${map[label.status].cls}`}>{map[label.status].text}</span>;
}

export default function SafetyPage() {
  const { safety, safetyError, runSafetyEval } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const [tier, setTier] = useState<RiskTier | 'ALL'>('ALL');

  const ledger = safety?.ledger ?? [];

  const checks = useMemo(() => (safety ? runSafetyChecks(safety) : []), [safety]);
  const passedChecks = checks.filter((c) => c.passed).length;

  const filteredLedger = ledger.filter((l) => tier === 'ALL' || l.initialRiskTier === tier);

  return (
    <div>
      <div className="card">
        <h2>⑩ 压缩策略安全评估工作台（冻结历史可比性）</h2>
        <p className="muted small">
          独立处理“压缩策略是否掩盖应升级风险”的推断问题。本批次只实施<strong>历史冻结窗口的可比性评估</strong>，
          灰度实验仅登记为后续验证路径。任何时效改善、复测节省或漏报变化
          都只能标为<strong>关联性估计</strong>，不能宣称为未执行策略的真实收益。
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="primary" onClick={runSafetyEval}>
            运行安全评估（冻结账本 → 归因 → 队列 → 指标 → 门禁）
          </button>
          {safetyError && <span className="diff-del small">{safetyError}</span>}
          {safety && (
            <span className="small">
              自检 <strong className={passedChecks === checks.length ? 'diff-add' : 'diff-del'}>{passedChecks}/{checks.length}</strong>
              通过 · 产物 <span className="mono">{safety.id}</span>
            </span>
          )}
        </div>
        {!safety && <div className="banner warn" style={{ marginTop: 12 }}>尚未运行安全评估。点击上方按钮生成冻结账本与门禁结论。</div>}
        {safety && (
          <div className="banner ok" style={{ marginTop: 12 }}>
            {safety.gate.recommendationMode}（verdict=<span className="mono">{safety.gate.verdict}</span>，
            建议性排序={safety.gate.advisoryRankingAllowed ? '允许' : '禁止'}，
            覆盖扩大={safety.gate.coverageExpansionAllowed ? '允许' : '禁止'}）
          </div>
        )}
      </div>

      {safety && (
        <div className="card">
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'overview' && <Overview ev={safety} />}
          {tab === 'ledger' && (
            <LedgerTab ledger={ledger} filtered={filteredLedger} tier={tier} setTier={setTier} />
          )}
          {tab === 'labels' && <LabelsTab ev={safety} />}
          {tab === 'cohort' && <CohortTab ev={safety} />}
          {tab === 'metrics' && <MetricsTab ev={safety} />}
          {tab === 'gate' && <GateTab ev={safety} />}
          {tab === 'gray' && <GrayTab ev={safety} />}
        </div>
      )}

      {safety && (
        <div className="card">
          <h2>自检断言（{passedChecks}/{checks.length}）</h2>
          <table>
            <thead>
              <tr><th style={{ width: 70 }}>编号</th><th>维度</th><th>断言</th><th style={{ width: 70 }}>结果</th><th>实测证据</th></tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td className="small">{c.dimension}</td>
                  <td>{c.name}</td>
                  <td><span className={`badge ${c.passed ? 'ok' : 'bad'}`}>{c.passed ? '通过' : '失败'}</span></td>
                  <td className="small">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Overview({ ev }: { ev: SafetyEvaluation }) {
  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi"><div className="num">{ev.ledger.length}</div><div className="label">冻结样本</div></div>
        <div className="kpi"><div className="num">{ev.labels.filter((l) => l.status === 'positive').length}</div><div className="label">延迟确认正例</div></div>
        <div className="kpi"><div className="num">{ev.labels.filter((l) => l.status === 'censored').length}</div><div className="label">右删失样本</div></div>
        <div className="kpi"><div className="num">{pct(ev.metrics.overall.keyRetention.interval.point)}</div><div className="label">总体关键保留率</div></div>
        <div className="kpi"><div className="num">{ev.gate.manualQueue.length}</div><div className="label">直达人工队列</div></div>
        <div className="kpi"><div className="num">{ev.cohort.strata.filter((s) => s.comparable).length}/{ev.cohort.strata.length}</div><div className="label">可比风险层</div></div>
      </div>
      <h3>冻结窗口与版本</h3>
      <table>
        <tbody>
          <tr><th>冻结基线</th><td className="mono">{ev.dataset.frozenAt}</td></tr>
          <tr><th>观察窗口</th><td className="mono">{ev.dataset.windowStart} → {ev.dataset.windowEnd}</td></tr>
          <tr><th>标签截止</th><td className="mono">{ev.dataset.labelCutoffAt}</td></tr>
          <tr><th>策略换版</th><td className="mono">{ev.dataset.policySwitchAt}</td></tr>
          <tr><th>归因方式</th><td>{ev.cohort.mode}（历史可比性，非灰度实测）</td></tr>
          <tr><th>置信水平</th><td>{pct(ev.config.confidenceLevel)}</td></tr>
        </tbody>
      </table>
      <h3>策略版本</h3>
      <table>
        <thead><tr><th>策略</th><th>生效</th><th>归并窗</th><th>保留关键原始告警</th><th>激进折叠</th><th>说明</th></tr></thead>
        <tbody>
          {ev.policies.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.id}</td>
              <td className="small mono">{p.effectiveFrom.slice(5, 16)}</td>
              <td>{p.mergeWindowMin} 分钟</td>
              <td>{p.retainKeyRawAlerts ? '是' : <span className="diff-del">否</span>}</td>
              <td>{p.aggressiveMerge ? '是' : '否'}</td>
              <td className="small">{p.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>观察起点之后的台账修订（仅留档，不参与分层）</h3>
      <table>
        <thead><tr><th>修订</th><th>区域</th><th>时间</th><th>分层变化</th><th>说明</th></tr></thead>
        <tbody>
          {ev.ledgerRevisions.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td>{ev.regions.find((x) => x.regionId === r.regionId)?.name ?? r.regionId}</td>
              <td className="small mono">{r.at.slice(5, 16)}</td>
              <td><span className="tag">{r.fromTier} → {r.toTier}</span></td>
              <td className="small">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="banner warn" style={{ marginTop: 12 }}>{ev.notes.join(' ')}</div>
    </div>
  );
}

export function LedgerTab({ ledger, filtered, tier, setTier }: {
  ledger: SampleLedgerRecord[];
  filtered: SampleLedgerRecord[];
  tier: RiskTier | 'ALL';
  setTier: (t: RiskTier | 'ALL') => void;
}) {
  return (
    <div>
      <p className="muted small">
        每个候选事件冻结：观察起点、当时可见成员告警、策略/规则版本、区域风险分层、值班负荷、后续复测/派单/整改时间线及标签可用时间。
      </p>
      <div style={{ marginBottom: 10 }}>
        <select value={tier} onChange={(e) => setTier(e.target.value as RiskTier | 'ALL')}>
          <option value="ALL">全部风险层（{ledger.length}）</option>
          <option value="R1">R1 低风险</option>
          <option value="R2">R2 中风险</option>
          <option value="R3">R3 高风险</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>样本</th><th>区域/层</th><th>设备类型</th><th>施工</th><th>负荷</th><th>浓度区间</th>
            <th>观察起点</th><th>可见成员</th><th>起点策略/规则</th><th>忽略修订</th><th>峰值</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((l) => (
            <tr key={l.sampleId}>
              <td className="mono">{l.sampleId}</td>
              <td className="small">{l.regionId}<br /><span className="badge neutral">{l.initialRiskTier}</span></td>
              <td className="small">{l.deviceType}</td>
              <td>{l.constructionState === 'active' ? <span className="tag">施工</span> : '—'}</td>
              <td className="small">{l.shiftLoad}</td>
              <td className="small">{l.concentrationBand}</td>
              <td className="small mono">{l.observationStart.slice(5, 16)}</td>
              <td>{l.memberCount}</td>
              <td className="small mono">{l.policyVersionAtStart}<br />{l.ruleVersionAtStart}</td>
              <td className="small">{l.ignoredPostStartRevisions.length ? l.ignoredPostStartRevisions.join('、') : '—'}</td>
              <td>{l.peakConcentration}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LabelsTab({ ev }: { ev: SafetyEvaluation }) {
  return (
    <div>
      <p className="muted small">
        结果归因器组合复测确认、后续高浓度重现、人工升级与整改逾期为延迟标签；
        观察起点之后的处置结果只用于打标签，<strong>不用于决定样本最初分层</strong>。
      </p>
      <table>
        <thead>
          <tr>
            <th>样本</th><th>状态</th><th>标签可用时间</th><th>最早可见延迟</th><th>信号组合</th>
            <th>暴露拆分（按成员时间）</th><th>关闭时策略版本</th><th>右删失理由</th>
          </tr>
        </thead>
        <tbody>
          {ev.labels.map((lab) => {
            const l = ev.ledger.find((x) => x.sampleId === lab.sampleId)!;
            return (
              <tr key={lab.sampleId}>
                <td className="mono">{lab.sampleId}<div className="small muted">{l.initialRiskTier} · {l.deviceType}</div></td>
                <td><StatusBadge label={lab} /></td>
                <td className="small mono">{lab.labelAvailableAt.slice(5, 16)}</td>
                <td className="small">{lab.delayMin === null ? '—' : `${lab.delayMin} 分钟`}</td>
                <td className="small">
                  {lab.signals.length === 0 ? '—' : lab.signals.map((s) => (
                    <div key={s.at + s.type}><span className="tag">{SIGNAL_LABEL[s.type]}</span>{s.at.slice(5, 16)}</div>
                  ))}
                </td>
                <td className="small">
                  {lab.exposureByPolicyVersion.map((s) => (
                    <div key={s.policyVersionId} className="mono">
                      {s.policyVersionId}: 成员 {s.memberCount} / 关键 {s.keyMemberCount} / 保留 {s.retainedKeyCount}
                    </div>
                  ))}
                  {lab.exposureByPolicyVersion.length > 1 && <span className="badge minor">跨版拆分</span>}
                </td>
                <td className="small mono">{lab.closeTimePolicyVersion ?? '—'}</td>
                <td className="small">{lab.censoredReason ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="small muted" style={{ marginTop: 10 }}>
        共 {ev.labels.filter((l) => l.status === 'censored').length} 个右删失样本未计入任何风险率分母；
        {ev.labels.filter((l) => l.exposureByPolicyVersion.length > 1).length} 个跨版样本按成员时间拆分暴露。
      </div>
    </div>
  );
}

export function CohortTab({ ev }: { ev: SafetyEvaluation }) {
  return (
    <div>
      <p className="muted small">
        在同一风险层、施工状态、设备类型、浓度区间与班次负荷内匹配新旧策略覆盖事件，并显式报告未匹配样本与重叠不足。
      </p>
      {!ev.cohort.aggregateComparable && (
        <div className="banner bad">总效应不可汇总：{ev.cohort.aggregateBlockedReasons.join('；')}</div>
      )}
      {ev.cohort.strata.map((s) => (
        <div className="card" key={s.riskTier} style={{ marginBottom: 14 }}>
          <h3>
            {s.riskTier} 层 · 旧 {s.oldSamples} / 新 {s.newSamples} · 匹配 {s.matchedPairs} 对 · 重叠系数 {s.overlapCoefficient}{' '}
            <span className={`badge ${s.comparable ? 'ok' : 'bad'}`}>{s.comparable ? '可比较' : '不可比较'}</span>
          </h3>
          {!s.comparable && <div className="small diff-del">阻断：{s.blockingReasons.join('；')}</div>}
          <table>
            <thead>
              <tr><th>匹配单元（层|施工|设备|浓度|负荷）</th><th>旧</th><th>新</th><th>匹配对</th></tr>
            </thead>
            <tbody>
              {s.cells.map((c) => (
                <tr key={c.cellKey}>
                  <td className="small mono">{c.cellKey}</td>
                  <td>{c.oldCount}</td>
                  <td>{c.newCount}</td>
                  <td>{c.matchedPairs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.unmatched.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="small muted">未匹配 / 排除样本（显式报告）：</div>
              <table>
                <tbody>
                  {s.unmatched.map((u) => (
                    <tr key={u.sampleId + u.reason}>
                      <td className="mono small">{u.sampleId}</td>
                      <td className="small">{u.arm}</td>
                      <td className="small"><span className="tag">{u.reason}</span></td>
                      <td className="small">{u.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function MetricsTab({ ev }: { ev: SafetyEvaluation }) {
  return (
    <div>
      <div className="banner warn">
        以下所有效应与时效指标均为<strong>关联性估计</strong>（association_estimate），不代表未执行灰度策略的真实收益。
      </div>
      <h3>总体安全界限</h3>
      <div className="kpi-grid">
        <div className="kpi"><div className="num">{pct(ev.metrics.overall.keyRetention.interval.point)}</div><div className="label">关键原始告警保留率 {int(ev.metrics.overall.keyRetention.interval)}</div></div>
        <div className="kpi"><div className="num">{pct(ev.metrics.overall.delayedEscalation.interval.point)}</div><div className="label">延迟升级率 {int(ev.metrics.overall.delayedEscalation.interval)}</div></div>
        <div className="kpi"><div className="num">{ev.metrics.overall.maxVisibleDelay?.delayMin ?? '—'}</div><div className="label">确认风险最长可见延迟（分钟）</div></div>
        <div className="kpi"><div className="num">{ev.metrics.overall.retestResource.minutesPer100Samples}</div><div className="label">复测资源 (分钟/百样本)</div></div>
        <div className="kpi"><div className="num">{ev.metrics.overall.censoredCount}</div><div className="label">右删失样本（未计零）</div></div>
      </div>
      {ev.metrics.strata.map((s) => (
        <div className="card" key={s.riskTier}>
          <h3>{s.riskTier} 层</h3>
          <table>
            <thead>
              <tr>
                <th>指标</th><th>新策略</th><th>旧策略</th><th>区间 / 说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>关键原始告警保留率</td>
                <td>{s.retention.keyRetained}/{s.retention.keyTotal} = {pct(s.retention.interval.point)}</td>
                <td>{s.retentionOld.keyRetained}/{s.retentionOld.keyTotal}</td>
                <td className="small">
                  Wilson {int(s.retention.interval)}，下限 {pct(s.retention.floor)}
                  {' '}<span className={`badge ${s.retention.passed ? 'ok' : 'bad'}`}>{s.retention.passed ? '达标' : s.retention.ciCrossesFloor ? '区间跨下限' : '低于下限'}</span>
                </td>
              </tr>
              <tr>
                <td>延迟升级率</td>
                <td>{s.delayedEscalation.positiveCount}/{s.delayedEscalation.analyzedCount} = {pct(s.delayedEscalation.interval.point)}</td>
                <td>{s.oldEscalation.positiveCount}/{s.oldEscalation.analyzedCount}</td>
                <td className="small">新 {int(s.delayedEscalation.interval)}；删失 {s.delayedEscalation.censoredCount} 单列</td>
              </tr>
              <tr>
                <td>确认风险最长可见延迟</td>
                <td colSpan={2} className="small">{s.maxVisibleDelay ? `${s.maxVisibleDelay.delayMin} 分钟（${s.maxVisibleDelay.sampleId}，${s.maxVisibleDelay.signalType ? SIGNAL_LABEL[s.maxVisibleDelay.signalType] : '—'}）` : '—'}</td>
                <td className="small">分钟</td>
              </tr>
              <tr>
                <td>复测资源占用</td>
                <td>{s.retestNew.retestCount} 次 / {s.retestNew.resourceMinutes} 分钟（{s.retestNew.minutesPer100Samples}/百样本）</td>
                <td>{s.retestOld.retestCount} 次 / {s.retestOld.resourceMinutes} 分钟</td>
                <td className="small">关联性估计</td>
              </tr>
              <tr>
                <td>新−旧 延迟升级率差</td>
                <td colSpan={2} className="small">
                  {s.effect.computed
                    ? `${pct(s.effect.newRate)} − ${pct(s.effect.oldRate)} = ${pct(s.effect.difference)}，Newcombe ${int(s.effect.interval)}`
                    : `不可比较：${s.effect.blockedReason}`}
                </td>
                <td className="small">{s.effect.computed ? '关联性估计' : <span className="diff-del">已阻止</span>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      <div className="card">
        <h3>总效应（{ev.metrics.aggregateEffect.computed ? '可汇总' : '已阻止'}）</h3>
        {ev.metrics.aggregateEffect.computed ? (
          <p className="small">
            新 {pct(ev.metrics.aggregateEffect.newRate)} − 旧 {pct(ev.metrics.aggregateEffect.oldRate)} ={' '}
            {pct(ev.metrics.aggregateEffect.difference)}，Newcombe {int(ev.metrics.aggregateEffect.interval)}（关联性估计）
          </p>
        ) : (
          <p className="small diff-del">阻止总效应汇总：{ev.metrics.aggregateEffect.blockedReason}</p>
        )}
      </div>
    </div>
  );
}

export function GateTab({ ev }: { ev: SafetyEvaluation }) {
  const meta = VERDICT_META[ev.gate.verdict];
  return (
    <div>
      <div className="banner ok">
        门禁结论 <span className={`badge ${ev.gate.verdict === 'pass' ? 'ok' : ev.gate.verdict === 'advisory_only' ? 'minor' : 'bad'}`}>{meta.text}</span>
        {' '}· 建议性排序 {ev.gate.advisoryRankingAllowed ? '允许' : '禁止'} · 覆盖扩大 {ev.gate.coverageExpansionAllowed ? '允许' : '禁止'} · 总效应汇总 {ev.gate.blockAggregateEffect ? '阻止' : '允许'}
      </div>
      <p className="small">{ev.gate.recommendationMode}</p>
      <h3>门禁规则</h3>
      <table>
        <thead><tr><th>规则</th><th>名称</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          {ev.gate.rules.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td>{r.name}</td>
              <td><span className={`badge ${r.passed ? 'ok' : 'bad'}`}>{r.passed ? '通过' : '不通过'}</span></td>
              <td className="small">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>人工队列（原始高浓度 / 证据冲突直达）</h3>
      <table>
        <thead><tr><th>样本</th><th>原因</th><th>说明</th></tr></thead>
        <tbody>
          {ev.gate.manualQueue.map((m) => (
            <tr key={m.sampleId}>
              <td className="mono">{m.sampleId}</td>
              <td><span className="tag">{m.reason}</span></td>
              <td className="small">{m.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GrayTab({ ev }: { ev: SafetyEvaluation }) {
  const g = ev.grayRegistration;
  return (
    <div>
      <div className="banner warn">
        本批次未执行灰度。以下为<strong>后续验证路径登记</strong>与执行轨迹接入点，不代表已产生实测收益。
      </div>
      <table>
        <tbody>
          <tr><th>登记 ID</th><td className="mono">{g.id}</td></tr>
          <tr><th>状态</th><td><span className="badge neutral">{g.status}</span> · executed={String(g.executed)}</td></tr>
          <tr><th>登记时间</th><td className="mono">{g.registeredAt}</td></tr>
          <tr><th>与本次关系</th><td>{g.mode}（先用历史冻结窗口评估）</td></tr>
          <tr><th>理由</th><td className="small">{g.reason}</td></tr>
          <tr><th>约束</th><td className="small">
            抑制关键原始告警：{String(g.constraints.suppressKeyAlerts)}；
            最短观察 {g.constraints.minObservationDays} 天；
            分层 {g.constraints.requiredStrata.join('/')}；
            分配 {g.constraints.assignment}
          </td></tr>
        </tbody>
      </table>
      <h3>前置条件</h3>
      <ul className="tight small">
        {g.prerequisites.map((p, i) => <li key={i}>{p}</li>)}
      </ul>
      <h3>执行轨迹接入点</h3>
      <table>
        <tbody>
          <tr><th>路径</th><td className="mono">{ev.grayIngest.path}</td></tr>
          <tr><th>接受格式</th><td className="small">{ev.grayIngest.accepts}</td></tr>
          <tr><th>状态</th><td><span className="badge neutral">{ev.grayIngest.status}</span></td></tr>
          <tr><th>说明</th><td className="small">{ev.grayIngest.note}</td></tr>
        </tbody>
      </table>
      <p className="small muted">下一步：{g.nextStep}</p>
    </div>
  );
}
