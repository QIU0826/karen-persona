/**
 * 入站媒体 URL 的最低校验（v0.9.25）。
 *
 * 入站图片/表情的 URL 来自 OneBot 事件，属于外部输入。这里不做完整 SSRF
 * 私网判定（NapCat 本机 URL 可能是 127.0.0.1，一刀切会破坏图片链路），
 * 但先收掉最容易出问题的部分：
 * - 只允许 http/https（拒绝 file:/base64:/data: 等被误用）；
 * - 拒绝 URL 里带账号密码、控制字符、超长字符串；
 * - 可选 `KAREN_MEDIA_ALLOWED_HOSTS`（逗号分隔）把来源收敛到 QQ CDN / NapCat。
 */

export interface MediaUrlCheck {
  ok: boolean;
  url: string | null;
  reason: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_URL_LENGTH = 4096;

/** 解析 host allowlist：空配置 = 不限制（保持旧行为）。 */
export function mediaHostAllowlist(
  raw = process.env.KAREN_MEDIA_ALLOWED_HOSTS ?? "",
): string[] {
  return String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  // 支持 *.qq.com 这类后缀匹配；其余精确匹配
  if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

/**
 * 校验媒体 URL。`allowDataUrl` 仅供内部已知安全的 data URL 使用（例如测试/本地生成图）；
 * 入站事件不要传 true。
 */
export function checkMediaUrl(raw: string, opts: { allowDataUrl?: boolean } = {}): MediaUrlCheck {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, url: null, reason: "empty" };
  if (text.length > MAX_URL_LENGTH) return { ok: false, url: null, reason: "too_long" };
  if (CONTROL_CHARS.test(text)) return { ok: false, url: null, reason: "control_chars" };
  if (text.startsWith("data:")) {
    return opts.allowDataUrl
      ? { ok: true, url: text, reason: "ok" }
      : { ok: false, url: null, reason: "data_url_not_allowed" };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, url: null, reason: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, url: null, reason: "scheme_not_allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, url: null, reason: "credentials_not_allowed" };
  }
  const allowlist = mediaHostAllowlist();
  if (allowlist.length > 0 && !allowlist.some((p) => hostMatches(parsed.hostname, p))) {
    return { ok: false, url: null, reason: "host_not_allowed" };
  }
  return { ok: true, url: parsed.toString(), reason: "ok" };
}
