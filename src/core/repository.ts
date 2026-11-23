// ============================================================
// 仓储层：把核验产物持久化到 IndexedDB，并支持重新载入还原。
// ============================================================

import {
  STORES,
  clearStore,
  countStore,
  getAll,
  getOne,
  putMany,
  putOne,
  queryIndex,
} from './db';
import type {
  Alert,
  CompressionEvent,
  DisposalAction,
  MembershipRecord,
  RawRecord,
  RuleVersion,
  ScenarioManifest,
  SemanticMapping,
  SyncConflict,
  SyncReport,
  ConstructionZone,
  DeviceLedger,
  Rectification,
} from './types';
import type { SafetyEvaluation } from './safetyTypes';

const META_KEYS = {
  mapping: 'mapping',
  dict: 'contribution_dict',
  safetyEval: 'safety_evaluation',
  grayTrajectory: 'gray_trajectory',
};

export const repository = {
  raw: () => getAll<RawRecord>(STORES.raw),
  ledger: () => getAll<DeviceLedger>(STORES.ledger),
  zones: () => getAll<ConstructionZone>(STORES.construction),
  rectifications: () => getAll<Rectification>(STORES.rectification),
  ruleVersions: () => getAll<RuleVersion>(STORES.ruleVersions),
  manifest: () => getOne<ScenarioManifest>(STORES.manifest, 'SCENARIO-2026-11-23'),
  alerts: () => getAll<Alert>(STORES.alerts),
  events: () => getAll<CompressionEvent>(STORES.events),
  memberships: () => getAll<MembershipRecord>(STORES.memberships),
  actions: () => getAll<DisposalAction>(STORES.actions),
  conflicts: () => getAll<SyncConflict>(STORES.conflicts),
  reports: () => getAll<SyncReport>(STORES.reports),
  counts: async () =>
    Object.fromEntries(
      await Promise.all(
        Object.values(STORES).map(async (s) => [s, await countStore(s)] as const),
      ),
    ),

  saveMapping: (mapping: SemanticMapping) =>
    putOne(STORES.meta, { key: META_KEYS.mapping, value: mapping }),
  loadMapping: () =>
    getOne<{ key: string; value: SemanticMapping }>(STORES.meta, META_KEYS.mapping),
  saveDict: (values: string[]) =>
    putOne(STORES.meta, { key: META_KEYS.dict, value: values }),
  loadDict: () => getOne<{ key: string; value: string[] }>(STORES.meta, META_KEYS.dict),

  // ---------- 压缩策略安全评估 ----------
  saveSafetyEval: async (evalResult: SafetyEvaluation) => {
    if (!evalResult || typeof evalResult.id !== 'string' || !Array.isArray(evalResult.ledger)) {
      throw new Error('安全评估产物结构不完整，拒绝落盘');
    }
    await putOne(STORES.meta, { key: META_KEYS.safetyEval, value: evalResult });
  },
  loadSafetyEval: () =>
    getOne<{ key: string; value: SafetyEvaluation }>(STORES.meta, META_KEYS.safetyEval),
  saveGrayTrajectory: (trajectory: unknown) =>
    putOne(STORES.meta, { key: META_KEYS.grayTrajectory, value: trajectory }),
  loadGrayTrajectory: () =>
    getOne<{ key: string; value: unknown }>(STORES.meta, META_KEYS.grayTrajectory),

  saveVerifyOutput: async (out: {
    alerts: Alert[];
    eventsA: CompressionEvent[];
    eventsB: CompressionEvent[];
    memberships: MembershipRecord[];
    dict: string[];
    report: SyncReport;
    actions: DisposalAction[];
  }) => {
    await Promise.all([
      putMany(STORES.alerts, out.alerts),
      putMany(STORES.events, [...out.eventsA, ...out.eventsB]),
      putMany(STORES.memberships, out.memberships),
      putMany(STORES.actions, out.actions),
      putMany(STORES.conflicts, out.report.conflicts),
      putOne(STORES.reports, out.report),
      putOne(STORES.meta, { key: META_KEYS.dict, value: out.dict }),
    ]);
  },

  addAction: (action: DisposalAction) => putOne(STORES.actions, action),
  saveConflicts: (rows: SyncConflict[]) => putMany(STORES.conflicts, rows),
  saveReport: (report: SyncReport) => putOne(STORES.reports, report),
  actionsByEvent: (eventId: string) =>
    queryIndex<DisposalAction>(STORES.actions, 'by_event', eventId),

  wipeDerived: () =>
    Promise.all(
      [STORES.alerts, STORES.events, STORES.memberships, STORES.conflicts, STORES.reports].map(
        clearStore,
      ),
    ),
};
