import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Store } from "../dist/store/db.js";
import { parseGrid } from "../dist/core/grid.js";
import { lineOfSight } from "../dist/core/los.js";

let tmpDb = "";

function freshStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grid-los-"));
  tmpDb = path.join(dir, "test.sqlite");
  return new Store(tmpDb);
}

afterEach(() => {
  // 各用例自建库；这里不持有句柄，无需统一关闭。
});

describe("SQLite 持久化与版本隔离", () => {
  it("重复导入产生递增版本", () => {
    const store = freshStore();
    const a = store.insertMap(["..", ".."]);
    const b = store.insertMap(["..", ".."]);
    assert.equal(b.id, a.id + 1);
    store.close();
  });

  it("编辑地图后旧报告仍保留旧结果（快照不重算）", () => {
    const store = freshStore();
    const v1 = store.insertMap(["...", "...", "..."]);
    const g1 = parseGrid(store.getMap(v1.id).grid);
    const before = lineOfSight(g1, { x: 0, y: 0 }, { x: 2, y: 2 });
    const reportId = store.insertReport(v1.id, "los", before.ruleVersion,
      { observer: { x: 0, y: 0 }, target: { x: 2, y: 2 } }, before);

    const v2 = store.insertMap([".#.", "...", "..."]);
    const g2 = parseGrid(store.getMap(v2.id).grid);
    const after = lineOfSight(g2, { x: 0, y: 0 }, { x: 2, y: 2 });
    assert.equal(before.visible, true);
    assert.equal(after.visible, false);

    const snap = store.getReport(reportId);
    assert.equal(snap.mapId, v1.id);
    assert.equal((snap.result as { visible: boolean }).visible, true);
    store.close();
  });

  it("关闭后重新打开数据库（模拟重启）可复查同一结果", () => {
    const store = freshStore();
    const v1 = store.insertMap(["...", ".#.", "..."]);
    const g1 = parseGrid(store.getMap(v1.id).grid);
    const r = lineOfSight(g1, { x: 1, y: 0 }, { x: 1, y: 2 });
    const id = store.insertReport(v1.id, "los", r.ruleVersion,
      { observer: { x: 1, y: 0 }, target: { x: 1, y: 2 } }, r);
    store.close();

    const reopened = new Store(tmpDb);
    const snap = reopened.getReport(id);
    assert.equal((snap.result as { reason: string }).reason, "blocked_by_wall");
    assert.equal(snap.ruleVersion, r.ruleVersion);
    reopened.close();
  });

  it("按地图版本过滤历史", () => {
    const store = freshStore();
    const v1 = store.insertMap(["..", ".."]);
    const v2 = store.insertMap(["...", "...", "..."]);
    const g1 = parseGrid(store.getMap(v1.id).grid);
    const g2 = parseGrid(store.getMap(v2.id).grid);
    store.insertReport(v1.id, "los", "v", {}, lineOfSight(g1, { x: 0, y: 0 }, { x: 1, y: 0 }));
    store.insertReport(v2.id, "los", "v", {}, lineOfSight(g2, { x: 0, y: 0 }, { x: 2, y: 2 }));
    assert.equal(store.listReports().length, 2);
    assert.equal(store.listReports(v2.id).length, 1);
    assert.equal(store.listReports(v2.id)[0].mapId, v2.id);
    store.close();
  });

  it("不存在的地图/报告返回 404 错误码", () => {
    const store = freshStore();
    assert.throws(() => store.getMap(999), (e: { code?: string }) => e.code === "MAP_NOT_FOUND");
    assert.throws(() => store.getReport(999), (e: { code?: string }) => e.code === "REPORT_NOT_FOUND");
    store.close();
  });
});
