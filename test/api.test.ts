import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createApp } from "../dist/server/app.js";
import { Store } from "../dist/store/db.js";
import { resolvePort } from "../dist/server/main.js";

const base = () => `http://127.0.0.1:${port}`;
let store: Store;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let port: number;
let mapId = 0;

async function jsonRequest(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base() + urlPath, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grid-los-api-"));
  store = new Store(path.join(dir, "api.sqlite"));
  port = await resolvePort(0);
  await new Promise<void>((resolve) => {
    server = createApp(store).listen(port, resolve);
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

describe("HTTP API 端到端", () => {
  it("健康检查", async () => {
    const r = await jsonRequest("GET", "/api/health");
    assert.equal(r.status, 200);
    assert.match(r.body.ruleVersion, /^grid-los-/);
  });

  it("导入地图并查询视线（成功，生成报告）", async () => {
    const imp = await jsonRequest("POST", "/api/maps", { rows: ["...", ".#.", "..."] });
    assert.equal(imp.status, 201);
    mapId = imp.body.id;

    const los = await jsonRequest("POST", "/api/los", {
      mapId, observer: { x: 1, y: 0 }, target: { x: 1, y: 2 },
    });
    assert.equal(los.status, 201);
    assert.equal(los.body.result.visible, false);
    assert.equal(los.body.result.reason, "blocked_by_wall");
    assert.equal(typeof los.body.reportId, "number");
  });

  it("可见区域批量查询含原因统计与步数预算", async () => {
    const r = await jsonRequest("POST", "/api/fov", { mapId, observer: { x: 0, y: 0 } });
    assert.equal(r.status, 201);
    assert.ok(r.body.result.visibleFloor.length >= 1);
    assert.ok(r.body.result.totalSteps > 0);
    assert.ok("blocked_by_wall" in r.body.result.invisibleReasonCounts);
  });

  it("越界目标返回 200 且原因独立，仍生成报告", async () => {
    const before = (await jsonRequest("GET", "/api/reports")).body.reports.length;
    const r = await jsonRequest("POST", "/api/los", {
      mapId, observer: { x: 0, y: 0 }, target: { x: 9, y: 9 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.result.reason, "target_out_of_map");
    const after = (await jsonRequest("GET", "/api/reports")).body.reports.length;
    assert.equal(after, before + 1);
  });

  it("失败输入返回错误码且不生成成功报告", async () => {
    const before = (await jsonRequest("GET", "/api/reports")).body.reports.length;
    const bad = await jsonRequest("POST", "/api/los", {
      mapId, observer: { x: 1, y: 1 }, target: { x: 0, y: 0 }, // 观察点是墙
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "OBSERVER_ON_WALL");
    const badMap = await jsonRequest("POST", "/api/maps", { rows: [] });
    assert.equal(badMap.status, 400);
    assert.equal(badMap.body.error.code, "MAP_EMPTY");
    const after = (await jsonRequest("GET", "/api/reports")).body.reports.length;
    assert.equal(after, before);
  });

  it("历史读取与 JSON 导出包含地图与报告快照", async () => {
    const hist = await jsonRequest("GET", `/api/reports?mapId=${mapId}`);
    assert.equal(hist.status, 200);
    assert.ok(hist.body.reports.length >= 2);
    const id = hist.body.reports[0].id;
    const exp = await jsonRequest("GET", `/api/reports/${id}/export`);
    assert.equal(exp.status, 200);
    assert.equal(exp.body.map.id, mapId);
    assert.equal(exp.body.report.id, id);
  });

  it("不存在资源返回 404", async () => {
    const r = await jsonRequest("GET", "/api/maps/9999");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "MAP_NOT_FOUND");
  });
});
