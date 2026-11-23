// ============================================================
// 领域类型定义：装载器 / 对齐器 / 规则 / 核验 / 证据图 / 处置 / 同步
// ============================================================

export type RecordKind =
  | 'trajectory' // 巡检轨迹
  | 'valve_reading' // 阀井读数
  | 'ledger' // 设备台账
  | 'construction' // 施工清单
  | 'rectification'; // 整改回执

export type Confidence = 'high' | 'medium' | 'low';
export type Severity = 'info' | 'minor' | 'major' | 'critical';
export type RuleKind = 'missing' | 'jump' | 'contradiction' | 'overdue';
export type AlertStatus = 'open' | 'actioned' | 'closed';
export type CompressionRoute = 'A' | 'B';
export type SyncState = 'local' | 'synced' | 'conflict';
export type UserRole = 'supervisor' | 'inspector' | 'auditor';

// ---------------- 装载器：原始记录 ----------------
export interface RawRecord {
  id: string; // 装载器分配的本地 ID
  sourceId: string; // 上游系统原始 ID
  kind: RecordKind;
  payload: Record<string, unknown>;
  sampledAt: string; // 采样时间
  arrivedAt: string; // 到达时间
  confidence: Confidence;
  signature: string; // 内容哈希签名（装载时计算并固化）
  batchId: string;
  backfilled: boolean; // 离线补传
}

// ---------------- 台账 / 施工 / 回执 ----------------
export interface DeviceLedger {
  deviceId: string;
  name: string;
  aliases: string[];
  deviceType: 'valve_well' | 'pressure_sensor' | 'flow_sensor';
  standardUnit: string;
  rangeMin: number;
  rangeMax: number;
  warnThreshold: number;
  highThreshold: number;
  expectedIntervalMin: number; // 期望采样间隔（缺测判定）
  location: { lng: number; lat: number };
  declaredStatus: 'open' | 'closed' | 'fault';
  ledgerVersion: string;
}

export interface ConstructionZone {
  id: string;
  name: string;
  bbox: { lngMin: number; lngMax: number; latMin: number; latMax: number };
  affectedDevices: string[];
  startAt: string;
  endAt: string;
  graceIntervalMin: number; // 施工扰动宽限间隔
  suppressKinds: RuleKind[]; // 施工期间抑制的规则类型
}

export interface Rectification {
  id: string;
  alertSourceId: string | null; // 关联的上游告警 ID（可能缺失）
  deviceId: string;
  dueAt: string;
  closedAt: string | null;
  status: 'pending' | 'done' | 'rejected';
  note: string;
  arrivedAt: string;
}

// ---------------- 语义对齐 ----------------
export interface SemanticMapping {
  version: string;
  aliasMap: Record<string, string>; // 源别名 -> 规范 deviceId
  unitConversions: Record<string, { factor: number; offset: number }>; // 源单位 -> 标准单位
  coordSystem: 'WGS84' | 'GCJ02' | 'BD09';
  coordOffset: { dLng: number; dLat: number }; // 相对于 WGS84 的修正偏移
  updatedAt: string;
}

export interface CanonicalObservation {
  id: string;
  deviceId: string;
  value: number; // 已换算为标准单位
  sourceUnit: string;
  status: 'open' | 'closed' | 'fault';
  sampledAt: string;
  arrivedAt: string;
  confidence: Confidence;
  rawId: string;
  rawSignature: string;
  backfilled: boolean;
  networkDrift: boolean; // 到达延迟/乱序
  inConstruction: boolean;
  constructionId: string | null;
  location: { lng: number; lat: number };
}

// ---------------- 规则版本管理 ----------------
export interface RuleDef {
  id: string;
  kind: RuleKind;
  name: string;
  enabled: boolean;
  params: {
    missingGapMin?: number;
    jumpRangeRatio?: number; // 跳变幅度占量程比例
    contradictionTol?: number; // 状态/读数矛盾容忍
    overdueMin?: number; // 逾期宽限分钟
  };
  baseSeverity: Severity;
  constructionGrace: boolean;
}

export interface RuleVersion {
  id: string;
  publishedAt: string;
  active: boolean;
  changelog: string;
  rules: RuleDef[];
}

// ---------------- 告警（压缩成员） ----------------
export interface AlertContribution {
  severityScore: number; // 0-100
  rationale: string; // 逐成员贡献说明
  recommendation: string; // 该成员对处置建议的贡献
}

export interface Alert {
  id: string; // 内容寻址：sha256(canonical 业务字段)
  ruleId: string;
  ruleVersionId: string;
  ledgerVersion: string;
  mappingVersion: string;
  deviceId: string;
  kind: RuleKind;
  severity: Severity;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  evidenceRefs: string[]; // RawRecord.signature 列表
  detail: string;
  recommendation: string;
  contribution: AlertContribution;
  context: {
    inConstruction: boolean;
    constructionId: string | null;
    networkDrift: boolean;
    backfilled: boolean;
  };
}

// ---------------- 压缩事件 ----------------
export interface MembershipRecord {
  eventId: string;
  alertId: string;
  immutable: true;
  severityContribution: number;
  recommendationContribution: string;
  ruleVersionId: string;
  ledgerVersion: string;
  createdAt: string;
}

export interface CompressedWitness {
  deviceId: string;
  ruleId: string;
  ruleVersionId: string;
  ledgerVersion: string;
  windowStart: string;
  windowEnd: string;
  windowSlotMinutes: number;
  memberSlots: number[]; // 连续时间窗槽位编码
  alertRefs: string[]; // 内容寻址的原始告警引用
  severityScores: number[]; // 逐成员严重度分
  rationaleCodes: number[]; // 贡献说明字典码
  witnessHash: string;
  boundary: {
    prevSlotAlertId: string | null;
    nextSlotAlertId: string | null;
    passed: boolean;
    verifiedAt: string | null;
    note: string;
  };
}

export interface CompressionEvent {
  id: string;
  route: CompressionRoute;
  deviceId: string;
  ruleId: string;
  ruleVersionId: string;
  ledgerVersion: string;
  windowStart: string;
  windowEnd: string;
  severity: Severity;
  title: string;
  memberCount: number;
  status: AlertStatus;
  createdAt: string;
  memberships?: MembershipRecord[]; // 路线 A
  witness?: CompressedWitness; // 路线 B
  parentEventId: string | null; // 规则换版局部重算链
}

// ---------------- 证据图 ----------------
export type EvidenceNodeType =
  | 'observation'
  | 'ledger'
  | 'construction'
  | 'rectification'
  | 'alert'
  | 'event';

export interface EvidenceNode {
  id: string;
  type: EvidenceNodeType;
  label: string;
  sub: string;
}

export type EvidenceRelation =
  | 'derived_from'
  | 'about_device'
  | 'in_zone'
  | 'responded_by'
  | 'member_of'
  | 'contradicts';

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  relation: EvidenceRelation;
}

// ---------------- 处置簿 ----------------
export interface DisposalAction {
  id: string;
  eventId: string;
  deviceId: string;
  actor: string;
  role: UserRole;
  action: 'ack' | 'assign' | 'close' | 'annotate' | 'reopen';
  comment: string;
  at: string;
  baseVersion: number;
  syncState: SyncState;
}

// ---------------- 同步对照 ----------------
export interface SyncConflict {
  id: string;
  entityType: 'action' | 'event_status' | 'rectification';
  entityId: string;
  local: string;
  remote: string;
  resolution: 'pending' | 'keep_local' | 'take_remote' | 'merge';
}

export interface RouteStat {
  payloadBytes: number;
  membershipCount: number;
  witnessCount: number;
  indexCount: number;
}

export interface EquivalenceCheck {
  eventKey: string;
  sameMembers: boolean;
  sameSeverity: boolean;
  sameContributions: boolean;
  memberCountA: number;
  memberCountB: number;
  decodeMsB: number;
  missingBoundary: boolean;
}

export interface SyncReport {
  id: string;
  generatedAt: string;
  localRev: number;
  remoteRev: number;
  routeStats: Record<CompressionRoute, RouteStat>;
  conflicts: SyncConflict[];
  equivalence: EquivalenceCheck[];
}

// ---------------- 场景 ----------------
export interface ScenarioPhase {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  activeRuleVersionId: string;
  note: string;
}

export interface ScenarioManifest {
  id: string;
  name: string;
  description: string;
  ledgerVersion: string;
  mappingVersion: string;
  initialRuleVersionId: string;
  targetRuleVersionId: string;
  phases: ScenarioPhase[];
}

// ---------------- Worker 消息 ----------------
export interface VerifyRequest {
  type: 'verify';
  batchId: string;
  route: CompressionRoute | 'both';
  ruleVersionId: string;
}

export interface VerifyProgress {
  phase: string;
  done: number;
  total: number;
}

export interface VerifyResponse {
  type: 'verify_result';
  batchId: string;
  alertCount: number;
  eventCount: number;
  route: CompressionRoute | 'both';
  elapsedMs: number;
  decodeMs: number;
  report: SyncReport | null;
}
