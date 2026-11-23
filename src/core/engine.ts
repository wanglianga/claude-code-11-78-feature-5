// ============================================================
// 时序核验引擎：缺测 / 跳变 / 状态矛盾 / 处置逾期。
// 纯函数实现；施工扰动按规则 constructionGrace 与施工清单抑制项处理，
// 网络漂移只记录为上下文，不自动关闭告警。
// ============================================================

import type {
  Alert,
  AlertContribution,
  CanonicalObservation,
  ConstructionZone,
  DeviceLedger,
  Rectification,
  RuleDef,
  RuleKind,
  RuleVersion,
  Severity,
} from './types';
import { contentId } from './crypto';

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

interface EngineInput {
  observations: CanonicalObservation[];
  ledger: DeviceLedger[];
  zones: ConstructionZone[];
  rectifications: Rectification[];
  ruleVersion: RuleVersion;
  mappingVersion: string;
  nowIso: string;
}

interface Seed {
  rule: RuleDef;
  deviceId: string;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  evidenceRefs: string[];
  detail: string;
  recommendation: string;
  contribution: AlertContribution;
  context: Alert['context'];
  severityOverride?: Severity;
}

const iso = (ms: number) => new Date(ms).toISOString();
const min = (a: string, b: string) => (new Date(a) <= new Date(b) ? a : b);
const max = (a: string, b: string) => (new Date(a) >= new Date(b) ? a : b);

function zoneAt(
  zones: ConstructionZone[],
  deviceId: string,
  atMs: number,
): ConstructionZone | null {
  return (
    zones.find(
      (z) =>
        z.affectedDevices.includes(deviceId) &&
        atMs >= new Date(z.startAt).getTime() &&
        atMs <= new Date(z.endAt).getTime(),
    ) ?? null
  );
}

function ctxOf(o: CanonicalObservation): Alert['context'] {
  return {
    inConstruction: o.inConstruction,
    constructionId: o.constructionId,
    networkDrift: o.networkDrift,
    backfilled: o.backfilled,
  };
}

// ---------------- 缺测 ----------------
function checkMissing(input: EngineInput): Seed[] {
  const rule = input.ruleVersion.rules.find((r) => r.kind === 'missing' && r.enabled);
  if (!rule) return [];
  const gapMin = rule.params.missingGapMin!;
  const seeds: Seed[] = [];
  const byDevice = new Map<string, CanonicalObservation[]>();
  for (const o of input.observations) {
    const arr = byDevice.get(o.deviceId) ?? [];
    arr.push(o);
    byDevice.set(o.deviceId, arr);
  }
  for (const [deviceId, rows] of byDevice) {
    rows.sort((a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime());
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const gap =
        (new Date(cur.sampledAt).getTime() - new Date(prev.sampledAt).getTime()) / 60000;
      const midMs =
        (new Date(prev.sampledAt).getTime() + new Date(cur.sampledAt).getTime()) / 2;
      const zone = zoneAt(input.zones, deviceId, midMs);
      // 施工宽限：施工窗口内允许更大的缺测间隔
      const effectiveGap =
        rule.constructionGrace && zone ? Math.max(gapMin, zone.graceIntervalMin) : gapMin;
      if (gap <= effectiveGap) continue;
      seeds.push({
        rule,
        deviceId,
        observedAt: iso(midMs),
        windowStart: prev.sampledAt,
        windowEnd: cur.sampledAt,
        evidenceRefs: [prev.rawSignature, cur.rawSignature],
        detail: `采样缺口 ${gap} 分钟，超过规则 ${rule.id}（${input.ruleVersion.id}）阈值 ${effectiveGap} 分钟${
          zone ? `；施工区 ${zone.id} 宽限后仍超限` : ''
        }`,
        recommendation: '核对采集链路并安排现场补测，确认是否为施工断采',
        contribution: {
          severityScore: Math.min(90, 55 + gapMin * 0 + Math.round(gap / 2)),
          rationale: `缺口 ${gap} 分钟（阈值 ${effectiveGap}），两侧采样可信度 ${prev.confidence}/${cur.confidence}`,
          recommendation: '贡献处置建议：补测并核查采集链路',
        },
        context: {
          inConstruction: !!zone,
          constructionId: zone?.id ?? null,
          networkDrift: prev.networkDrift || cur.networkDrift,
          backfilled: prev.backfilled || cur.backfilled,
        },
      });
    }
  }
  return seeds;
}

// ---------------- 跳变 ----------------
function checkJump(input: EngineInput): Seed[] {
  const rule = input.ruleVersion.rules.find((r) => r.kind === 'jump' && r.enabled);
  if (!rule) return [];
  const ratio = rule.params.jumpRangeRatio!;
  const seeds: Seed[] = [];
  const byDevice = new Map<string, CanonicalObservation[]>();
  for (const o of input.observations) {
    const arr = byDevice.get(o.deviceId) ?? [];
    arr.push(o);
    byDevice.set(o.deviceId, arr);
  }
  for (const [deviceId, rows] of byDevice) {
    const device = input.ledger.find((d) => d.deviceId === deviceId)!;
    const span = device.rangeMax - device.rangeMin;
    rows.sort((a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime());
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const delta = cur.value - prev.value;
      const absRatio = Math.abs(delta) / span;
      if (absRatio <= ratio) continue;
      const zone = zoneAt(
        input.zones,
        deviceId,
        new Date(cur.sampledAt).getTime(),
      );
      // 施工扰动抑制：规则允许宽限且施工清单声明抑制跳变
      const suppressed =
        rule.constructionGrace &&
        !!zone &&
        zone.suppressKinds.includes('jump') &&
        (prev.inConstruction || cur.inConstruction);
      seeds.push({
        rule,
        deviceId,
        observedAt: cur.sampledAt,
        windowStart: prev.sampledAt,
        windowEnd: cur.sampledAt,
        evidenceRefs: [prev.rawSignature, cur.rawSignature],
        detail: `读数变化 ${delta.toFixed(2)} ${device.standardUnit}，占量程 ${(absRatio * 100).toFixed(1)}%，超过 ${(ratio * 100).toFixed(0)}% 阈值${
          suppressed ? `；位于施工区 ${zone!.id} 且清单声明抑制 jump，标记为施工扰动不升级` : ''
        }`,
        recommendation: suppressed
          ? '施工扰动观察项：维持监控并与施工日志比对，不单独派单'
          : '立即复核传感器并比对相邻管网压力，必要时派人现场核验',
        contribution: {
          severityScore: suppressed
            ? 20
            : (rule.baseSeverity === 'critical' ? 82 : 62) + Math.round(absRatio * 20),
          rationale: `变化量程占比 ${(absRatio * 100).toFixed(1)}%（阈值 ${(ratio * 100).toFixed(0)}%）${
            suppressed ? '，施工抑制后仅作观察项' : ''
          }；到达方式：${cur.networkDrift ? '网络漂移/乱序' : '正常到达'}`,
          recommendation: suppressed
            ? '贡献处置建议：维持观察，不派单'
            : '贡献处置建议：现场核验传感器',
        },
        context: { ...ctxOf(cur), inConstruction: !!zone, constructionId: zone?.id ?? null },
        // 施工抑制的跳变保留为成员但降级 info，证据链不丢、不批量关闭
        severityOverride: suppressed ? 'info' : undefined,
      });
    }
  }
  return seeds;
}

// ---------------- 状态矛盾 ----------------
function checkContradiction(input: EngineInput): Seed[] {
  const rule = input.ruleVersion.rules.find((r) => r.kind === 'contradiction' && r.enabled);
  if (!rule) return [];
  const tol = rule.params.contradictionTol!;
  const seeds: Seed[] = [];
  for (const o of input.observations) {
    const device = input.ledger.find((d) => d.deviceId === o.deviceId);
    if (!device) continue;
    if (o.status === device.declaredStatus) continue;
    // 容忍带：台账声明 closed 而读数在零位容忍内，不判矛盾
    if (device.declaredStatus === 'closed' && o.value <= tol) continue;
    seeds.push({
      rule,
      deviceId: o.deviceId,
      observedAt: o.sampledAt,
      windowStart: o.sampledAt,
      windowEnd: o.sampledAt,
      evidenceRefs: [o.rawSignature],
      detail: `观测状态 ${o.status} 与台账 ${device.ledgerVersion} 声明状态 ${device.declaredStatus} 矛盾，读数 ${o.value}${device.standardUnit} 超出容忍带 ${tol}`,
      recommendation: '核对阀门实际启闭状态并更正台账或现场处置，关联整改回执跟踪闭环',
      contribution: {
        severityScore: (rule.baseSeverity === 'critical' ? 88 : 68) + (o.confidence === 'low' ? -8 : 0),
        rationale: `状态分歧（观测 ${o.status} / 台账 ${device.declaredStatus}），可信度 ${o.confidence}，证据签名 ${o.rawSignature.slice(0, 8)}…`,
        recommendation: '贡献处置建议：核对台账并挂接整改回执',
      },
      context: ctxOf(o),
    });
  }
  return seeds;
}

// ---------------- 处置逾期 ----------------
function checkOverdue(input: EngineInput): Seed[] {
  const rule = input.ruleVersion.rules.find((r) => r.kind === 'overdue' && r.enabled);
  if (!rule) return [];
  const overdueMin = rule.params.overdueMin!;
  const nowMs = new Date(input.nowIso).getTime();
  const seeds: Seed[] = [];
  for (const rc of input.rectifications) {
    const closeMs = rc.closedAt ? new Date(rc.closedAt).getTime() : null;
    const dueMs = new Date(rc.dueAt).getTime();
    const latenessMin = closeMs
      ? (closeMs - dueMs) / 60000
      : (nowMs - dueMs) / 60000;
    if (latenessMin <= overdueMin) continue;
    const nearby = input.observations
      .filter((o) => o.deviceId === rc.deviceId)
      .sort(
        (a, b) =>
          Math.abs(new Date(a.sampledAt).getTime() - dueMs) -
          Math.abs(new Date(b.sampledAt).getTime() - dueMs),
      )[0];
    seeds.push({
      rule,
      deviceId: rc.deviceId,
      observedAt: rc.closedAt ?? input.nowIso,
      windowStart: rc.dueAt,
      windowEnd: rc.closedAt ?? input.nowIso,
      evidenceRefs: nearby ? [nearby.rawSignature] : [],
      detail: `整改回执 ${rc.id} ${rc.closedAt ? `延迟 ${latenessMin} 分钟关闭` : `超期 ${latenessMin} 分钟仍未关闭`}，宽限 ${overdueMin} 分钟（${input.ruleVersion.id}）`,
      recommendation: '督办责任班组并升级通知，补录闭环证据',
      contribution: {
        severityScore: (rule.baseSeverity === 'major' ? 58 : 38) + Math.min(20, Math.round(latenessMin / 10)),
        rationale: `延迟 ${latenessMin} 分钟（宽限 ${overdueMin}），回执状态 ${rc.status}${
          rc.alertSourceId ? '' : '，上游告警 ID 缺失，经设备/时间证据链关联'
        }`,
        recommendation: '贡献处置建议：督办并升级通知',
      },
      context: {
        inConstruction: false,
        constructionId: null,
        networkDrift: false,
        backfilled: rc.arrivedAt > rc.dueAt,
      },
    });
  }
  return seeds;
}

const KIND_LABEL: Record<RuleKind, string> = {
  missing: '缺测',
  jump: '跳变',
  contradiction: '状态矛盾',
  overdue: '处置逾期',
};

/** 核验主入口：产出内容寻址的不可变告警 */
export async function verify(input: EngineInput): Promise<Alert[]> {
  const seeds = [
    ...checkMissing(input),
    ...checkJump(input),
    ...checkContradiction(input),
    ...checkOverdue(input),
  ];
  const alerts: Alert[] = [];
  for (const s of seeds) {
    const basis = {
      ruleId: s.rule.id,
      ruleVersionId: input.ruleVersion.id,
      ledgerVersion: input.ledger[0]?.ledgerVersion ?? 'ledger-v3',
      mappingVersion: input.mappingVersion,
      deviceId: s.deviceId,
      kind: s.rule.kind,
      observedAt: s.observedAt,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      evidenceRefs: s.evidenceRefs,
      detail: s.detail,
    };
    const id = await contentId(basis);
    alerts.push({
      id,
      ruleId: s.rule.id,
      ruleVersionId: input.ruleVersion.id,
      ledgerVersion: basis.ledgerVersion,
      mappingVersion: input.mappingVersion,
      deviceId: s.deviceId,
      kind: s.rule.kind,
      severity: s.severityOverride ?? s.rule.baseSeverity,
      observedAt: s.observedAt,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      evidenceRefs: s.evidenceRefs,
      detail: s.detail,
      recommendation: s.recommendation,
      contribution: s.contribution,
      context: s.context,
    });
  }
  // 抑制的跳变保留为成员但降级为 info，保证证据链不丢
  return alerts.sort(
    (a, b) =>
      new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime() ||
      a.deviceId.localeCompare(b.deviceId) ||
      a.kind.localeCompare(b.kind),
  );
}

export { KIND_LABEL, min as minIso, max as maxIso };
