// ============================================================
// 区间估计：Wilson 比例区间 / Newcombe 差值区间。
// 纯确定性计算，供安全界限计算器与门禁使用。
// 所有结果只用于“关联性估计”，不宣称未执行策略的真实收益。
// ============================================================

import type { Interval } from './safetyTypes';

/** 标准正态分位数（95% ≈ 1.959964） */
export function zFor(confidenceLevel: number): number {
  // 双尾；仅需支持 0.90 / 0.95 / 0.99 的常见值
  if (confidenceLevel >= 0.99) return 2.575829;
  if (confidenceLevel >= 0.95) return 1.959964;
  if (confidenceLevel >= 0.90) return 1.644854;
  return 1.959964;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Wilson score interval；n=0 时返回点 0 与 [0,0]，并标注不可估计 */
export function wilsonInterval(k: number, n: number, z: number): Interval {
  if (n <= 0) {
    return { point: 1, lower: 1, upper: 1, method: 'Wilson(n=0 不可估计)', n, k };
  }
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z / Math.sqrt(denom)) *
    Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    point: +p.toFixed(4),
    lower: +clamp01(center - half).toFixed(4),
    upper: +clamp01(center + half).toFixed(4),
    method: 'Wilson score',
    n,
    k,
  };
}

/**
 * Newcombe 混合得分差值区间（以两个 Wilson 区间构造），
 * 用于新旧策略延迟升级率之差的保守区间。
 */
export function newcombeDifference(
  k1: number,
  n1: number,
  k2: number,
  n2: number,
  z: number,
): Interval {
  if (n1 <= 0 || n2 <= 0) {
    return {
      point: 0,
      lower: -1,
      upper: 1,
      method: 'Newcombe(n不足 不可估计)',
      n: n1 + n2,
      k: k1 + k2,
    };
  }
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const w1 = wilsonInterval(k1, n1, z);
  const w2 = wilsonInterval(k2, n2, z);
  const d = p1 - p2;
  const lower = d - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2);
  const upper = d + Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2);
  return {
    point: +d.toFixed(4),
    lower: +Math.max(-1, lower).toFixed(4),
    upper: +Math.min(1, upper).toFixed(4),
    method: 'Newcombe hybrid score',
    n: n1 + n2,
    k: k1 + k2,
  };
}
