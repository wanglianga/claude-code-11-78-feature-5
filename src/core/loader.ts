// ============================================================
// 装载器：保存原始记录、采样/到达时间、可信度与签名。
// 签名在装载时对业务字段做内容寻址并固化，后续任何环节不得改写。
// ============================================================

import { canonicalize, sha256Hex } from './crypto';
import {
  saveLedger,
  saveManifest,
  saveRawRecords,
  saveRectifications,
  saveRuleVersions,
  saveZones,
} from './db';
import type { RawRecord } from './types';
import type { ScenarioBundle } from './scenario';

/** 对原始记录的业务字段计算签名（不含 signature 自身） */
export async function signRecord(rec: Omit<RawRecord, 'signature'>): Promise<string> {
  const basis = {
    sourceId: rec.sourceId,
    kind: rec.kind,
    payload: rec.payload,
    sampledAt: rec.sampledAt,
    arrivedAt: rec.arrivedAt,
    confidence: rec.confidence,
    batchId: rec.batchId,
    backfilled: rec.backfilled,
  };
  return sha256Hex(canonicalize(basis));
}

export interface LoaderStats {
  rawCount: number;
  signedCount: number;
  batchIds: string[];
  backfilledCount: number;
}

/** 装载场景包：签名 -> 持久化原始记录与主数据 */
export async function loadBundle(bundle: ScenarioBundle): Promise<LoaderStats> {
  const signed: RawRecord[] = [];
  for (const rec of bundle.raw) {
    const signature = await signRecord(rec);
    signed.push({ ...rec, signature });
  }
  await Promise.all([
    saveRawRecords(signed),
    saveLedger(bundle.ledger),
    saveZones(bundle.zones),
    saveRectifications(bundle.rectifications),
    saveRuleVersions(bundle.ruleVersions),
    saveManifest(bundle.manifest),
  ]);
  return {
    rawCount: signed.length,
    signedCount: signed.filter((r) => !!r.signature).length,
    batchIds: [...new Set(signed.map((r) => r.batchId))],
    backfilledCount: signed.filter((r) => r.backfilled).length,
  };
}

/** 验签：重新计算并比对，返回不一致记录 ID */
export async function verifySignatures(rows: RawRecord[]): Promise<string[]> {
  const bad: string[] = [];
  for (const row of rows) {
    const { signature: _sig, ...basis } = row;
    const expect = await signRecord(basis);
    if (expect !== row.signature) bad.push(row.id);
  }
  return bad;
}
