import { describe, expect, it, vi } from "vitest";
import type { ImageAudit } from "../ai/image-guard.js";
import {
  buildSelfiePromptForRequest,
  generateSelfie,
  inferSelfieScene,
  isSelfieGenerationEnabled,
  pickSelfieCaption,
} from "./selfie-generator.js";

const ENV = {
  KAREN_SELFIE_GEN: "on",
  QWEN_IMAGE_EDIT_URL: "http://127.0.0.1:19110",
  KAREN_SELFIE_STEPS: "8",
} as NodeJS.ProcessEnv;

function png(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer[0] = 0x89;
  buffer[1] = 0x50;
  buffer[2] = 0x4e;
  buffer[3] = 0x47;
  buffer[4] = 0x0d;
  buffer[5] = 0x0a;
  buffer[6] = 0x1a;
  buffer[7] = 0x0a;
  return buffer;
}

function audit(pass: boolean): ImageAudit {
  return {
    pass,
    scene_match: pass,
    character_match: pass,
    anatomy_ok: pass,
    hands_ok: pass,
    artifacts: pass ? [] : ["deformed"],
    issues: pass ? [] : ["手指异常"],
    reason: pass ? "ok" : "手部异常",
  };
}

function qwenReturning(bytes: Buffer) {
  return vi.fn(async () => ({ png: bytes, width: 960, height: 783, elapsedMs: 22_000 }));
}

describe("isSelfieGenerationEnabled", () => {
  it("默认开；KAREN_SELFIE_GEN=off 或没配 URL 时关", () => {
    expect(isSelfieGenerationEnabled(ENV)).toBe(true);
    expect(isSelfieGenerationEnabled({ ...ENV, KAREN_SELFIE_GEN: "off" })).toBe(false);
    expect(isSelfieGenerationEnabled({ KAREN_SELFIE_GEN: "on" })).toBe(false);
  });
});

describe("场景与 prompt", () => {
  it("从用户话里挑场景", () => {
    expect(inferSelfieScene({ userText: "来张雨里的自拍", hour: 15 })).toContain("雨");
    expect(inferSelfieScene({ userText: "海边来一张", hour: 15 })).toContain("海边");
    expect(inferSelfieScene({ userText: "你在家吗，拍张看看", hour: 15 })).toContain("家里");
    expect(inferSelfieScene({ userText: "发张自拍", hour: 15 })).toContain("咖啡馆");
    expect(inferSelfieScene({ userText: "发张自拍", hour: 22 })).toContain("家里");
  });

  it("prompt 带固定画风与不露手约束", () => {
    const { prompt, scene } = buildSelfiePromptForRequest({
      userText: "发张自拍看看",
      hour: 15,
      emotionVector: 0.6,
    });
    expect(scene).toContain("咖啡馆");
    expect(prompt).toContain("中蓝色");
    expect(prompt).toContain("不出现手和手臂");
    expect(prompt).toContain("嘴角带笑");
    expect(prompt).toContain("胸部以上");
  });
});

describe("pickSelfieCaption", () => {
  it("尽量避开最近用过的配文", () => {
    const recent = ["拍好了，刚拍的", "喏，刚拍的"];
    for (const random of [0, 0.2, 0.5, 0.9]) {
      expect(pickSelfieCaption(() => random, recent)).not.toBe(recent[0]);
      expect(pickSelfieCaption(() => random, recent)).not.toBe(recent[1]);
    }
  });
});

describe("generateSelfie", () => {
  it("一次通过：返回 PNG + 使用参考图与指定步数", async () => {
    const qwenGenerateFn = qwenReturning(png());
    const result = await generateSelfie(
      { userText: "发张自拍看看", hour: 15 },
      {
        env: ENV,
        qwenGenerateFn,
        auditFn: async () => audit(true),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.bytes?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const call = qwenGenerateFn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toContain("中蓝色");
    expect(call[1]).toMatchObject({ simple: true, steps: 8 });
    expect(call[1].imagePaths).toContain("/workspace/data/karen-ref-promo/character-2.jpg");
  });

  it("质检失败换 seed 重试一次；第二次通过", async () => {
    let audits = 0;
    const result = await generateSelfie(
      { userText: "发张自拍看看", hour: 15 },
      {
        env: ENV,
        qwenGenerateFn: qwenReturning(png()),
        auditFn: async () => {
          audits++;
          return audit(audits >= 2);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("两次质检都失败 → ok:false guard_rejected（调用方回退图库）", async () => {
    const result = await generateSelfie(
      { userText: "发张自拍看看", hour: 15 },
      { env: ENV, qwenGenerateFn: qwenReturning(png()), auditFn: async () => audit(false) },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("guard_rejected");
    expect(result.attempts).toBe(2);
  });

  it("质检服务不可用 → fail closed（guard_unavailable）", async () => {
    const result = await generateSelfie(
      { userText: "发张自拍看看", hour: 15 },
      { env: ENV, qwenGenerateFn: qwenReturning(png()), auditFn: async () => null },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("guard_unavailable");
  });

  it("生图服务失败 → qwen_failed；关闭时不调用生成", async () => {
    const qwenGenerateFn = vi.fn(async () => null);
    const failed = await generateSelfie(
      { userText: "发张自拍看看", hour: 15 },
      { env: ENV, qwenGenerateFn: qwenGenerateFn as never, auditFn: async () => audit(true) },
    );
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe("qwen_failed");

    const disabledQwen = vi.fn(async () => ({ png: png(), elapsedMs: 1 }));
    const disabled = await generateSelfie(
      { userText: "发张自拍看看", hour: 15 },
      { env: { ...ENV, KAREN_SELFIE_GEN: "off" }, qwenGenerateFn: disabledQwen as never },
    );
    expect(disabled.ok).toBe(false);
    expect(disabled.reason).toBe("disabled");
    expect(disabledQwen).not.toHaveBeenCalled();
  });
});
