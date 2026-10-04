import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGrid, LosError } from "../dist/core/grid.js";
import { compareRationals, lineOfSight } from "../dist/core/los.js";

const G = (rows: Array<string | number[]>) => parseGrid(rows);

describe("参数校验", () => {
  it("拒绝空地图", () => {
    assert.throws(() => G([]), (e: LosError) => e.code === "MAP_EMPTY");
  });
  it("拒绝行宽不一致", () => {
    assert.throws(() => G(["...", ".."]), (e: LosError) => e.code === "MAP_INVALID");
  });
  it("拒绝非法字符", () => {
    assert.throws(() => G(["..x"]), (e: LosError) => e.code === "MAP_INVALID");
  });
  it("拒绝超过 64 边长", () => {
    const rows = Array.from({ length: 65 }, () => "....");
    assert.throws(() => G(rows), (e: LosError) => e.code === "MAP_TOO_LARGE");
  });
  it("拒绝墙格观察点", () => {
    const g = G(["#.", ".."]);
    assert.throws(() => lineOfSight(g, { x: 0, y: 0 }, { x: 1, y: 0 }),
      (e: LosError) => e.code === "OBSERVER_ON_WALL");
  });
  it("拒绝非法坐标", () => {
    const g = G(["..", ".."]);
    assert.throws(() => lineOfSight(g, { x: 1.5, y: 0 }, { x: 1, y: 0 }),
      (e: LosError) => e.code === "COORD_INVALID");
  });
  it("目标越界给出原因而非抛错", () => {
    const g = G(["..", ".."]);
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 5, y: 5 });
    assert.equal(r.visible, false);
    assert.equal(r.reason, "target_out_of_map");
  });
  it("拒绝负半径与非整数半径", () => {
    const g = G([".."]);
    assert.throws(() => lineOfSight(g, { x: 0, y: 0 }, { x: 1, y: 0 }, -1),
      (e: LosError) => e.code === "RADIUS_INVALID");
    assert.throws(() => lineOfSight(g, { x: 0, y: 0 }, { x: 1, y: 0 }, 1.5),
      (e: LosError) => e.code === "RADIUS_INVALID");
  });
});

describe("有理数交叉相乘", () => {
  it("精确比较避免浮点误差", () => {
    assert.equal(compareRationals({ n: 1, d: 3 }, { n: 2, d: 6 }), 0);
    assert.equal(compareRationals({ n: 3, d: 7 }, { n: 4, d: 9 }), -1); // 27 < 28
    assert.equal(compareRationals({ n: 5, d: 11 }, { n: 2, d: 5 }), 1); // 25 > 22
  });
});

describe("基础方向与自身", () => {
  const g = G(["....", "....", "....", "...."]);

  it("格中心到自身总可见", () => {
    const r = lineOfSight(g, { x: 1, y: 1 }, { x: 1, y: 1 });
    assert.equal(r.visible, true);
    assert.equal(r.touched.length, 1);
    assert.equal(r.touched[0].kind, "start");
  });

  it("水平视线接触正确格数与顺序", () => {
    const r = lineOfSight(g, { x: 0, y: 1 }, { x: 3, y: 1 });
    assert.equal(r.visible, true);
    assert.deepEqual(r.touched.map((c) => [c.x, c.y]), [[0, 1], [1, 1], [2, 1], [3, 1]]);
  });

  it("竖直视线接触正确格数与顺序", () => {
    const r = lineOfSight(g, { x: 2, y: 3 }, { x: 2, y: 0 });
    assert.equal(r.visible, true);
    assert.deepEqual(r.touched.map((c) => [c.x, c.y]), [[2, 3], [2, 2], [2, 1], [2, 0]]);
  });

  it("浅斜线与陡斜线均可穿越空地图", () => {
    assert.equal(lineOfSight(g, { x: 0, y: 1 }, { x: 3, y: 0 }).visible, true);
    assert.equal(lineOfSight(g, { x: 1, y: 0 }, { x: 0, y: 3 }).visible, true);
  });
});

describe("角点穿越的手算核对", () => {
  it("45° 穿过空 3x3：在 t=1/4 与 3/4 各同时接触三格，按 (x,y) 排序", () => {
    const g = G(["...", "...", "..."]);
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    assert.equal(r.visible, true);
    const at = (n: number) => r.touched.filter((c) => c.t.n === n && c.t.d === 4)
      .map((c) => [c.x, c.y]);
    assert.deepEqual(at(1), [[0, 1], [1, 0], [1, 1]]);
    assert.deepEqual(at(3), [[1, 2], [2, 1], [2, 2]]);
    assert.deepEqual(r.touched.map((c) => c.kind),
      ["start", "corner", "corner", "corner", "corner", "corner", "target"]);
  });

  it("光线穿过墙格中心（对角墙）被挡，阻挡集合稳定", () => {
    const g = G(["...", ".#.", "..."]);
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    assert.equal(r.visible, false);
    assert.equal(r.reason, "blocked_by_wall");
    assert.deepEqual(r.blockers, [{ x: 1, y: 1 }]);
    assert.deepEqual(r.firstBlock?.t, { n: 1, d: 4 });
  });

  it("角点处单个侧邻墙阻挡，阻挡集合含该侧邻格", () => {
    // 光线 (0,0)->(2,2)，角点 (2,2)（t=3/4）；侧邻为 (2,1) 与 (1,2)。
    const g = G(["...", "..#", "..."]); // (2,1) 是侧邻墙
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    assert.equal(r.visible, false);
    assert.deepEqual(r.blockers, [{ x: 2, y: 1 }]);
    assert.deepEqual(r.firstBlock?.t, { n: 3, d: 4 });
  });

  it("两个侧邻均为墙：阻挡集合按 (x,y) 稳定排序为两个格", () => {
    // 角点 (2,2) 的两侧邻 (2,1)、(1,2) 均为墙。
    const g = G(["...", "..#", ".#."]);
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    assert.equal(r.visible, false);
    assert.deepEqual(r.blockers, [{ x: 1, y: 2 }, { x: 2, y: 1 }]);
  });

  it("反方向同样被挡且阻挡集合一致", () => {
    const rows = ["...", "..#", ".#."];
    const g = G(rows);
    const a = lineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    const b = lineOfSight(g, { x: 2, y: 2 }, { x: 0, y: 0 });
    assert.equal(b.visible, false);
    assert.deepEqual(a.blockers, b.blockers);
  });
});

describe("墙的可见与穿墙遮挡", () => {
  it("目标自身是墙时允许看见（target_is_wall）", () => {
    const g = G(["...", ".#.", "..."]);
    const r = lineOfSight(g, { x: 1, y: 0 }, { x: 1, y: 1 });
    assert.equal(r.visible, true);
    assert.equal(r.reason, "target_is_wall");
  });

  it("墙后的格不可见（不能透过墙）", () => {
    const g = G(["...", ".#.", "..."]);
    const r = lineOfSight(g, { x: 1, y: 0 }, { x: 1, y: 2 });
    assert.equal(r.visible, false);
    assert.equal(r.reason, "blocked_by_wall");
    assert.deepEqual(r.blockers, [{ x: 1, y: 1 }]);
  });
});

describe("半径边界（距离平方，含等号）", () => {
  const g = G([".....", ".....", ".....", ".....", "....."]);
  it("恰好在半径上可见（2√2 格，平方 8）", () => {
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 }, 3);
    assert.equal(r.visible, true);
  });
  it("超出半径返回 out_of_radius", () => {
    const r = lineOfSight(g, { x: 0, y: 0 }, { x: 0, y: 4 }, 3);
    assert.equal(r.visible, false);
    assert.equal(r.reason, "out_of_radius");
  });
});
