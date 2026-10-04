/**
 * 端到端演示：四种布局、查询、保存、“重启”后读取、编辑地图后的版本隔离。
 * 直接运行：npm run demo
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { parseGrid } from "./core/grid";
import { RULE_VERSION, lineOfSight } from "./core/los";
import { cellSet, computeFieldOfView, renderGrid } from "./core/fov";
import { Store } from "./store/db";

function heading(title: string): void {
  console.log("\n" + "=".repeat(64));
  console.log(title);
  console.log("=".repeat(64));
}

function losDemo(store: Store, rows: string[], name: string, ox: number, oy: number, tx: number, ty: number, radius?: number): void {
  heading(`场景：${name}`);
  const mapId = store.insertMap(rows).id;
  const { grid } = store.loadGrid(mapId);
  const fov = computeFieldOfView(grid, { x: ox, y: oy }, radius);
  console.log(renderGrid(grid, { x: ox, y: oy }, cellSet(fov.visibleFloor), cellSet(fov.visibleWalls)));
  console.log(`图例：@观察点 ·可见地面 ▓可见墙 #不可见墙 .不可见地面`);
  console.log(`可见地面=${fov.visibleFloor.length} 可见墙=${fov.visibleWalls.length} 候选=${fov.candidates} 总步数=${fov.totalSteps}`);
  console.log(`不可见原因统计：${JSON.stringify(fov.invisibleReasonCounts)}`);
  const los = lineOfSight(grid, { x: ox, y: oy }, { x: tx, y: ty }, radius);
  store.insertReport(mapId, "los", RULE_VERSION, { mapId, observer: { x: ox, y: oy }, target: { x: tx, y: ty }, radius: radius ?? null }, los);
  console.log(`视线 (${ox},${oy})->(${tx},${ty})：${los.visible ? "可见" : "不可见"}（${los.reason}），接触 ${los.steps} 格` +
    (los.blockers.length ? `，阻挡=${los.blockers.map((b) => `(${b.x},${b.y})`).join(",")}` : ""));
}

function main(): void {
  const dbPath = path.join(process.cwd(), "data", "demo.sqlite");
  fs.rmSync(dbPath, { force: true });
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });

  const store = new Store(dbPath);

  // 1) 无遮挡房间
  losDemo(
    store,
    [".......", ".......", ".......", ".......", ".......", ".......", "......."],
    "无遮挡房间",
    0, 0, 6, 6,
  );

  // 2) 单墙柱：中心立柱挡住对角线另一侧
  losDemo(
    store,
    [".......", ".......", ".......", "...#...", "....#..", ".......", "......."],
    "单墙柱遮挡",
    0, 0, 4, 4,
  );

  // 3) 狭窄走廊：只能沿走廊看出去
  losDemo(
    store,
    ["#######", "#.....#", "#.###.#", "#.....#", "###.#.#", "#####.#", "#######"],
    "狭窄走廊",
    1, 1, 5, 1,
  );

  // 4) 擦角点：光线 (0,0)->(2,2) 经过角点 (1,1)，任一侧邻墙即阻挡
  heading("场景：恰好擦过角点（侧邻有墙 -> 阻挡）");
  {
    const rows = ["...", ".#.", "..."]; // 角点 (1,1) 的下方侧邻 (1,1) 为墙
    const mapId = store.insertMap(rows).id;
    const { grid } = store.loadGrid(mapId);
    const r = lineOfSight(grid, { x: 0, y: 0 }, { x: 2, y: 2 });
    store.insertReport(mapId, "los", RULE_VERSION, { mapId, observer: { x: 0, y: 0 }, target: { x: 2, y: 2 }, radius: null }, r);
    console.log(`对角穿越：可见=${r.visible} 原因=${r.reason} 阻挡集合=${r.blockers.map((b) => `(${b.x},${b.y})`).join(",")}`);
    console.log("接触顺序：");
    for (const tc of r.touched) {
      console.log(`  t=${tc.t.n}/${tc.t.d} (${tc.x},${tc.y}) ${tc.kind} ${tc.wall ? "墙" : "地"}`);
    }
  }

  // 5) 尖角缝隙：两块对角墙把两个侧邻都占了 -> 保守阻挡，不能从尖角穿过
  heading("场景：两块对角墙的尖角缝隙（两侧邻皆墙 -> 阻挡）");
  {
    // 光线 (0,2)->(2,0) 在角点 (1,1) 处的两个侧邻是 (0,1) 与 (1,2)。
    const rows = ["..#", "#..", ".#."];
    const mapId = store.insertMap(rows).id;
    const { grid } = store.loadGrid(mapId);
    const r = lineOfSight(grid, { x: 0, y: 2 }, { x: 2, y: 0 });
    store.insertReport(mapId, "los", RULE_VERSION, { mapId, observer: { x: 0, y: 2 }, target: { x: 2, y: 0 }, radius: null }, r);
    console.log(`缝隙穿越：可见=${r.visible} 原因=${r.reason} 阻挡集合=${r.blockers.map((b) => `(${b.x},${b.y})`).join(",")}`);
  }

  // 6) 版本隔离：编辑同一布局（加墙）后，旧报告保持原结论
  heading("版本隔离：编辑地图后旧报告不被套用新墙体");
  {
    const v1 = store.insertMap(["...", "...", "..."]);
    const g1 = parseGrid(store.getMap(v1.id).grid);
    const before = lineOfSight(g1, { x: 0, y: 0 }, { x: 2, y: 2 });
    const reportId = store.insertReport(v1.id, "los", RULE_VERSION, { mapId: v1.id, observer: { x: 0, y: 0 }, target: { x: 2, y: 2 }, radius: null }, before);

    const v2 = store.insertMap([".#.", "...", "..."]);
    const g2 = parseGrid(store.getMap(v2.id).grid);
    const after = lineOfSight(g2, { x: 0, y: 0 }, { x: 2, y: 2 });

    const snapshot = store.getReport(reportId);
    console.log(`版本 #${v1.id}（无墙）：(0,0)->(2,2) ${before.visible ? "可见" : "不可见"}（${before.reason}），报告 #${reportId}`);
    console.log(`版本 #${v2.id}（加墙）：(0,0)->(2,2) ${after.visible ? "可见" : "不可见"}（${after.reason}）`);
    const snapResult = snapshot.result as ReturnType<typeof lineOfSight>;
    console.log(`重启/读取报告 #${reportId} 快照：${snapResult.visible ? "可见" : "不可见"}（${snapResult.reason}），地图版本=${snapshot.mapId}，规则=${snapshot.ruleVersion}`);
    console.log(`结论：快照仍为旧版本结果（${snapResult.reason === before.reason ? "隔离正确" : "隔离失败！"}）`);
  }

  const total = store.listReports().length;
  heading(`完成：共保存 ${total} 条报告，数据库位于 ${dbPath}`);
  console.log("重新打开该数据库（模拟重启）后可用以下命令复查：");
  console.log(`  node dist/cli.js history --db "${dbPath}"`);
  console.log(`  node dist/cli.js get 1 --db "${dbPath}"`);
  store.close();
}

main();
