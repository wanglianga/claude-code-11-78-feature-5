import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { buildScenario, t } from '../core/scenario';
import { loadBundle, verifySignatures, type LoaderStats } from '../core/loader';
import { ContributionDict } from '../core/compression';
import { repository } from '../core/repository';
import { resetAll } from '../core/db';
import type {
  Alert,
  CompressionEvent,
  DisposalAction,
  MembershipRecord,
  SyncConflict,
  SyncReport,
  UserRole,
} from '../core/types';
import { useAuth } from './auth';
import { buildSafetyDataset } from '../core/safetyScenario';
import { evaluateSafety } from '../core/safetyEval';
import type { SafetyEvaluation } from '../core/safetyTypes';

export const NOW_ISO = t(18, 0);

export interface AppSnapshot {
  loaded: boolean;
  loaderStats: LoaderStats | null;
  signatureBad: string[];
  alerts: Alert[];
  eventsA: CompressionEvent[];
  eventsB: CompressionEvent[];
  memberships: MembershipRecord[];
  actions: DisposalAction[];
  conflicts: SyncConflict[];
  report: SyncReport | null;
  dictValues: string[];
  workerBusy: boolean;
  workerMessage: string;
  lastElapsedMs: number;
  lastDecodeMs: number;
  safety: SafetyEvaluation | null;
  safetyError: string | null;
  error: string | null;
}

interface AppCtx extends AppSnapshot {
  loadScenario: () => Promise<void>;
  runVerify: () => Promise<void>;
  addDisposal: (
    eventId: string,
    deviceId: string,
    action: DisposalAction['action'],
    comment: string,
  ) => Promise<void>;
  resolveConflict: (entityId: string, resolution: SyncConflict['resolution']) => Promise<void>;
  runSafetyEval: () => Promise<void>;
  resetWorkspace: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);
const EMPTY: AppSnapshot = {
  loaded: false,
  loaderStats: null,
  signatureBad: [],
  alerts: [],
  eventsA: [],
  eventsB: [],
  memberships: [],
  actions: [],
  conflicts: [],
  report: null,
  dictValues: [],
  workerBusy: false,
  workerMessage: '待装载',
  lastElapsedMs: 0,
  lastDecodeMs: 0,
  safety: null,
  safetyError: null,
  error: null,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const workerRef = useRef<Worker | null>(null);
  const [snap, setSnap] = useState<AppSnapshot>(EMPTY);

  const refresh = useCallback(async () => {
    const [rawCount, alerts, events, memberships, actions, conflicts, reports, dictRow, safetyRow] =
      await Promise.all([
        repository.raw(),
        repository.alerts(),
        repository.events(),
        repository.memberships(),
        repository.actions(),
        repository.conflicts(),
        repository.reports(),
        repository.loadDict(),
        repository.loadSafetyEval(),
      ]);
    setSnap((prev) => ({
      ...prev,
      loaded: rawCount.length > 0,
      alerts,
      eventsA: events.filter((e) => e.route === 'A'),
      eventsB: events.filter((e) => e.route === 'B'),
      memberships,
      actions: actions.sort((a, b) => a.at.localeCompare(b.at)),
      conflicts,
      report: reports[0] ?? null,
      dictValues: dictRow?.value ?? [],
      safety: safetyRow?.value ?? null,
    }));
  }, []);

  // 浏览器刷新后从 IndexedDB 回读，恢复 loaded 与全部产物
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadScenario = useCallback(async () => {
    setSnap((p) => ({ ...p, error: null, workerMessage: '装载中…' }));
    const bundle = buildScenario();
    const stats = await loadBundle(bundle);
    await repository.saveMapping(bundle.mapping);
    // 从 IndexedDB 取回已固化签名的记录再验签，避免对未签名副本误报
    const stored = await repository.raw();
    const signatureBad = await verifySignatures(stored);
    setSnap((p) => ({
      ...p,
      loaded: true,
      loaderStats: stats,
      signatureBad,
      workerMessage: '原始数据已装载并签名，待核验',
    }));
  }, []);

  const runVerify = useCallback(async () => {
    if (workerRef.current) workerRef.current.terminate();
    const worker = new Worker(new URL('../core/verify.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    setSnap((p) => ({ ...p, workerBusy: true, error: null, workerMessage: 'Worker 启动…' }));

    const [raw, ledger, zones, rectifications, ruleVersions, mappingRow] = await Promise.all([
      repository.raw(),
      repository.ledger(),
      repository.zones(),
      repository.rectifications(),
      repository.ruleVersions(),
      repository.loadMapping(),
    ]);
    if (!mappingRow) throw new Error('语义映射缺失，请先装载场景');

    return new Promise<void>((resolve) => {
      worker.onmessage = async (ev: MessageEvent) => {
        const msg = ev.data;
        if (msg.phase) {
          setSnap((p) => ({ ...p, workerMessage: `${msg.phase}（${msg.done}/${msg.total}）` }));
          return;
        }
        if (msg.type === 'pipeline_output') {
          const out = msg.output;
          await repository.wipeDerived();
          await repository.saveVerifyOutput({
            alerts: out.alerts,
            eventsA: out.eventsA,
            eventsB: out.eventsB,
            memberships: out.memberships,
            dict: out.dict,
            report: out.report,
            actions: out.seededActions,
          });
          await refresh();
          setSnap((p) => ({ ...p, workerMessage: '核验完成，产物已落 IndexedDB' }));
          return;
        }
        if (msg.type === 'verify_result') {
          setSnap((p) => ({
            ...p,
            workerBusy: false,
            lastElapsedMs: msg.elapsedMs,
            lastDecodeMs: msg.decodeMs,
          }));
          worker.terminate();
          workerRef.current = null;
          resolve();
          return;
        }
        if (msg.type === 'verify_error') {
          setSnap((p) => ({
            ...p,
            workerBusy: false,
            error: msg.message,
            workerMessage: '核验失败',
          }));
          worker.terminate();
          workerRef.current = null;
          resolve();
        }
      };
      worker.postMessage({
        type: 'verify',
        batchId: `BATCH-${Date.now()}`,
        route: 'both',
        payload: {
          raw,
          ledger,
          zones,
          rectifications,
          mapping: mappingRow.value,
          ruleVersions,
          nowIso: NOW_ISO,
          localRev: 18,
          seedOfflineActions: true,
        },
      });
    });
  }, [refresh]);

  const addDisposal = useCallback(
    async (
      eventId: string,
      deviceId: string,
      action: DisposalAction['action'],
      comment: string,
    ) => {
      const role: UserRole = user?.role ?? 'auditor';
      const existing = await repository.actionsByEvent(eventId);
      const next: DisposalAction = {
        id: `ACT-${Date.now()}-${existing.length + 1}`,
        eventId,
        deviceId,
        actor: user?.name ?? '未登录',
        role,
        action,
        comment,
        at: NOW_ISO,
        baseVersion: existing.length + 1,
        syncState: 'local',
      };
      await repository.addAction(next);
      await refresh();
    },
    [refresh, user],
  );

  const resolveConflict = useCallback(
    async (conflictId: string, resolution: SyncConflict['resolution']) => {
      const rows = await repository.conflicts();
      const updated = rows.map((c) =>
        c.id === conflictId ? { ...c, resolution } : c,
      );
      await repository.saveConflicts(updated);
      const report = (await repository.reports())[0];
      if (report) {
        await repository.saveReport({
          ...report,
          conflicts: report.conflicts.map((c) =>
            c.id === conflictId ? { ...c, resolution } : c,
          ),
        });
      }
      await refresh();
    },
    [refresh],
  );

  const runSafetyEval = useCallback(async () => {
    setSnap((p) => ({ ...p, safetyError: null }));
    try {
      const dataset = buildSafetyDataset();
      const result = evaluateSafety(dataset);
      await repository.saveSafetyEval(result);
      setSnap((p) => ({ ...p, safety: result, safetyError: null }));
    } catch (err) {
      setSnap((p) => ({ ...p, safetyError: (err as Error).message }));
    }
  }, []);

  const resetWorkspace = useCallback(async () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    await resetAll();
    setSnap(EMPTY);
  }, []);

  const value = useMemo<AppCtx>(
    () => ({
      ...snap,
      loadScenario,
      runVerify,
      addDisposal,
      resolveConflict,
      runSafetyEval,
      resetWorkspace,
      refresh,
    }),
    [snap, loadScenario, runVerify, addDisposal, resolveConflict, runSafetyEval, resetWorkspace, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

/** 主线程侧还原贡献字典，供 B 路线调查页解码 */
export function useDict(values: string[]) {
  return useMemo(() => ContributionDict.fromJSON(values), [values]);
}
