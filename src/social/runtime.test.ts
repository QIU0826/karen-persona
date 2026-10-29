import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.KAREN_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-social-runtime-"));
  process.env.KAREN_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.KAREN_DATA_DIR;
  else process.env.KAREN_DATA_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("social runtime", () => {
  it("默认空状态；mode override 生效", async () => {
    const m = await import("./runtime.js");
    expect(m.loadSocialRuntime()).toEqual({});
    m.setSocialModeOverride("auto");
    expect(m.loadSocialRuntime().modeOverride).toBe("auto");
    expect(m.effectiveSocialConfig({}, m.loadSocialRuntime()).mode).toBe("auto");
  });

  it("风控冷却可开可判", async () => {
    const m = await import("./runtime.js");
    const now = 1_800_000_000_000;
    m.openCircuit(2, "risk_control", now);
    const s = m.loadSocialRuntime();
    expect(m.isCircuitOpen(s, now)).toBe(true);
    expect(m.isCircuitOpen(s, now + 3 * 3600_000)).toBe(false);
    expect(s.lastError).toBe("risk_control");
  });
});
