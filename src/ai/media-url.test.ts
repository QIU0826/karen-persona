import { afterEach, describe, expect, it } from "vitest";
import { checkMediaUrl, mediaHostAllowlist } from "./media-url.js";

const original = process.env.KAREN_MEDIA_ALLOWED_HOSTS;

afterEach(() => {
  if (original === undefined) delete process.env.KAREN_MEDIA_ALLOWED_HOSTS;
  else process.env.KAREN_MEDIA_ALLOWED_HOSTS = original;
});

describe("checkMediaUrl", () => {
  it("允许 http/https，并规范化 URL", () => {
    expect(checkMediaUrl("https://gxh.vip.qq.com/a.gif")).toMatchObject({
      ok: true, reason: "ok",
    });
    expect(checkMediaUrl("http://127.0.0.1:3000/img.png")).toMatchObject({ ok: true });
  });

  it("拒绝 file/data/相对路径/带账号密码", () => {
    expect(checkMediaUrl("file:///etc/passwd").reason).toBe("scheme_not_allowed");
    expect(checkMediaUrl("data:image/png;base64,xx").reason).toBe("data_url_not_allowed");
    expect(checkMediaUrl("/tmp/a.png").reason).toBe("invalid_url");
    expect(checkMediaUrl("https://user:pass@example.com/a.png").reason).toBe("credentials_not_allowed");
    expect(checkMediaUrl("https://example.com/a.png").ok).toBe(true);
  });

  it("拒绝空/超长/控制字符", () => {
    expect(checkMediaUrl("").reason).toBe("empty");
    expect(checkMediaUrl(`https://example.com/${"a".repeat(5000)}`).reason).toBe("too_long");
    expect(checkMediaUrl("https://example.com/a\n.png").reason).toBe("control_chars");
  });

  it("data URL 仅在显式 allowDataUrl 时放行", () => {
    expect(checkMediaUrl("data:image/png;base64,xx", { allowDataUrl: true })).toMatchObject({ ok: true });
  });

  it("配置 KAREN_MEDIA_ALLOWED_HOSTS 后收敛来源（支持 *.qq.com）", () => {
    process.env.KAREN_MEDIA_ALLOWED_HOSTS = "gxh.vip.qq.com,*.qq.com,127.0.0.1";
    expect(mediaHostAllowlist()).toEqual(["gxh.vip.qq.com", "*.qq.com", "127.0.0.1"]);
    expect(checkMediaUrl("https://gxh.vip.qq.com/a.gif").ok).toBe(true);
    expect(checkMediaUrl("https://p.qq.com/a.png").ok).toBe(true);
    expect(checkMediaUrl("https://example.com/a.png")).toMatchObject({ ok: false, reason: "host_not_allowed" });
  });
});
