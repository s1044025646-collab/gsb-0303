/**
 * 服务启动入口。
 * 端口：环境变量 PORT / --port 指定；默认 0 表示由操作系统分配空闲端口。
 * 数据库：默认项目内 data/los.sqlite，可用 --db 或 DB_PATH 覆盖。
 */

import * as net from "node:net";
import * as path from "node:path";

import { createApp } from "./app";
import { Store } from "../store/db";
import { RULE_VERSION } from "../core/los";

function parseArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

export function resolvePort(requested: number): Promise<number> {
  return new Promise((resolve, reject) => {
    if (requested !== 0) {
      resolve(requested);
      return;
    }
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, () => {
      const addr = probe.address();
      probe.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("无法获取空闲端口"));
      });
    });
  });
}

async function main(): Promise<void> {
  const portArg = parseArg("--port") ?? process.env.PORT ?? "0";
  if (!/^\d+$/.test(portArg)) {
    console.error(`PORT 非法：${portArg}`);
    process.exit(2);
  }
  const dbPath =
    parseArg("--db") ?? process.env.DB_PATH ?? path.join(process.cwd(), "data", "los.sqlite");

  const store = new Store(dbPath);
  const app = createApp(store);
  const port = await resolvePort(Number(portArg));

  const server = app.listen(port, () => {
    const actual = (server.address() as net.AddressInfo).port;
    console.log(JSON.stringify({
      started: true,
      port: actual,
      dbPath,
      ruleVersion: RULE_VERSION,
    }, null, 2));
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
