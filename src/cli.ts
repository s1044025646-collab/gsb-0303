#!/usr/bin/env node
/**
 * 命令行接口。既可操作 SQLite，也可在不落库的情况下直接解释地图文件。
 *
 * 用法见 README 或 `node dist/cli.js --help`。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Cell, LosError, isWall, parseGrid } from "./core/grid";
import { LosResult, RULE_VERSION, lineOfSight } from "./core/los";
import { FovResult, cellSet, computeFieldOfView, renderGrid } from "./core/fov";
import { Store } from "./store/db";

interface CliOptions {
  db: string;
  map?: number;
  radius?: number;
  json: boolean;
}

function usage(): string {
  return [
    "grid-los — 二维方格视线遮挡与可见区域后端 CLI",
    "",
    "用法：",
    "  grid-los import <地图.json|地图.txt> [--json]",
    "  grid-los los <ox> <oy> <tx> <ty> [--map N] [--radius R] [--db PATH] [--json]",
    "  grid-los fov <ox> <oy> [--map N] [--radius R] [--db PATH] [--json]",
    "  grid-los explain <ox> <oy> <tx> <ty> [--map N] [--radius R] [--db PATH]",
    "  grid-los render <ox> <oy> [--map N] [--radius R] [--db PATH]",
    "  grid-los maps [--db PATH] [--json]",
    "  grid-los history [--map N] [--db PATH] [--json]",
    "  grid-los get <报告ID> [--db PATH] [--json]",
    "  grid-los export <报告ID> [输出.json] [--db PATH]",
    "",
    "地图文件：JSON 二维数组（0/1）或等长文本行（# 为墙，. 为地面）。",
    "省略 --map 时使用最新版本；省略 --radius 时不限制半径。",
  ].join("\n");
}

function parseArgs(argv: string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = [];
  let options: CliOptions = {
    db: process.env.DB_PATH ?? path.join(process.cwd(), "data", "los.sqlite"),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const readValue = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new LosError("ARGS_INVALID", `参数 ${a} 缺少值`);
      return v;
    };
    if (a === "--db") options.db = readValue();
    else if (a.startsWith("--db=")) options.db = a.slice(5);
    else if (a === "--map") options.map = parseIntStrict(readValue(), "--map");
    else if (a.startsWith("--map=")) options.map = parseIntStrict(a.slice(6), "--map");
    else if (a === "--radius") options.radius = parseIntStrict(readValue(), "--radius");
    else if (a.startsWith("--radius=")) options.radius = parseIntStrict(a.slice(9), "--radius");
    else if (a === "--json") options.json = true;
    else if (a === "--help" || a === "-h") positional.push("__help__");
    else positional.push(a);
  }
  return { positional, options };
}

function parseIntStrict(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) throw new LosError("ARGS_INVALID", `${label} 必须是非负整数：${raw}`);
  return Number(raw);
}

function parseCoord(raw: string, label: string): number {
  if (!/^-?\d+$/.test(raw)) throw new LosError("COORD_INVALID", `${label} 必须是整数：${raw}`);
  return Number(raw);
}

function loadMapFile(file: string): number[][] | string[] {
  const text = fs.readFileSync(file, "utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as number[][];
  }
  return trimmed.split(/\r?\n/).filter((l) => l.length > 0);
}

function printExplain(result: LosResult): void {
  const o = result.observer;
  const t = result.target;
  console.log(`观察点 (${o.x},${o.y}) -> 目标 (${t.x},${t.y})` +
    (result.radius !== undefined ? `，半径 ${result.radius}` : ""));
  console.log(`结论：${result.visible ? "可见" : "不可见"}（${result.reason}），规则 ${result.ruleVersion}`);
  console.log("依次接触的格：");
  for (const tc of result.touched) {
    const tVal = `${tc.t.n}/${tc.t.d}`;
    let line = `  t=${tVal}  (${tc.x},${tc.y})  [${tc.kind}]  ${tc.wall ? "墙" : "地面"}`;
    if (tc.blockers && tc.blockers.length > 0) {
      line += `  阻挡集合: ${tc.blockers.map((b) => `(${b.x},${b.y})`).join(", ")}`;
    }
    console.log(line);
  }
  if (result.firstBlock) {
    const p = result.firstBlock;
    console.log(`首次阻挡位置：t=${p.t.n}/${p.t.d}，放大坐标 x=${p.x.n}/${p.x.d} y=${p.y.n}/${p.y.d}`);
    console.log(`阻挡墙格（稳定排序）：${result.blockers.map((b) => `(${b.x},${b.y})`).join(", ")}`);
  }
}

function printFovText(gridMap: { width: number; height: number }, grid: ReturnType<typeof parseGrid>, result: FovResult): void {
  console.log(`观察点 (${result.observer.x},${result.observer.y})` +
    (result.radius !== undefined ? `，半径 ${result.radius}` : "") +
    `，候选 ${result.candidates}，总解释步数 ${result.totalSteps}`);
  const vis = renderGrid(
    grid,
    result.observer,
    cellSet(result.visibleFloor),
    cellSet(result.visibleWalls),
  );
  console.log(vis);
  console.log(`可见地面 ${result.visibleFloor.length} 格，可见墙 ${result.visibleWalls.length} 格`);
  const reasons = Object.entries(result.invisibleReasonCounts);
  if (reasons.length > 0) {
    console.log("不可见原因统计：" + reasons.map(([k, v]) => `${k}=${v}`).join(", "));
  }
  void gridMap;
}

function printLosBrief(result: LosResult): void {
  console.log(`${result.visible ? "可见" : "不可见"}（${result.reason}）` +
    ` (${result.observer.x},${result.observer.y})->(${result.target.x},${result.target.y})` +
    ` 接触 ${result.steps} 格` +
    (result.blockers.length ? ` 阻挡: ${result.blockers.map((b) => `(${b.x},${b.y})`).join(",")}` : ""));
}

function main(): void {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "__help__") {
    console.log(usage());
    return;
  }

  const store = new Store(options.db);
  try {
    runCommand(cmd, positional.slice(1), options, store);
  } finally {
    store.close();
  }
}

function runCommand(cmd: string, args: string[], options: CliOptions, store: Store): void {
  switch (cmd) {
    case "import": {
      const file = args[0];
      if (!file) throw new LosError("ARGS_INVALID", "用法：import <地图文件>");
      const map = store.insertMap(loadMapFile(file));
      if (options.json) console.log(JSON.stringify(map, null, 2));
      else console.log(`已导入地图版本 #${map.id}（${map.width}x${map.height}，checksum ${map.checksum.slice(0, 12)}…）`);
      break;
    }
    case "los": {
      const [oxs, oys, txs, tys] = args;
      if (oxs === undefined || oys === undefined || txs === undefined || tys === undefined) {
        throw new LosError("ARGS_INVALID", "用法：los <ox> <oy> <tx> <ty>");
      }
      const observer: Cell = { x: parseCoord(oxs, "ox"), y: parseCoord(oys, "oy") };
      const target: Cell = { x: parseCoord(txs, "tx"), y: parseCoord(tys, "ty") };
      const { map, grid } = store.loadGrid(options.map);
      const result = lineOfSight(grid, observer, target, options.radius);
      const reportId = store.insertReport(map.id, "los", RULE_VERSION, {
        mapId: map.id, observer, target, radius: options.radius ?? null,
      }, result);
      if (options.json) console.log(JSON.stringify({ reportId, mapId: map.id, result }, null, 2));
      else {
        console.log(`报告 #${reportId}（地图版本 #${map.id}）`);
        printLosBrief(result);
      }
      break;
    }
    case "fov": {
      const [oxs, oys] = args;
      if (oxs === undefined || oys === undefined) throw new LosError("ARGS_INVALID", "用法：fov <ox> <oy>");
      const observer: Cell = { x: parseCoord(oxs, "ox"), y: parseCoord(oys, "oy") };
      const { map, grid } = store.loadGrid(options.map);
      const result = computeFieldOfView(grid, observer, options.radius);
      const reportId = store.insertReport(map.id, "fov", RULE_VERSION, {
        mapId: map.id, observer, radius: options.radius ?? null,
      }, result);
      if (options.json) console.log(JSON.stringify({ reportId, mapId: map.id, result }, null, 2));
      else {
        console.log(`报告 #${reportId}（地图版本 #${map.id}）`);
        printFovText(map, grid, result);
      }
      break;
    }
    case "explain": {
      const [oxs, oys, txs, tys] = args;
      if (oxs === undefined || oys === undefined || txs === undefined || tys === undefined) {
        throw new LosError("ARGS_INVALID", "用法：explain <ox> <oy> <tx> <ty>");
      }
      const observer: Cell = { x: parseCoord(oxs, "ox"), y: parseCoord(oys, "oy") };
      const target: Cell = { x: parseCoord(txs, "tx"), y: parseCoord(tys, "ty") };
      const { map, grid } = store.loadGrid(options.map);
      const result = lineOfSight(grid, observer, target, options.radius);
      const reportId = store.insertReport(map.id, "los", RULE_VERSION, {
        mapId: map.id, observer, target, radius: options.radius ?? null,
      }, result);
      console.log(`报告 #${reportId}（地图版本 #${map.id}）`);
      printExplain(result);
      break;
    }
    case "render": {
      const [oxs, oys] = args;
      if (oxs === undefined || oys === undefined) throw new LosError("ARGS_INVALID", "用法：render <ox> <oy>");
      const observer: Cell = { x: parseCoord(oxs, "ox"), y: parseCoord(oys, "oy") };
      const { map, grid } = store.loadGrid(options.map);
      const result = computeFieldOfView(grid, observer, options.radius);
      void isWall;
      printFovText(map, grid, result);
      break;
    }
    case "maps": {
      const maps = store.listMaps();
      if (options.json) console.log(JSON.stringify({ maps }, null, 2));
      else for (const m of maps) {
        console.log(`#${m.id}  ${m.width}x${m.height}  ${m.createdAt}  ${m.checksum.slice(0, 12)}…`);
      }
      break;
    }
    case "history": {
      const reports = store.listReports(options.map);
      if (options.json) console.log(JSON.stringify({ reports }, null, 2));
      else for (const r of reports) {
        console.log(`#${r.id}  map#${r.mapId}  ${r.kind}  ${r.ruleVersion}  ${r.createdAt}`);
      }
      break;
    }
    case "get": {
      const id = parseIntStrict(args[0] ?? "", "报告ID");
      const report = store.getReport(id);
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    case "export": {
      const id = parseIntStrict(args[0] ?? "", "报告ID");
      const outFile = args[1];
      const report = store.getReport(id);
      const map = store.getMap(report.mapId);
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), map, report }, null, 2);
      if (outFile) {
        fs.writeFileSync(outFile, payload, "utf8");
        console.log(`已导出报告 #${id} 与地图版本 #${map.id} 到 ${outFile}`);
      } else {
        console.log(payload);
      }
      break;
    }
    default:
      throw new LosError("ARGS_INVALID", `未知命令：${cmd}\n\n${usage()}`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof LosError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
