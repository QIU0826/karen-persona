/**
 * 群聊回复的出站计划（纯函数，便于单测）。
 *
 * 背景：群聊（@ 她）以前只发文字 + QQ 表情；`processMessage` 已经算出的「主动发图」
 * 结果被桥接层丢弃，贴纸也只有私聊会发。这里把「文字 / QQ 表情 / 配文 / 图片」统一
 * 编排成一个可测试的计划，桥接按计划发送。
 *
 * 隐私边界：照片默认**不发群**（配置 `group_photo_enabled: true` 才发）——
 * 她的生活照只给一对一关系看，群里是多人语境，默认保守。
 */

export interface GroupReplySource {
  reply: string;
  qqFace?: string;
  imageUrl?: string;
  imageFile?: string;
  imageCaption?: string;
}

export interface GroupPhotoPlan {
  /** 本地图片绝对路径（优先），或远程 URL */
  file?: string;
  url?: string;
  /** 配文（先发文字再发图） */
  caption?: string;
}

export interface GroupReplyPlan {
  /** 文字气泡（已按换行拆分、过滤空行） */
  textLines: string[];
  /** QQ face CQ 码（如 `[CQ:face,id=1]`） */
  qqFaceCq?: string;
  /** 照片（默认 null = 不发群） */
  photo: GroupPhotoPlan | null;
}

export interface BuildGroupReplyPlanOptions {
  /** 配置 `group_photo_enabled`；默认 false */
  photoEnabled?: boolean;
}

/**
 * 把 PipelineResult 编排成群聊发送计划。
 *
 * - 文字按换行拆成多条气泡（和私聊一致的碎片感）；
 * - QQ 表情作为独立消息；
 * - 照片仅在 `photoEnabled` 且确实有图时返回，附配文；配文为空时只发图。
 */
export function buildGroupReplyPlan(
  source: GroupReplySource,
  options: BuildGroupReplyPlanOptions = {},
): GroupReplyPlan {
  const textLines = (source.reply ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const qqFaceCq = source.qqFace?.trim() ? source.qqFace.trim() : undefined;

  let photo: GroupPhotoPlan | null = null;
  if (options.photoEnabled && (source.imageFile || source.imageUrl)) {
    photo = {
      ...(source.imageFile ? { file: source.imageFile } : {}),
      ...(!source.imageFile && source.imageUrl ? { url: source.imageUrl } : {}),
      ...(source.imageCaption?.trim() ? { caption: source.imageCaption.trim() } : {}),
    };
  }

  return { textLines, qqFaceCq, photo };
}
