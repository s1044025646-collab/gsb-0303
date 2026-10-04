/**
 * 可见区域：对半径内每个候选格调用同一核心视线规则。
 * 不做阴影投射等高性能优化；半径按格中心整数距离平方判定，边界取等号。
 */

import { Cell, Grid, LosError, inBounds, isWall, requireCell, requireInBounds } from "./grid";
import { LosResult, RULE_VERSION, lineOfSight } from "./los";

export interface FovCell {
  x: number;
  y: number;
  wall: boolean;
}

export type FovReasonStats = Record<string, number>;

export interface FovResult {
  observer: Cell;
  radius?: number;
  ruleVersion: string;
  visibleFloor: FovCell[];
  visibleWalls: FovCell[];
  invisibleReasonCounts: FovReasonStats;
  /** 半径内候选格总数（含观察格，不含越界格）。 */
  candidates: number;
  /** 本次批量计算调用核心视线的总解释步数（步数预算）。 */
  totalSteps: number;
}

export function computeFieldOfView(grid: Grid, observerIn: unknown, radius?: number): FovResult {
  const observer = requireCell(observerIn, "观察点 observer");
  requireInBounds(grid, observer, "观察点 observer");
  if (isWall(grid, observer.x, observer.y)) {
    throw new LosError("OBSERVER_ON_WALL", `观察点 (${observer.x},${observer.y}) 不能是墙格`);
  }
  if (radius !== undefined && radius !== null) {
    if (typeof radius !== "number" || !Number.isSafeInteger(radius) || radius < 0) {
      throw new LosError("RADIUS_INVALID", "半径 radius 必须是非负整数");
    }
  }
  const r = radius ?? null;
  const r2 = r === null ? null : r * r;

  const visibleFloor: FovCell[] = [];
  const visibleWalls: FovCell[] = [];
  const reasonCounts: FovReasonStats = {};
  let candidates = 0;
  let totalSteps = 0;

  // 候选按 (y,x) 行优先稳定遍历；结果集合本身也按此顺序。
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const dx = x - observer.x;
      const dy = y - observer.y;
      if (r2 !== null && dx * dx + dy * dy > r2) continue;
      candidates++;

      const res: LosResult = lineOfSight(grid, observer, { x, y }, r === null ? undefined : r);
      totalSteps += res.steps;
      if (res.visible) {
        const cell: FovCell = { x, y, wall: isWall(grid, x, y) };
        if (cell.wall) visibleWalls.push(cell);
        else visibleFloor.push(cell);
      } else {
        reasonCounts[res.reason] = (reasonCounts[res.reason] ?? 0) + 1;
      }
    }
  }

  return {
    observer,
    radius: r ?? undefined,
    ruleVersion: RULE_VERSION,
    visibleFloor,
    visibleWalls,
    invisibleReasonCounts: reasonCounts,
    candidates,
    totalSteps,
  };
}

/** 以可见集合渲染终端文本地图。返回多行字符串。 */
export function renderGrid(
  grid: Grid,
  observer: Cell,
  visibleFloor: ReadonlySet<string>,
  visibleWalls: ReadonlySet<string>,
): string {
  const key = (x: number, y: number) => `${x},${y}`;
  const lines: string[] = [];
  for (let y = 0; y < grid.height; y++) {
    let row = "";
    for (let x = 0; x < grid.width; x++) {
      const k = key(x, y);
      if (x === observer.x && y === observer.y) row += "@";
      else if (isWall(grid, x, y)) row += visibleWalls.has(k) ? "▓" : "#";
      else if (visibleFloor.has(k)) row += "·";
      else row += ".";
    }
    lines.push(row);
  }
  return lines.join("\n");
}

export function cellSet(cells: Array<{ x: number; y: number }>): Set<string> {
  return new Set(cells.map((c) => `${c.x},${c.y}`));
}

export { inBounds };
