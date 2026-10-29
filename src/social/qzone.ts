/**
 * QQ 空间动态社会化适配（用户选定范围：只发 Qzone，B 站只读）。
 *
 * - 复用现有 NapCat `send_qzone_msg`（qzone.ts）；不新增登录态/Cookie；
 * - 自动/手动发布都进 social_actions 审计；平台 qzone，target none；
 * - 内容经 social safety 校验；不写 B 站。
 */
import { publishQzonePost, isQzoneEnabled } from "../qzone/qzone.js";
import { validateSocialContent, SOCIAL_DYNAMIC_MAX_CHARS } from "./safety.js";
import { approveAction, createDraft, markSent } from "./store.js";
import type { ExecuteSocialOutcome } from "./executor.js";
import type { SocialActionResult, SocialActionRecord } from "./types.js";

export interface QzonePublishResult {
  ok: boolean;
  tid?: string;
  reason?: string;
}

export interface QzoneRecordOptions {
  owner?: string;
  nowMs?: number;
  reason?: string;
  publish?: (content: string) => Promise<QzonePublishResult>;
}

/** 记录一条已发布的 Qzone 动态（自动路径用；调用方已确认成功）。 */
export function recordQzonePublished(input: {
  content: string;
  tid?: string;
  owner?: string;
  nowMs?: number;
  reason?: string;
}): SocialActionRecord | null {
  try {
    const created = createDraft(
      {
        platform: "qzone",
        action: "dynamic",
        target: { platform: "qzone", targetType: "none", targetId: "" },
        content: input.content.slice(0, SOCIAL_DYNAMIC_MAX_CHARS),
        reason: input.reason ?? "Qzone auto/manual",
        risk: "low",
      },
      { owner: input.owner ?? "owner", skipDedupe: true, nowMs: input.nowMs },
    );
    const approved = approveAction(created.action.id, {
      actor: "system",
      nowMs: input.nowMs,
      ttlMs: 60_000,
    });
    return markSent(
      approved.id,
      { ok: true, platform: "qzone", action: "dynamic", ...(input.tid ? { externalId: input.tid } : {}), undoable: false },
      { actor: "system", nowMs: input.nowMs },
    );
  } catch {
    return null;
  }
}

/** 手动 `/social post`：只发 QQ 空间，不再走 B 站。 */
export async function postQzoneManual(
  content: string,
  options: QzoneRecordOptions = {},
): Promise<ExecuteSocialOutcome> {
  if (!isQzoneEnabled()) {
    return { ok: false, action: null, reason: "QQ空间未启用：先设 KAREN_QZONE=on" };
  }
  const validation = validateSocialContent(content, {
    maxChars: SOCIAL_DYNAMIC_MAX_CHARS,
    maxLinks: 0,
    maxHashtags: 0,
    maxMentions: 0,
  });
  if (!validation.ok) {
    return {
      ok: false,
      action: null,
      reason: `内容不合规：${[...validation.problems, ...validation.categories].join(", ")}`,
    };
  }
  const publish = options.publish ?? ((text: string) => publishQzonePost({ content: text }));
  let result: QzonePublishResult;
  try {
    result = await publish(validation.sanitized);
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : "publish_failed" };
  }
  if (!result.ok) return { ok: false, action: null, reason: `QQ空间发布失败：${result.reason ?? "unknown"}` };
  const action = recordQzonePublished({
    content: validation.sanitized,
    ...(result.tid ? { tid: result.tid } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    reason: options.reason ?? "owner manual /social post",
  });
  const socialResult: SocialActionResult = {
    ok: true,
    platform: "qzone",
    action: "dynamic",
    ...(result.tid ? { externalId: result.tid } : {}),
    undoable: false,
  };
  return { ok: true, action, result: socialResult, reason: "已发 QQ 空间动态" };
}
