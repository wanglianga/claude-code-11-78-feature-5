// ============================================================
// 规范化 JSON 与内容寻址哈希（浏览器 WebCrypto / Node 均可用）
// ============================================================

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/** 规范化序列化：键排序、无空白，保证同内容同字节 */
export function canonicalize(value: unknown): string {
  return stableStringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 内容寻址 ID：sha256(canonical(value)) 的 16 位短码（碰撞概率可忽略，便于 UI 展示） */
export async function contentId(value: unknown): Promise<string> {
  const full = await sha256Hex(canonicalize(value));
  return full.slice(0, 16);
}

/** 同步非加密哈希 FNV-1a，用于见证槽位/字典等本地索引 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function byteSize(value: unknown): number {
  return new TextEncoder().encode(canonicalize(value)).length;
}
