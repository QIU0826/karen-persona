import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-social-qzone-"));
  process.env.KAREN_DATA_DIR = dir;
  process.env.KAREN_QZONE = "on";
  vi.resetModules();
});
afterEach(async () => {
  try {
    const vector = await import("../data/vector.js");
    vector.closeVectorDb();
  } catch { /* ignore */ }
  delete process.env.KAREN_DATA_DIR;
  delete process.env.KAREN_QZONE;
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("QQ空间社会化", () => {
  it("手动发动态成功并写审计", async () => {
    const { postQzoneManual } = await import("./qzone.js");
    const { listRecent } = await import("./store.js");
    const out = await postQzoneManual("今天店里很安静，窗边的光刚好", {
      owner: "qq:1",
      publish: async () => ({ ok: true, tid: "tid-1" }),
    });
    expect(out.ok).toBe(true);
    expect(out.result?.externalId).toBe("tid-1");
    expect(out.action?.status).toBe("sent");
    expect(out.action?.platform).toBe("qzone");
    const recent = listRecent({ platform: "qzone", limit: 5 });
    expect(recent.some((a) => a.externalId === "tid-1")).toBe(true);
  });

  it("不安全内容拒绝发布", async () => {
    const { postQzoneManual } = await import("./qzone.js");
    const publish = vi.fn(async () => ({ ok: true, tid: "x" }));
    const out = await postQzoneManual("身份证号 110101199001011234，加我微信", { publish });
    expect(out.ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("未启用 Qzone 时拒绝", async () => {
    delete process.env.KAREN_QZONE;
    const { postQzoneManual } = await import("./qzone.js");
    const out = await postQzoneManual("今天天气不错", { publish: async () => ({ ok: true }) });
    expect(out.ok).toBe(false);
  });
});
