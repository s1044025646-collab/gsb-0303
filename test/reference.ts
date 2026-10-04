/**
 * 独立参考实现：用“闭方格方形与线段求交”判定视线，
 * 与 src/core/los.ts 的事件遍历是两套独立推导，用于交叉验证。
 *
 * 对每个格 C=[x,x+1]×[y,y+1]（闭集），用 slab 法在 BigInt 有理数下
 * 求线段（放大 2 倍中心参数化）与该闭方格的 t 交区间。
 * 墙格只要与 t∈[0,1) 相交（即在到达目标之前/之时但不含目标终点）就阻挡，
 * 但目标格本身除外（目标是墙时允许看见）。
 */

import type { Grid } from "../dist/core/grid.js";
import { isWall } from "../dist/core/grid.js";

interface Cell { x: number; y: number }
interface Frac { n: bigint; d: bigint } // d > 0

function fr(n: bigint, d: bigint): Frac {
  if (d < 0n) { n = -n; d = -d; }
  return { n, d };
}
function cmpF(a: Frac, b: Frac): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
function maxF(a: Frac, b: Frac): Frac { return cmpF(a, b) >= 0 ? a : b; }
function minF(a: Frac, b: Frac): Frac { return cmpF(a, b) <= 0 ? a : b; }

/**
 * 返回线段与闭格方形的 t 交区间；不相交返回 null。
 * 连续坐标直接用格中心 (ox+0.5)：乘以 2 得 X(t)=2ox+1+2dx*t。
 */
function intersectCell(
  ox: number, oy: number, dx: number, dy: number,
  cx: number, cy: number,
): { lo: Frac; hi: Frac } | null {
  // 闭区间 [2*cx, 2*cx+2]
  let lo: Frac = fr(0n, 1n);
  let hi: Frac = fr(1n, 1n);
  const axes: Array<[number, number, number]> = [
    [2 * dx, 2 * ox + 1, 2 * cx],
    [2 * dy, 2 * oy + 1, 2 * cy],
  ];
  for (const [v2, p2, bound] of axes) {
    const min = BigInt(bound - p2); // 下界分子（分母 2|v|）
    const max = BigInt(bound + 2 - p2);
    if (v2 === 0) {
      if (p2 < bound || p2 > bound + 2) return null;
      continue;
    }
    const den = BigInt(Math.abs(v2)); // v2=2*v 已含放大因子
    let a = fr(v2 > 0 ? min : -max, den);
    let b = fr(v2 > 0 ? max : -min, den);
    if (cmpF(a, b) > 0) { const tmp = a; a = b; b = tmp; }
    lo = maxF(lo, a);
    hi = minF(hi, b);
    if (cmpF(lo, hi) > 0) return null;
  }
  return { lo, hi };
}

export interface RefLos {
  visible: boolean;
  /** 与线段相交的墙格（按 (x,y) 排序），供阻挡集合对照。 */
  blockingWalls: Cell[];
}

export function referenceLos(grid: Grid, observer: Cell, target: Cell): RefLos {
  const dx = target.x - observer.x;
  const dy = target.y - observer.y;
  const blockingWalls: Cell[] = [];
  const one: Frac = fr(1n, 1n);

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (!isWall(grid, x, y)) continue;
      if (x === target.x && y === target.y) continue; // 目标墙允许看见
      if (x === observer.x && y === observer.y) continue;
      const hit = intersectCell(observer.x, observer.y, dx, dy, x, y);
      if (!hit) continue;
      // 交区间与 [0,1) 有交集即阻挡（含恰在 t<1 的擦角点）。
      if (cmpF(hit.lo, one) < 0 && cmpF(hit.hi, fr(0n, 1n)) >= 0) {
        blockingWalls.push({ x, y });
      }
    }
  }
  blockingWalls.sort((a, b) => (a.x - b.x || a.y - b.y));
  return { visible: blockingWalls.length === 0, blockingWalls };
}
