# 网格视线遮挡与可见区域后端（grid-los）

纯后端的二维方格地图视线（Line of Sight）判断服务。只处理 **静态方格障碍 + 直线视线**，
不做迷宫生成、寻路、光照强度或图形界面。提供 HTTP API 与命令行（CLI），使用
TypeScript + Node.js + SQLite，在 Windows 本地直接运行，不依赖 Docker、WSL 或任何在线服务。

## 功能

- 导入方格地图（可通行地面 / 不透明墙），每次导入产生一个 **递增版本**。
- 单条视线判断：观察格中心 → 目标格中心的线段是否在到达目标前被墙挡住。
- 可见区域（批量）：对半径内每个候选格调用同一核心规则，输出可见地面、可见墙、
  不可见原因统计，以及公开的 **解释步数预算**（`totalSteps`）。
- 步骤解释：按顺序输出线段接触到的每个格、穿越类型、接触参数 `t`、阻挡依据。
- SQLite 固化地图版本、观察点、半径、规则版本与结果 **快照**；旧报告永远不会套用
  新墙体（编辑地图只产生新版本）。
- 历史读取与 JSON 导出（报告快照 + 对应地图版本）。
- 终端字符渲染：`@` 观察点、`·` 可见地面、`▓` 可见墙、`#` 不可见墙、`.` 不可见地面。

## 核心视线规则

1. 格坐标为整数，端点在格 **中心**。观察点与目标用整数格坐标表示。
2. 线段参数化为 `P(t) = (2ox+1, 2oy+1) + t·(2dx, 2dy)`，`t∈[0,1]`。
   中心坐标放大 2 倍后，所有网格边界交点的参数都是整数/整数的 **有理数**。
3. 比较交点先后一律用 **整数交叉相乘**（见 `compareRationals`），
   不使用浮点、不使用任意 epsilon，因此擦角结果稳定可复现。
4. 普通边界穿越：进入唯一的相邻格。
5. 恰好通过网格 **角点**：该点同时接触三个格 —— 对角格与两个侧邻格；
   三者按 `(x,y)` 稳定排序后依次记入解释结果。
   - 保守约定：这三个被接触格中 **任一是墙即阻挡**。
   - 因此不能从两块墙的尖角缝隙中穿过（角点两侧邻格必须都是地面才能贴角穿过）。
6. 同一角点若有多个阻挡墙，返回按 `(x,y)` 排序的 **阻挡集合** 与首次阻挡位置
   （交点的精确有理坐标与 `t`），不依赖遍历顺序随机挑一个。
7. 目标自身是墙时 **允许看见这面墙**（结果 `visible=true, reason=target_is_wall`），
   但墙后的格不能透过。观察格本身总可见。
8. 目标超出地图 → `target_out_of_map`；超出配置半径 → `out_of_radius`。
9. 半径按格中心 **整数距离平方** 判定，边界取等号：`dx²+dy² <= r²`。
10. 地图边长上限 64（宽、高分别校验）。

规则版本字符串：`grid-los-1.0.0`，随每条结果与报告持久化。

## 环境要求

- Node.js >= 22.6（开发验证使用 Node v25.5.0，含原生 TypeScript 类型擦除用于跑测试）。
- `better-sqlite3` 在 Windows 上使用预编译二进制；`npm install` 后即可直接运行，
  本机无需 Visual Studio 编译工具链（万一需要从源码编译，则需 VS Build Tools + Python）。

## 安装、构建、测试、启动、演示

```powershell
npm install        # 安装依赖
npm run build      # TypeScript 编译到 dist/
npm test           # 先构建再运行全部测试（40 个用例）
npm start          # 启动 HTTP API；默认端口 0 = 系统分配空闲端口，启动时打印端口
npm run demo       # 端到端演示：4 种布局 + 角点 + 版本隔离 + 重启复查
```

可选环境变量 / 参数：

```powershell
$env:PORT="8080"                 # 固定端口（默认 0 自动选择空闲端口）
$env:DB_PATH="data/los.sqlite"   # 数据库路径（默认项目内 data/los.sqlite）
node dist/server/main.js --port 9000 --db D:/los.sqlite
```

## HTTP API

所有请求/响应均为 JSON。失败输入返回 `{ "error": { "code", "message" } }` 与 4xx 状态码，
**不会**生成成功报告。越界目标 / 超半径属于正常判定结果，返回 201 且 `visible=false`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与规则版本 |
| POST | `/api/maps` | 导入地图，body：`{"rows": [[0,1,...], ...]}` 或 `{"rows": ["#..", ...]}` |
| GET | `/api/maps` | 全部地图版本 |
| GET | `/api/maps/latest` | 最新地图版本 |
| GET | `/api/maps/:id` | 指定地图版本（不存在 404） |
| POST | `/api/los` | 单条视线：`{"mapId"? , "observer":{x,y}, "target":{x,y}, "radius"?}` |
| POST | `/api/fov` | 可见区域：`{"mapId"? , "observer":{x,y}, "radius"?}` |
| GET | `/api/reports?mapId=` | 历史报告（可按地图版本过滤） |
| GET | `/api/reports/:id` | 读取报告快照 |
| GET | `/api/reports/:id/export` | 导出地图+报告 JSON 快照 |

省略 `mapId` 时使用最新版本。示例：

```powershell
Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Body '{"rows":["...",".#.","..."]}' http://127.0.0.1:8080/api/maps
Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Body '{"mapId":1,"observer":{"x":1,"y":0},"target":{"x":1,"y":2}}' `
  http://127.0.0.1:8080/api/los
```

`los` 结果关键字段：`visible`、`reason`、`touched[]`（依次接触格，含 `t`、`kind`、
`wall`、角点阻挡时的 `blockers`）、`firstBlock`（精确有理交点）、`blockers`、`steps`。
`fov` 结果关键字段：`visibleFloor[]`、`visibleWalls[]`、`invisibleReasonCounts`、
`candidates`、`totalSteps`（步数预算）。

## CLI

```powershell
node dist/cli.js import examples/demo-room.json
node dist/cli.js los 0 0 3 3 --map 1 --radius 4        # 单条视线（可 --json）
node dist/cli.js fov 0 0 --map 1 --radius 4            # 可见区域 + 文本渲染（可 --json）
node dist/cli.js render 0 0 --map 1                    # 只渲染，不落报告
node dist/cli.js explain 0 0 2 2 --map 1               # 顺序接触格与阻挡依据
node dist/cli.js maps                                  # 地图版本列表
node dist/cli.js history --map 1                       # 报告历史
node dist/cli.js get 1                                 # 读取报告（JSON）
node dist/cli.js export 1 result.json                  # 导出地图+报告快照
```

所有命令支持 `--db PATH` 指定数据库。地图文件支持 JSON 二维数组（0/1）或等长文本
（`#`/`1` 墙，`.`/`0`/空格 地面）。

## 演示布局

`npm run demo` 在一个临时 SQLite 中依次演示：

1. 无遮挡房间（全可见）。
2. 单墙柱（墙面可见、墙后产生不可见区域统计）。
3. 狭窄走廊（只能沿走廊看出去）。
4. 恰好擦过角点（光线穿过墙格中心 / 侧邻墙时的阻挡集合与接触顺序）。
5. 两块对角墙的尖角缝隙（保守阻挡）。
6. 编辑地图产生新版本，旧报告仍保持旧结论（版本隔离），并提示重启后的复查命令。

## 重启后复查

数据库为单个文件（默认 `data/los.sqlite`，SQLite WAL 模式）。关闭进程后重新启动，
用 `history` / `get` 或 `GET /api/reports/:id` 读到的是写入时固化的结果快照、
地图版本号与规则版本；测试 `store.test.ts` 覆盖了“关闭 → 重开 → 复查”。

## 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `MAP_EMPTY` | 400 | 空地图或零宽零高 |
| `MAP_INVALID` | 400 | 行宽不一致、非法字符 / 格值 |
| `MAP_TOO_LARGE` | 400 | 边长超过 64 |
| `COORD_INVALID` | 400 | 坐标不是整数 |
| `COORD_OUT_OF_BOUNDS` | 400 | 观察点越界（目标越界是结果原因，非错误） |
| `OBSERVER_ON_WALL` | 400 | 观察点落在墙格 |
| `RADIUS_INVALID` | 400 | 半径不是非负整数 |
| `MAP_NOT_FOUND` / `REPORT_NOT_FOUND` | 404 | 版本 / 报告不存在 |
| `ID_INVALID` / `BODY_INVALID` | 400 | ID 或请求体非法 |
| `INTERNAL` | 500 | 不应出现的内部错误 |

视线结果原因（非错误码）：`visible`、`target_is_wall`、`blocked_by_wall`、
`target_out_of_map`、`out_of_radius`。

## 项目结构

```
src/
  core/grid.ts      地图模型与严格校验（64 上限、错误码）
  core/los.ts       精确网格穿越核心（有理数、角点规则、解释步数）
  core/fov.ts       可见区域（复用核心规则）与终端渲染
  store/db.ts       SQLite：地图版本与报告快照
  server/app.ts     Express API
  server/main.ts    启动入口（空闲端口探测）
  cli.ts            命令行
  demo.ts           端到端演示
test/               node:test 测试（含独立闭方格求交参考实现交叉验证）
examples/           示例地图（JSON 与文本两种格式）
data/               运行后生成，SQLite 与导出文件（已 gitignore）
```

## 已验证内容

- 水平、竖直、浅斜线、陡斜线、正反方向、格中心到自身。
- 手算角点例子：45° 穿越 3×3 时空地图在 `t=1/4`、`t=3/4` 同时接触三格并按 `(x,y)` 排序；
  对角墙 / 单侧邻墙 / 两侧邻墙的阻挡集合与首次阻挡位置。
- 与独立的“线段 × 闭方格方形求交”参考实现在 1000+ 随机线段上结论一致
  （两套独立推导，避免核心自证）。
- 两端皆空地时可见性互易（小网格穷举）。
- 墙格目标可见、墙后不可见、半径边界取等号、地图编辑后新旧版本隔离、
  关闭重开数据库后复查同一结果。

## 限制与假设

- 只处理二维方格、静态墙、直线段视线；不支持高度、透明物、反射、折射、光照衰减。
- 可见区域对候选格逐一调用核心规则（O(格数 × 单线段步数)），不做阴影投射优化；
  地图边长上限 64，已满足题目规模。
- 坐标为整数格中心；半径以“格”为单位的整数欧氏半径。
- 角点采用“任一被接触墙即阻挡”的保守约定（缝隙不可穿过）。
- 默认数据库为项目内 `data/los.sqlite`；首次启动自动创建目录。
