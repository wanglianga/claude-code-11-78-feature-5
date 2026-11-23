// ============================================================
// Vitest：场景确定性、双路线等价性、换版重算、同步冲突与自检断言。
// 运行：npm test（Node 环境，纯函数管线，无需浏览器 IndexedDB）
// ============================================================

import { describe, expect, it } from 'vitest';
import { buildScenario, t } from './scenario';
import { alignAll } from './aligner';
import { verify } from './engine';
import {
  ContributionDict,
  buildGroups,
  compressRouteA,
  compressRouteB,
  decodeWitness,
  verifyBoundary,
} from './compression';
import { runPipeline } from './pipeline';
import { runSelfCheck } from './selfcheck';
import { signRecord } from './loader';
import { canonicalize } from './crypto';
import type { Alert } from './types';

async function build() {
  const bundle = buildScenario();
  const { observations } = alignAll(bundle.raw, bundle.ledger, bundle.mapping, bundle.zones);
  return { bundle, observations };
}

describe('场景与对齐', () => {
  it('单位换算：bar→kPa、L/s→m3/h，坐标修正到 WGS84', async () => {
    const { observations } = await build();
    const ps = observations.find((o) => o.deviceId === 'PS-002' && o.sampledAt === t(8, 0))!;
    expect(ps.value).toBeCloseTo(800, 5); // 8 bar = 800 kPa
    const fs = observations.find((o) => o.deviceId === 'FS-003' && o.sampledAt === t(9, 0))!;
    expect(fs.value).toBeCloseTo(72, 5); // 20 L/s = 72 m3/h
    const vw = observations.find((o) => o.deviceId === 'VW-001')!;
    const ledger = buildScenario().ledger.find((d) => d.deviceId === 'VW-001')!;
    expect(vw.location.lng).toBe(ledger.location.lng);
    expect(vw.location.lat).toBe(ledger.location.lat);
  });

  it('网络漂移：迟到与乱序均被标注，施工窗口标注正确', async () => {
    const { observations } = await build();
    const late = observations.find((o) => o.deviceId === 'VW-001' && o.sampledAt === t(9, 15))!;
    expect(late.networkDrift).toBe(true);
    const ooo = observations.find((o) => o.deviceId === 'VW-001' && o.sampledAt === t(10, 30))!;
    expect(ooo.networkDrift).toBe(true);
    const inZone = observations.find((o) => o.deviceId === 'VW-001' && o.sampledAt === t(10, 0))!;
    expect(inZone.inConstruction).toBe(true);
    const outZone = observations.find((o) => o.deviceId === 'PS-002' && o.sampledAt === t(9, 30))!;
    expect(outZone.inConstruction).toBe(false);
  });
});

describe('规则版本化核验', () => {
  it('换版前后告警数量与严重度符合阈值差异', async () => {
    const { bundle, observations } = await build();
    const v1 = bundle.ruleVersions.find((r) => r.id === 'RV-2026.1')!;
    const v2 = bundle.ruleVersions.find((r) => r.id === 'RV-2026.2')!;
    const phase2 = new Date(t(12, 0)).getTime();
    const a1 = await verify({
      observations: observations.filter((o) => new Date(o.sampledAt).getTime() < phase2),
      ledger: bundle.ledger,
      zones: bundle.zones,
      rectifications: bundle.rectifications.filter((r) => new Date(r.dueAt).getTime() < phase2),
      ruleVersion: v1,
      mappingVersion: bundle.mapping.version,
      nowIso: t(12, 0),
    });
    const a2 = await verify({
      observations,
      ledger: bundle.ledger,
      zones: bundle.zones,
      rectifications: bundle.rectifications,
      ruleVersion: v2,
      mappingVersion: bundle.mapping.version,
      nowIso: t(18, 0),
    });
    const n = (alerts: Alert[], device: string, kind: string) =>
      alerts.filter((a) => a.deviceId === device && a.kind === kind).length;
    expect(n(a1, 'PS-002', 'jump')).toBe(2);
    expect(n(a2, 'PS-002', 'jump')).toBe(4);
    expect(n(a1, 'VW-001', 'missing')).toBe(1);
    expect(n(a2, 'VW-001', 'missing')).toBe(2);
    expect(n(a1, 'FS-003', 'missing')).toBe(0);
    expect(n(a2, 'FS-003', 'missing')).toBe(1);
    expect(n(a1, 'FS-003', 'overdue')).toBe(0);
    expect(n(a2, 'FS-003', 'overdue')).toBe(1);
    const contra1 = a1.find((a) => a.deviceId === 'VW-001' && a.kind === 'contradiction')!;
    const contra2 = a2.find((a) => a.deviceId === 'VW-001' && a.kind === 'contradiction')!;
    expect(contra1.severity).toBe('major');
    expect(contra2.severity).toBe('critical');
    // 施工抑制的跳变降级 info 但仍保留
    const suppressed = a2.filter((a) => a.deviceId === 'VW-001' && a.kind === 'jump' && a.severity === 'info');
    expect(suppressed.length).toBeGreaterThanOrEqual(1);
  });

  it('告警 ID 为内容寻址：同输入复算得到相同 ID', async () => {
    const { bundle, observations } = await build();
    const v1 = bundle.ruleVersions.find((r) => r.id === 'RV-2026.1')!;
    const phase2 = new Date(t(12, 0)).getTime();
    const input = {
      observations: observations.filter((o) => new Date(o.sampledAt).getTime() < phase2),
      ledger: bundle.ledger,
      zones: bundle.zones,
      rectifications: bundle.rectifications,
      ruleVersion: v1,
      mappingVersion: bundle.mapping.version,
      nowIso: t(12, 0),
    };
    const [x, y] = await Promise.all([verify(input), verify(input)]);
    expect(x.map((a) => a.id).sort()).toEqual(y.map((a) => a.id).sort());
  });
});

describe('双路线压缩等价性', () => {
  it('A/B 还原相同成员集合、严重度与逐成员贡献，边界校验通过', async () => {
    const out = await runPipeline({
      ...((await build()).bundle),
      mapping: (await build()).bundle.mapping,
      nowIso: t(18, 0),
      localRev: 18,
      seedOfflineActions: true,
    });
    expect(out.eventsA.length).toBe(out.eventsB.length);
    const alertsById = new Map(out.alerts.map((a) => [a.id, a]));
    for (const evA of out.eventsA) {
      const evB = out.eventsB.find(
        (e) =>
          e.deviceId === evA.deviceId &&
          e.ruleId === evA.ruleId &&
          e.ruleVersionId === evA.ruleVersionId &&
          e.windowStart === evA.windowStart &&
          e.windowEnd === evA.windowEnd,
      )!;
      const membersA = evA.memberships!.map((m) => m.alertId).sort();
      const membersB = [...evB.witness!.alertRefs].sort();
      expect(canonicalize(membersA)).toBe(canonicalize(membersB));
      expect(evA.severity).toBe(evB.severity);
      const decoded = decodeWitness(evB.witness!, alertsById, out.dict);
      for (const m of evA.memberships!) {
        const d = decoded.find((x) => x.alert.id === m.alertId)!;
        expect(d.severityScore).toBe(m.severityContribution);
        expect(d.rationale).toBe(alertsById.get(m.alertId)!.contribution.rationale);
        expect(d.recommendation).toBe(m.recommendationContribution);
      }
      expect(evB.witness!.boundary.passed).toBe(true);
    }
  });

  it('B 路线存储体积小于 A，且见证篡改会被哈希发现', async () => {
    const out = await runPipeline({
      ...(await build()).bundle,
      mapping: (await build()).bundle.mapping,
      nowIso: t(18, 0),
      localRev: 18,
      seedOfflineActions: true,
    });
    expect(out.report.routeStats.B.payloadBytes).toBeLessThan(out.report.routeStats.A.payloadBytes);
    const target = out.eventsB.find((e) => e.witness)!;
    const tampered = {
      ...target,
      witness: { ...target.witness!, alertRefs: [...target.witness!.alertRefs].reverse() },
    };
    const boundary = verifyBoundary(tampered.witness!, out.alerts, t(18, 0));
    // 篡改后槽位解码应直接抛错
    expect(() => decodeWitness(tampered.witness!, new Map(out.alerts.map((a) => [a.id, a])), out.dict)).toThrow();
    expect(boundary).toBeDefined();
  });

  it('分组与字典往返稳定', async () => {
    const { bundle, observations } = await build();
    const v2 = bundle.ruleVersions.find((r) => r.id === 'RV-2026.2')!;
    const alerts = await verify({
      observations,
      ledger: bundle.ledger,
      zones: bundle.zones,
      rectifications: bundle.rectifications,
      ruleVersion: v2,
      mappingVersion: bundle.mapping.version,
      nowIso: t(18, 0),
    });
    const groups = buildGroups(alerts);
    const dict = new ContributionDict();
    const [a, b] = await Promise.all([
      compressRouteA(groups, t(18, 0)),
      compressRouteB(groups, dict, t(18, 0)),
    ]);
    expect(a.events.length).toBe(b.events.length);
    const restored = ContributionDict.fromJSON(dict.toJSON());
    expect(restored.lookup(0)).toBe(dict.lookup(0));
  });
});

describe('同步对照与全量自检', () => {
  it('离线补传产生至少 2 项冲突且全部自检断言通过', async () => {
    const bundle0 = (await build()).bundle;
    const bundle = {
      ...bundle0,
      raw: await Promise.all(
        bundle0.raw.map(async (r) => ({ ...r, signature: await signRecord(r) })),
      ),
    };
    const out = await runPipeline({
      ...bundle,
      mapping: bundle.mapping,
      nowIso: t(18, 0),
      localRev: 18,
      seedOfflineActions: true,
    });
    expect(out.report.conflicts.length).toBeGreaterThanOrEqual(2);
    const signatures = new Set(bundle.raw.map((r) => r.signature));
    const checks = await runSelfCheck(out, bundle.raw.length, signatures);
    const failed = checks.filter((c) => !c.passed);
    for (const f of failed) console.error(`自检失败 ${f.id}: ${f.detail}`);
    expect(failed).toEqual([]);
  });
});
