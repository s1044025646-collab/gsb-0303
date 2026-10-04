import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGrid } from "../dist/core/grid.js";
import { lineOfSight } from "../dist/core/los.js";
import { computeFieldOfView } from "../dist/core/fov.js";
import { referenceLos } from "./reference.ts";

/** 确定性伪随机，保证测试可复放。 */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMap(rnd: () => number, w: number, h: number, density: number): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) row.push(rnd() < density ? 1 : 0);
    row;
    rows.push(row);
  }
  return rows;
}

describe("与独立闭方格求交实现交叉验证", () => {
  it("在大量随机地图与随机线段上结论一致", () => {
    const rnd = mulberry(20261003);
    let cases = 0;
    for (let m = 0; m < 120; m++) {
      const w = 2 + Math.floor(rnd() * 8);
      const h = 2 + Math.floor(rnd() * 8);
      const rows = randomMap(rnd, w, h, 0.28);
      const grid = parseGrid(rows);
      for (let q = 0; q < 24; q++) {
        const ox = Math.floor(rnd() * w);
        const oy = Math.floor(rnd() * h);
        if (rows[oy][ox] === 1) continue; // 观察点必须地面
        const tx = Math.floor(rnd() * w);
        const ty = Math.floor(rnd() * h);
        const mine = lineOfSight(grid, { x: ox, y: oy }, { x: tx, y: ty });
        const ref = referenceLos(grid, { x: ox, y: oy }, { x: tx, y: ty });
        assert.equal(
          mine.visible,
          ref.visible,
          `map#${m} (${ox},${oy})->(${tx},${ty}) mine=${mine.reason} refWalls=${JSON.stringify(ref.blockingWalls)}`,
        );
        cases++;
      }
    }
    assert.ok(cases > 1000, `应覆盖逾千例，实际 ${cases}`);
  });

  it("阻挡集合与参考实现的相交墙集合一致", () => {
    const rows = ["...", "..#", ".#."];
    const grid = parseGrid(rows);
    const mine = lineOfSight(grid, { x: 0, y: 0 }, { x: 2, y: 2 });
    const ref = referenceLos(grid, { x: 0, y: 0 }, { x: 2, y: 2 });
    assert.deepEqual(mine.blockers, ref.blockingWalls);
  });
});

describe("两端皆空地的可见性互易", () => {
  it("A 可见 B 当且仅当 B 可见 A（随机穷举小网格）", () => {
    const rnd = mulberry(42);
    for (let m = 0; m < 40; m++) {
      const w = 5;
      const h = 5;
      const rows = randomMap(rnd, w, h, 0.22);
      const grid = parseGrid(rows);
      for (let ay = 0; ay < h; ay++) {
        for (let ax = 0; ax < w; ax++) {
          if (rows[ay][ax] === 1) continue;
          for (let by = 0; by < h; by++) {
            for (let bx = 0; bx < w; bx++) {
              if (rows[by][bx] === 1) continue;
              const ab = lineOfSight(grid, { x: ax, y: ay }, { x: bx, y: by });
              const ba = lineOfSight(grid, { x: bx, y: by }, { x: ax, y: ay });
              assert.equal(ab.visible, ba.visible,
                `互易失败 (${ax},${ay})<->(${bx},${by})`);
            }
          }
        }
      }
    }
  });
});

describe("可见区域", () => {
  it("观察格总在可见地面中", () => {
    const grid = parseGrid(["....", ".##.", ".##.", "...."]);
    const fov = computeFieldOfView(grid, { x: 0, y: 0 });
    assert.ok(fov.visibleFloor.some((c) => c.x === 0 && c.y === 0));
  });

  it("可见墙与不可见原因统计齐全，候选数等于半径内格数", () => {
    const grid = parseGrid([".....", ".###.", ".....", ".###.", "....."]);
    const fov = computeFieldOfView(grid, { x: 2, y: 2 }, 2);
    // 观察点居中，半径 2（含等号）覆盖 dx²+dy²<=4 -> 13 格
    assert.equal(fov.candidates, 13);
    assert.equal(
      fov.visibleFloor.length + fov.visibleWalls.length +
        Object.values(fov.invisibleReasonCounts).reduce((a, b) => a + b, 0),
      fov.candidates,
    );
    assert.ok(fov.totalSteps > 0);
  });

  it("半径边界取等号：距离恰为 r 的格纳入候选", () => {
    const grid = parseGrid(Array.from({ length: 7 }, () => "......."));
    const fov = computeFieldOfView(grid, { x: 3, y: 3 }, 3);
    const key = new Set(fov.visibleFloor.map((c) => `${c.x},${c.y}`));
    assert.ok(key.has("3,0")); // 距离 3
    assert.ok(key.has("0,3"));
    assert.ok(![...key].some((k) => {
      const [x, y] = k.split(",").map(Number);
      return (x - 3) ** 2 + (y - 3) ** 2 > 9;
    }));
  });
});
