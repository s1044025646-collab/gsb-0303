/**
 * SQLite 持久化：地图版本与结果报告快照。
 * 报告写入时固化完整结果（含规则版本与地图版本），读取时只回放快照，
 * 永远不用当前地图重新计算旧报告，从而保证“换墙不影响旧报告”。
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Grid, LosError, gridToRows, parseGrid } from "../core/grid";
import { FovResult } from "../core/fov";
import { LosResult } from "../core/los";

export interface MapRecord {
  id: number;
  createdAt: string;
  width: number;
  height: number;
  checksum: string;
  grid: number[][];
}

export type ReportKind = "los" | "fov";

export interface ReportRecord {
  id: number;
  mapId: number;
  createdAt: string;
  kind: ReportKind;
  ruleVersion: string;
  request: unknown;
  result: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  grid_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL REFERENCES maps(id),
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('los','fov')),
  rule_version TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_map ON reports(map_id);
`;

export class Store {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** 导入新地图总是产生新版本。相同内容也会得到新版本（显式编辑）。 */
  insertMap(input: unknown): MapRecord {
    const grid = parseGrid(input);
    const rows = gridToRows(grid);
    const checksum = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const info = this.db
      .prepare(
        `INSERT INTO maps (created_at, width, height, checksum, grid_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), grid.width, grid.height, checksum, JSON.stringify(rows));
    return this.getMap(Number(info.lastInsertRowid));
  }

  getMap(id: number): MapRecord {
    const row = this.db.prepare(`SELECT * FROM maps WHERE id = ?`).get(id) as
      | {
          id: number;
          created_at: string;
          width: number;
          height: number;
          checksum: string;
          grid_json: string;
        }
      | undefined;
    if (!row) throw new LosError("MAP_NOT_FOUND", `地图版本 ${id} 不存在`, 404);
    return {
      id: row.id,
      createdAt: row.created_at,
      width: row.width,
      height: row.height,
      checksum: row.checksum,
      grid: JSON.parse(row.grid_json) as number[][],
    };
  }

  latestMap(): MapRecord {
    const row = this.db.prepare(`SELECT id FROM maps ORDER BY id DESC LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!row) throw new LosError("MAP_NOT_FOUND", "尚无地图版本，请先导入地图", 404);
    return this.getMap(row.id);
  }

  listMaps(): MapRecord[] {
    const rows = this.db.prepare(`SELECT id FROM maps ORDER BY id ASC`).all() as Array<{ id: number }>;
    return rows.map((r) => this.getMap(r.id));
  }

  /** 取地图并解析为核心 Grid；版本不存在返回 404。 */
  loadGrid(mapId?: number): { map: MapRecord; grid: Grid } {
    const map = mapId === undefined ? this.latestMap() : this.getMap(mapId);
    return { map, grid: parseGrid(map.grid) };
  }

  insertReport(
    mapId: number,
    kind: ReportKind,
    ruleVersion: string,
    request: unknown,
    result: LosResult | FovResult,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO reports (map_id, created_at, kind, rule_version, request_json, result_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mapId,
        new Date().toISOString(),
        kind,
        ruleVersion,
        JSON.stringify(request),
        JSON.stringify(result),
      );
    return Number(info.lastInsertRowid);
  }

  getReport(id: number): ReportRecord {
    const row = this.db
      .prepare(`SELECT * FROM reports WHERE id = ?`)
      .get(id) as
      | {
          id: number;
          map_id: number;
          created_at: string;
          kind: ReportKind;
          rule_version: string;
          request_json: string;
          result_json: string;
        }
      | undefined;
    if (!row) throw new LosError("REPORT_NOT_FOUND", `报告 ${id} 不存在`, 404);
    return {
      id: row.id,
      mapId: row.map_id,
      createdAt: row.created_at,
      kind: row.kind,
      ruleVersion: row.rule_version,
      request: JSON.parse(row.request_json),
      result: JSON.parse(row.result_json),
    };
  }

  listReports(mapId?: number): ReportRecord[] {
    const rows =
      mapId === undefined
        ? (this.db
            .prepare(`SELECT id FROM reports ORDER BY id ASC`)
            .all() as Array<{ id: number }>)
        : (this.db
            .prepare(`SELECT id FROM reports WHERE map_id = ? ORDER BY id ASC`)
            .all(mapId) as Array<{ id: number }>);
    return rows.map((r) => this.getReport(r.id));
  }
}
