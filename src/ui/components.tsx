import type { Severity, SyncState } from '../core/types';

export function SeverityBadge({ value }: { value: Severity }) {
  return <span className={`badge ${value}`}>{value}</span>;
}

export function StateBadge({ value }: { value: SyncState }) {
  const map: Record<SyncState, { cls: string; text: string }> = {
    local: { cls: 'minor', text: '本地未同步' },
    synced: { cls: 'ok', text: '已同步' },
    conflict: { cls: 'bad', text: '同步冲突' },
  };
  return <span className={`badge ${map[value].cls}`}>{map[value].text}</span>;
}

export function hm(iso: string): string {
  return iso.slice(11, 16);
}

export function short(id: string, n = 8): string {
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(2)} KiB`;
}
