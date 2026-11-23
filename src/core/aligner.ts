// ============================================================
// 语义对齐器：别名映射、单位量程换算、坐标系修正、施工范围判定。
// 纯函数实现，Worker 与单测共用；对齐结果保留原始签名引用。
// ============================================================

import type {
  CanonicalObservation,
  ConstructionZone,
  DeviceLedger,
  RawRecord,
  SemanticMapping,
} from './types';

const DRIFT_THRESHOLD_MIN = 10;

export class AlignmentError extends Error {
  constructor(
    message: string,
    public rawId: string,
  ) {
    super(message);
  }
}

function findZone(
  zones: ConstructionZone[],
  deviceId: string,
  at: string,
): ConstructionZone | null {
  const ts = new Date(at).getTime();
  return (
    zones.find(
      (z) =>
        z.affectedDevices.includes(deviceId) &&
        ts >= new Date(z.startAt).getTime() &&
        ts <= new Date(z.endAt).getTime(),
    ) ?? null
  );
}

/** 单条读数对齐；无法映射别名/单位时抛 AlignmentError（装载页可统计失败行） */
export function alignReading(
  raw: RawRecord,
  ledger: DeviceLedger[],
  mapping: SemanticMapping,
  zones: ConstructionZone[],
  seenArrivals: Map<string, number>,
): CanonicalObservation {
  const alias = String(raw.payload.deviceAlias ?? '');
  const deviceId = mapping.aliasMap[alias];
  if (!deviceId) throw new AlignmentError(`未登记的设备别名：${alias}`, raw.id);
  const device = ledger.find((d) => d.deviceId === deviceId);
  if (!device) throw new AlignmentError(`台账缺失设备：${deviceId}`, raw.id);

  const sourceUnit = String(raw.payload.unit ?? '');
  const conv = mapping.unitConversions[sourceUnit];
  if (!conv) throw new AlignmentError(`不支持的源单位：${sourceUnit}`, raw.id);
  const rawValue = Number(raw.payload.value);
  const value = rawValue * conv.factor + conv.offset;

  // 坐标修正：源坐标为 GCJ02/BD09 时按映射偏移修正到 WGS84
  const srcLng = Number(raw.payload.lng);
  const srcLat = Number(raw.payload.lat);
  const location = {
    lng: +(srcLng + mapping.coordOffset.dLng).toFixed(6),
    lat: +(srcLat + mapping.coordOffset.dLat).toFixed(6),
  };

  const arrivalMs = new Date(raw.arrivedAt).getTime();
  const sampleMs = new Date(raw.sampledAt).getTime();
  const delayMin = (arrivalMs - sampleMs) / 60000;
  const prevArrival = seenArrivals.get(deviceId);
  const outOfOrder = prevArrival !== undefined && arrivalMs < prevArrival;
  seenArrivals.set(deviceId, Math.max(prevArrival ?? 0, arrivalMs));
  const networkDrift = delayMin >= DRIFT_THRESHOLD_MIN || outOfOrder;

  const zone = findZone(zones, deviceId, raw.sampledAt);

  return {
    id: `${deviceId}@${raw.sampledAt}`,
    deviceId,
    value,
    sourceUnit,
    status: raw.payload.status as CanonicalObservation['status'],
    sampledAt: raw.sampledAt,
    arrivedAt: raw.arrivedAt,
    confidence: raw.confidence,
    rawId: raw.id,
    rawSignature: raw.signature,
    backfilled: raw.backfilled,
    networkDrift,
    inConstruction: !!zone,
    constructionId: zone?.id ?? null,
    location,
  };
}

export interface AlignmentResult {
  observations: CanonicalObservation[];
  failures: Array<{ rawId: string; reason: string }>;
}

/** 全量对齐：按设备分组、按采样时间排序后再判定乱序 */
export function alignAll(
  raw: RawRecord[],
  ledger: DeviceLedger[],
  mapping: SemanticMapping,
  zones: ConstructionZone[],
): AlignmentResult {
  const readings = raw
    .filter((r) => r.kind === 'valve_reading')
    .sort((a, b) =>
      String(a.payload.deviceAlias).localeCompare(String(b.payload.deviceAlias)),
    );
  const observations: CanonicalObservation[] = [];
  const failures: AlignmentResult['failures'] = [];
  const seen = new Map<string, number>();
  let currentAlias = '';
  const deviceRows: RawRecord[] = [];

  const flush = () => {
    deviceRows.sort((a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime());
    for (const row of deviceRows) {
      try {
        observations.push(alignReading(row, ledger, mapping, zones, seen));
      } catch (e) {
        if (e instanceof AlignmentError) failures.push({ rawId: e.rawId, reason: e.message });
        else throw e;
      }
    }
    deviceRows.length = 0;
  };

  for (const row of readings) {
    const alias = String(row.payload.deviceAlias ?? '');
    if (alias !== currentAlias) {
      flush();
      currentAlias = alias;
    }
    deviceRows.push(row);
  }
  flush();

  observations.sort(
    (a, b) =>
      new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime() ||
      a.deviceId.localeCompare(b.deviceId),
  );
  return { observations, failures };
}

/** 量程越界检查（供规则页/核验引用） */
export function outOfRange(o: CanonicalObservation, d: DeviceLedger): boolean {
  return o.value < d.rangeMin || o.value > d.rangeMax;
}
