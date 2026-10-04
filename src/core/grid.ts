/**
 * 网格地图模型与参数校验。
 *
 * 约定：
 * - 格坐标为非负整数 (x, y)，x 为列（向右递增），y 为行（向下递增）。
 * - 格 (x, y) 的中心位于连续平面的 (x + 0.5, y + 0.5)。
 * - 格值：false = 可通行地面，true = 不透明墙。
 */

export const MAX_SIDE = 64;

export interface Cell {
  x: number;
  y: number;
}

export interface Grid {
  width: number;
  height: number;
  /** 行优先的一维布尔数组：walls[y * width + x] 为 true 表示墙。 */
  walls: boolean[];
}

/** 带稳定错误码的业务错误，HTTP 层据此映射状态码。 */
export class LosError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "LosError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

/**
 * 解析并严格校验导入的地图。
 * 接受二维 0/1 数组或等长字符串数组（'#' 或 '1' 为墙，其余字符为地面）。
 */
export function parseGrid(input: unknown): Grid {
  if (input == null || typeof input !== "object") {
    throw new LosError("MAP_INVALID", "地图必须是非空的二维数组");
  }
  const rows = input as unknown[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new LosError("MAP_EMPTY", "空地图被拒绝：至少需要一行");
  }
  if (rows.length > MAX_SIDE) {
    throw new LosError("MAP_TOO_LARGE", `地图高度超过上限 ${MAX_SIDE}`);
  }

  let width = -1;
  const walls: boolean[] = [];
  for (let y = 0; y < rows.length; y++) {
    const rawRow = rows[y];
    if (typeof rawRow === "string") {
      if (width === -1) width = rawRow.length;
      if (rawRow.length !== width) {
        throw new LosError("MAP_INVALID", `第 ${y} 行长度与首行不一致`);
      }
      if (width === 0) {
        throw new LosError("MAP_EMPTY", "空地图被拒绝：行宽为 0");
      }
      if (width > MAX_SIDE) {
        throw new LosError("MAP_TOO_LARGE", `地图宽度超过上限 ${MAX_SIDE}`);
      }
      for (let x = 0; x < width; x++) {
        const ch = rawRow[x];
        if (ch === "#" || ch === "1") walls.push(true);
        else if (ch === "." || ch === "0" || ch === " ") walls.push(false);
        else throw new LosError("MAP_INVALID", `第 ${y} 行含非法字符 '${ch}'（允许 # . 1 0 空格）`);
      }
    } else if (Array.isArray(rawRow)) {
      if (width === -1) width = rawRow.length;
      if (rawRow.length !== width) {
        throw new LosError("MAP_INVALID", `第 ${y} 行长度与首行不一致`);
      }
      if (width === 0) {
        throw new LosError("MAP_EMPTY", "空地图被拒绝：行宽为 0");
      }
      if (width > MAX_SIDE) {
        throw new LosError("MAP_TOO_LARGE", `地图宽度超过上限 ${MAX_SIDE}`);
      }
      for (let x = 0; x < width; x++) {
        const v = rawRow[x];
        if (v === 1 || v === true) walls.push(true);
        else if (v === 0 || v === false) walls.push(false);
        else throw new LosError("MAP_INVALID", `格 (${x},${y}) 必须是 0 或 1`);
      }
    } else {
      throw new LosError("MAP_INVALID", `第 ${y} 行必须是数组或字符串`);
    }
  }

  if (width <= 0 || walls.length === 0) {
    throw new LosError("MAP_EMPTY", "空地图被拒绝");
  }
  return { width, height: rows.length, walls };
}

export function isWall(grid: Grid, x: number, y: number): boolean {
  return grid.walls[y * grid.width + x];
}

export function inBounds(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

/** 要求坐标为安全整数（非整数、NaN、越界由各自错误码区分）。 */
export function requireCell(p: unknown, label: string): Cell {
  if (p == null || typeof p !== "object") {
    throw new LosError("COORD_INVALID", `${label} 必须是包含 x、y 的对象`);
  }
  const obj = p as Record<string, unknown>;
  if (!isInt(obj.x) || !isInt(obj.y)) {
    throw new LosError("COORD_INVALID", `${label} 的 x、y 必须是整数`);
  }
  return { x: obj.x as number, y: obj.y as number };
}

export function requireInBounds(grid: Grid, p: Cell, label: string): void {
  if (!inBounds(grid, p.x, p.y)) {
    throw new LosError(
      "COORD_OUT_OF_BOUNDS",
      `${label} (${p.x},${p.y}) 超出地图（尺寸 ${grid.width}x${grid.height}）`,
    );
  }
}

/** 序列化为 0/1 二维数组，便于落库与 JSON 导出。 */
export function gridToRows(grid: Grid): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < grid.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < grid.width; x++) row.push(grid.walls[y * grid.width + x] ? 1 : 0);
    rows.push(row);
  }
  return rows;
}
