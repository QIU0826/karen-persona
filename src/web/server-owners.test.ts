/**
 * Web 控制台多用户只读视图：/api/owners + ?owner= 作用域 + 默认只展示主用户。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let handles: Array<{ stop(): void; server: http.Server }> = [];
let vectorModule: typeof import("../data/vector.js") | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-web-owners-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.QWEN_VL_API_KEY;
  delete process.env.QWEN_EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
  vi.resetModules();
  handles = [];
  vectorModule = null;
});

afterEach(async () => {
  for (const handle of handles) {
    try {
      handle.stop();
    } catch {
      // ignore
    }
  }
  handles = [];
  try {
    vectorModule?.closeVectorDb();
  } catch {
    // ignore
  }
  vectorModule = null;
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || !address) {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitListening(server: http.Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

interface Core {
  server: typeof import("./server.js");
  history: typeof import("../data/history.js");
  facts: typeof import("../data/user-facts.js");
  consent: typeof import("../data/consent.js");
  vector: typeof import("../data/vector.js");
}

async function loadCore(): Promise<Core> {
  const core: Core = {
    server: await import("./server.js"),
    history: await import("../data/history.js"),
    facts: await import("../data/user-facts.js"),
    consent: await import("../data/consent.js"),
    vector: await import("../data/vector.js"),
  };
  vectorModule = core.vector;
  return core;
}

function seed(core: Core): void {
  const legacy = core.history.loadSession("小雅", "");
  core.history.addMessage(legacy, "user", "主用户的秘密");
  core.history.addMessage(legacy, "assistant", "嗯在呢");

  const second = core.history.loadSession("小雅", "-qq-100000002");
  core.history.addMessage(second, "user", "第二用户的消息");
  core.facts.upsertUserFacts("qq:100000002", [{ key: "name", value: "王五", category: "profile" }]);
  core.consent.confirmAge("qq:100000002");
}

async function start(core: Core, allOwners: boolean): Promise<{ port: number }> {
  const port = await getFreePort();
  const handle = core.server.startWebServer({
    port,
    personaId: "xiaoya",
    personaName: "小雅",
    primaryOwner: "qq:100000001",
    allOwners,
    initialCloseness: 3,
  });
  expect(handle).not.toBeNull();
  handles.push(handle!);
  await waitListening(handle!.server);
  return { port };
}

async function getJson(port: number, pathname: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // ignore
  }
  return { status: res.status, json };
}

describe("Web 多用户只读视图", () => {
  it("开启 web_all_owners 后可列出/切换 owner 数据", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await start(core, true);

    const owners = await getJson(port, "/api/owners");
    expect(owners.status).toBe(200);
    expect(owners.json.enabled).toBe(true);
    expect(owners.json.primary_owner).toBe("qq:100000001");
    const list = owners.json.owners as Array<Record<string, unknown>>;
    expect(list.map((item) => item.owner)).toEqual(["qq:100000001", "qq:100000002"]);
    expect(list[1].facts).toBe(1);
    expect(list[1].age_confirmed).toBe(true);

    const primary = await getJson(port, "/api/session?limit=30");
    const second = await getJson(port, "/api/session?limit=30&owner=qq:100000002");
    expect(primary.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.stringify(primary.json)).toContain("主用户的秘密");
    expect(JSON.stringify(primary.json)).not.toContain("第二用户的消息");
    expect(JSON.stringify(second.json)).toContain("第二用户的消息");
    expect(JSON.stringify(second.json)).not.toContain("主用户的秘密");

    const overview = await getJson(port, "/api/overview?owner=qq:100000002");
    expect(overview.status).toBe(200);
    expect((overview.json.session as Record<string, unknown>).messages).toBe(1);

    const facts = await getJson(port, "/api/facts?owner=qq:100000002");
    expect(facts.status).toBe(200);
    expect(JSON.stringify(facts.json)).toContain("王五");

    const invalid = await getJson(port, "/api/session?owner=wechat:abc");
    expect(invalid.status).toBe(400);
    expect(invalid.json.error).toBe("invalid_owner");

    // 页面含 owner 选择器 + 客户端拉取 /api/owners
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    expect(html).toContain('id="owner-select"');
    expect(html).toContain("/api/owners");
  });

  it("默认（web_all_owners=false）只展示主用户，跨 owner 请求 403", async () => {
    const core = await loadCore();
    seed(core);
    const { port } = await start(core, false);

    const owners = await getJson(port, "/api/owners");
    expect(owners.status).toBe(200);
    expect(owners.json.enabled).toBe(false);
    const list = owners.json.owners as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].owner).toBe("qq:100000001");

    const denied = await getJson(port, "/api/session?owner=qq:100000002");
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe("owner_scope_disabled");

    // /api/facts 保持历史行为：显式 ?owner= 仍可只读查询（便于排障）
    const otherFacts = await getJson(port, "/api/facts?owner=qq:100000002");
    expect(otherFacts.status).toBe(200);
    expect(JSON.stringify(otherFacts.json)).toContain("王五");

    // 不带 owner 仍能拿到主用户
    const primary = await getJson(port, "/api/session?limit=30");
    expect(primary.status).toBe(200);
    expect(JSON.stringify(primary.json)).toContain("主用户的秘密");
  });
});
