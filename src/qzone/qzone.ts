/**
 * QQ 空间说说（Qzone）客户端。
 *
 * 走 NapCat 扩展接口 `send_qzone_msg`（不是 OneBot 标准），由 NapCat 处理登录态；
 * 不需要在 Karen 里保存 QQ cookie。默认关闭，必须显式 KAREN_QZONE=on 才允许发。
 *
 * 风险：这是非标准扩展/自动化操作；只在确认 NapCat 支持后使用，建议先用
 * KAREN_QZONE_UGC_RIGHT=64（仅自己可见）验证，再改成 1（所有人可见）。
 */
import { createLogger } from "../obs/logger.js";
import { callApiAsync } from "../bridge/onebot.js";

const log = createLogger("qzone");

export const QZONE_ACTION = "send_qzone_msg";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface PublishQzoneOptions {
  content: string;
  images?: string[];
  ugcRight?: 1 | 4 | 16 | 64 | 128;
  targetUins?: number[];
  timeoutMs?: number;
  /** 测试注入：默认 callApiAsync */
  callApi?: (action: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
}

export interface PublishQzoneResult {
  ok: boolean;
  tid?: string;
  reason?: string;
}

export function isQzoneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAREN_QZONE ?? "").trim().toLowerCase() === "on";
}

export function qzoneUgcRight(env: NodeJS.ProcessEnv = process.env): 1 | 4 | 16 | 64 | 128 {
  const raw = Number(env.KAREN_QZONE_UGC_RIGHT ?? 64);
  return ([1, 4, 16, 64, 128] as const).includes(raw as 1 | 4 | 16 | 64 | 128)
    ? (raw as 1 | 4 | 16 | 64 | 128)
    : 64;
}

/** 发一条 Qzone 说说；失败返回 ok:false（不抛）。 */
export async function publishQzonePost(opts: PublishQzoneOptions): Promise<PublishQzoneResult> {
  if (!isQzoneEnabled()) return { ok: false, reason: "disabled" };
  const content = (opts.content ?? "").trim();
  if (!content) return { ok: false, reason: "empty_content" };
  if (Array.from(content).length > 1000) return { ok: false, reason: "content_too_long" };

  const payload: Record<string, unknown> = {
    content,
    ugc_right: opts.ugcRight ?? qzoneUgcRight(),
    ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}),
    ...(opts.targetUins && opts.targetUins.length > 0 ? { target_uins: opts.targetUins } : {}),
  };
  const callApi = opts.callApi ?? callApiAsync;
  try {
    const data = await callApi(QZONE_ACTION, payload, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const record = data as Record<string, unknown> | null;
    const tid = record && typeof record.tid === "string" ? record.tid : undefined;
    log.info("qzone.published", { chars: Array.from(content).length, has_tid: Boolean(tid) });
    return { ok: true, ...(tid ? { tid } : {}) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown";
    log.warn("qzone.publish_failed", { reason: message.slice(0, 80) });
    return { ok: false, reason: message.slice(0, 120) };
  }
}
