/**
 * 视线（Line of Sight）核心。
 *
 * 自行实现精确的网格穿越，不使用任何现成视场库。
 *
 * 观察点 O=(ox,oy)、目标 T=(tx,ty) 为格坐标（整数），端点在格中心。
 * 参数化线段：P(t) = (2*ox+1, 2*oy+1) + t * (2*dx, 2*dy)，t∈[0,1]。
 * 中心坐标放大 2 倍后，所有网格边界交点参数都是整数/整数的有理数，
 * 比较先后一律交叉相乘（compareRationals），不使用浮点 epsilon。
 *
 * 角点规则（保守）：线段恰好经过网格角点时，同时接触两个“侧邻格”
 * 与对角格；这三个被接触格中任一为墙即阻挡。特别地，两个侧邻格
 * 必须同为地面才允许贴着角点穿过（不能从两块墙的尖角缝隙穿过）。
 */

import { Cell, Grid, LosError, inBounds, isWall, requireCell, requireInBounds } from "./grid";

export const RULE_VERSION = "grid-los-1.0.0";

/** 有理数 n/d（d > 0），用于表示交点参数 t 与精确坐标。 */
export interface Rational {
  n: number;
  d: number;
}

export type TouchKind = "start" | "edge" | "corner" | "target";

/** 线段依次接触到的一个格（解释步数）。 */
export interface TouchedCell {
  x: number;
  y: number;
  kind: TouchKind;
  /** 接触该格的线段参数 t（0..1 的有理数）。 */
  t: Rational;
  /** 是否为墙格。 */
  wall: boolean;
  /** 当此步产生阻挡时，参与阻挡的稳定排序墙格集合。 */
  blockers?: Cell[];
}

export type LosReason =
  | "visible"
  | "blocked_by_wall"
  | "target_is_wall"
  | "target_out_of_map"
  | "out_of_radius";

export interface LosResult {
  visible: boolean;
  reason: LosReason;
  observer: Cell;
  target: Cell;
  radius?: number;
  ruleVersion: string;
  /** 线段依次接触的格（含观察格与目标格）。 */
  touched: TouchedCell[];
  /** 首次阻挡位置（被接触墙所在的交点），无阻挡为 null。 */
  firstBlock: { x: Rational; y: Rational; t: Rational } | null;
  /** 首次阻挡的稳定排序墙格集合。 */
  blockers: Cell[];
  steps: number;
}

/** 比较两个非负有理数：返回 -1/0/1。 */
export function compareRationals(a: Rational, b: Rational): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function rat(n: number, d: number): Rational {
  if (d <= 0) throw new LosError("INTERNAL", "有理数分母必须为正", 500);
  return { n, d };
}

interface XEvent {
  axis: "x" | "y";
  /** 越过的边界网格线坐标。 */
  line: number;
  t: Rational;
}

function sortedCells(cells: Cell[]): Cell[] {
  return [...cells].sort((a, b) => (a.x - b.x || a.y - b.y));
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * 计算观察点到目标点的完整视线结果。
 * 目标格可以是墙（允许“看见这块墙”）；观察格必须是地面。
 */
export function lineOfSight(
  grid: Grid,
  observerIn: unknown,
  targetIn: unknown,
  radius?: number,
): LosResult {
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

  const target = requireCell(targetIn, "目标点 target");
  const resultBase = {
    observer,
    target,
    radius: radius ?? undefined,
    ruleVersion: RULE_VERSION,
  };

  // 目标超出地图：给出独立原因，不接触任何格。
  if (!inBounds(grid, target.x, target.y)) {
    return {
      ...resultBase,
      visible: false,
      reason: "target_out_of_map",
      touched: [],
      firstBlock: null,
      blockers: [],
      steps: 0,
    };
  }

  const dx = target.x - observer.x;
  const dy = target.y - observer.y;
  const dist2 = dx * dx + dy * dy;
  if (radius !== undefined && radius !== null && dist2 > radius * radius) {
    return {
      ...resultBase,
      visible: false,
      reason: "out_of_radius",
      touched: [],
      firstBlock: null,
      blockers: [],
      steps: 0,
    };
  }

  const touched: TouchedCell[] = [];
  const targetWall = isWall(grid, target.x, target.y);

  // 观察格到自身（必为地面）。
  if (dx === 0 && dy === 0) {
    touched.push({
      x: observer.x,
      y: observer.y,
      kind: "start",
      t: rat(0, 1),
      wall: false,
    });
    return {
      ...resultBase,
      visible: true,
      reason: "visible",
      touched,
      firstBlock: null,
      blockers: [],
      steps: touched.length,
    };
  }

  // 收集所有网格边界穿越事件，t∈(0,1)。
  const events: XEvent[] = [];
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // 竖直线（x 网格线）：t = k / (2|dx|)，k 取奇数 1..2|dx|-1。
  for (let k = 1; k < 2 * adx; k += 2) {
    events.push({ axis: "x", line: 0, t: rat(k, 2 * adx) });
  }
  // 水平线（y 网格线）：t = k / (2|dy|)，k 取奇数 1..2|dy|-1。
  for (let k = 1; k < 2 * ady; k += 2) {
    events.push({ axis: "y", line: 0, t: rat(k, 2 * ady) });
  }
  events.sort((a, b) => compareRationals(a.t, b.t));

  // 交点处放大坐标：X(t)=2*ox+1+2*dx*t，Y 同理。
  const pointAt = (t: Rational): { x: Rational; y: Rational } => ({
    x: rat((2 * observer.x + 1) * t.d + 2 * dx * t.n, t.d),
    y: rat((2 * observer.y + 1) * t.d + 2 * dy * t.n, t.d),
  });

  const pushTouch = (tc: TouchedCell): void => {
    touched.push(tc);
  };

  // 起点。
  pushTouch({
    x: observer.x,
    y: observer.y,
    kind: "start",
    t: rat(0, 1),
    wall: false,
  });

  let cx = observer.x;
  let cy = observer.y;
  let blocked = false;
  let firstBlock: LosResult["firstBlock"] = null;
  let blockers: Cell[] = [];

  let i = 0;
  while (i < events.length && !blocked) {
    const t = events[i].t;
    // 找出同一 t 的全部事件（交叉相乘判等，杜绝 epsilon）。
    const group: XEvent[] = [];
    while (i < events.length && compareRationals(events[i].t, t) === 0) {
      group.push(events[i]);
      i++;
    }

    const hasX = group.some((e) => e.axis === "x");
    const hasY = group.some((e) => e.axis === "y");

    if (hasX && hasY) {
      // 恰好通过网格角点：同时接触对角格与两个侧邻格。
      const sx = dx > 0 ? 1 : -1;
      const sy = dy > 0 ? 1 : -1;
      const diag: Cell = { x: cx + sx, y: cy + sy };
      const sideX: Cell = { x: cx + sx, y: cy }; // 竖直线另一侧
      const sideY: Cell = { x: cx, y: cy + sy }; // 水平线另一侧

      const touchedWalls = sortedCells(
        [sideX, sideY, diag].filter((c) => inBounds(grid, c.x, c.y) && isWall(grid, c.x, c.y)),
      );

      // 该角点处接触到的格集合，按 (x,y) 稳定排序。
      const groupCells = sortedCells([diag, sideX, sideY]);
      for (const c of groupCells) {
        const wall = inBounds(grid, c.x, c.y) && isWall(grid, c.x, c.y);
        pushTouch({
          x: c.x,
          y: c.y,
          kind: "corner",
          t,
          wall,
          blockers: touchedWalls.length > 0 && wall ? touchedWalls : undefined,
        });
      }

      if (touchedWalls.length > 0) {
        blocked = true;
        blockers = touchedWalls;
        firstBlock = { ...pointAt(t), t };
      } else {
        cx = diag.x;
        cy = diag.y;
      }
    } else {
      // 普通边界穿越：进入唯一相邻格。
      const e = group[0];
      if (e.axis === "x") cx += dx > 0 ? 1 : -1;
      else cy += dy > 0 ? 1 : -1;

      const wall = isWall(grid, cx, cy);
      pushTouch({ x: cx, y: cy, kind: "edge", t, wall });

      if (wall) {
        blocked = true;
        blockers = [{ x: cx, y: cy }];
        firstBlock = { ...pointAt(t), t };
      }
    }
  }

  // 到达目标格（t=1）。若在目标之前已被挡，则目标不可见且不再接触目标。
  if (!blocked) {
    // 数值安全校验：穿越结束位置应等于目标格。
    if (cx !== target.x || cy !== target.y) {
      throw new LosError("INTERNAL", `穿越终止格 (${cx},${cy}) 与目标 (${target.x},${target.y}) 不一致`, 500);
    }
    // 若最后一次边界穿越（t<1）进入的就是目标格，则它已被记录；
    // 否则在 t=1 补记目标（例如视线在格内部结束的水平/竖直线段最后一格之外）。
    const lastTouch = touched[touched.length - 1];
    const enteredTarget = lastTouch && lastTouch.x === target.x && lastTouch.y === target.y;
    if (enteredTarget) {
      // 目标格可能在最后一次角点/边界穿越时已被接触；规范化其类型为 target。
      lastTouch.kind = "target";
    } else {
      pushTouch({ x: target.x, y: target.y, kind: "target", t: rat(1, 1), wall: targetWall });
    }
  }

  let reason: LosReason;
  let visible: boolean;
  if (blocked) {
    // 被挡点恰为目标格（目标是墙，允许看见这面墙）。
    const blockIsTarget = blockers.every((b) => sameCell(b, target));
    if (blockIsTarget && targetWall) {
      reason = "target_is_wall";
      visible = true;
    } else {
      reason = "blocked_by_wall";
      visible = false;
    }
  } else {
    reason = targetWall ? "target_is_wall" : "visible";
    visible = true;
  }

  return {
    ...resultBase,
    visible,
    reason,
    touched,
    firstBlock,
    blockers: visible && reason === "target_is_wall" ? (blockers.length ? blockers : [target]) : blockers,
    steps: touched.length,
  };
}
