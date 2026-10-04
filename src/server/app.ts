/**
 * HTTP API（仅后端 JSON）。所有失败输入返回明确错误码，且不写入成功报告。
 */

import express, { NextFunction, Request, Response } from "express";

import { LosError } from "../core/grid";
import { RULE_VERSION, lineOfSight } from "../core/los";
import { computeFieldOfView } from "../core/fov";
import { Store } from "../store/db";

export function createApp(store: Store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ruleVersion: RULE_VERSION });
  });

  // ---------- 地图 ----------
  app.post("/api/maps", (req, res, next) => {
    try {
      const rows = (req.body as { rows?: unknown }).rows ?? (req.body as { grid?: unknown }).grid;
      const map = store.insertMap(rows);
      res.status(201).json(map);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/maps", (_req, res, next) => {
    try {
      res.json({ maps: store.listMaps() });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/maps/latest", (_req, res, next) => {
    try {
      res.json(store.latestMap());
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/maps/:id", (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      res.json(store.getMap(id));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 单条视线 ----------
  app.post("/api/los", (req, res, next) => {
    try {
      const body = req.body as {
        mapId?: number;
        observer?: unknown;
        target?: unknown;
        radius?: number;
      };
      if (!body || typeof body !== "object") throw new LosError("BODY_INVALID", "请求体必须是 JSON 对象");
      const { map, grid } = store.loadGrid(parseOptionalId(body.mapId));
      const result = lineOfSight(grid, body.observer, body.target, body.radius);
      const reportId = store.insertReport(map.id, "los", RULE_VERSION, {
        mapId: map.id,
        observer: result.observer,
        target: result.target,
        radius: result.radius ?? null,
      }, result);
      res.status(201).json({ reportId, mapId: map.id, mapChecksum: map.checksum, result });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 可见区域 ----------
  app.post("/api/fov", (req, res, next) => {
    try {
      const body = req.body as { mapId?: number; observer?: unknown; radius?: number };
      if (!body || typeof body !== "object") throw new LosError("BODY_INVALID", "请求体必须是 JSON 对象");
      const { map, grid } = store.loadGrid(parseOptionalId(body.mapId));
      const result = computeFieldOfView(grid, body.observer, body.radius);
      const reportId = store.insertReport(map.id, "fov", RULE_VERSION, {
        mapId: map.id,
        observer: result.observer,
        radius: result.radius ?? null,
      }, result);
      res.status(201).json({ reportId, mapId: map.id, mapChecksum: map.checksum, result });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 历史与导出 ----------
  app.get("/api/reports", (req, res, next) => {
    try {
      const mapId = req.query.mapId === undefined ? undefined : parseId(String(req.query.mapId));
      res.json({ reports: store.listReports(mapId) });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/reports/:id", (req, res, next) => {
    try {
      res.json(store.getReport(parseId(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  // JSON 导出：报告快照 + 对应地图版本快照（离线复查，不依赖当前地图）。
  app.get("/api/reports/:id/export", (req, res, next) => {
    try {
      const report = store.getReport(parseId(req.params.id));
      const map = store.getMap(report.mapId);
      res.setHeader("Content-Disposition", `attachment; filename="report-${report.id}.json"`);
      res.json({ exportedAt: new Date().toISOString(), map, report });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 错误处理 ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof LosError) {
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: { code: "BODY_INVALID", message: "JSON 解析失败" } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: { code: "INTERNAL", message } });
  });

  return app;
}

function parseId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new LosError("ID_INVALID", `ID 必须是非负整数：${raw}`);
  return Number(raw);
}

function parseOptionalId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  throw new LosError("ID_INVALID", "mapId 必须是非负整数");
}
