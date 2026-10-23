/**
 * Karen 自拍统一画风（2026-10-23 起改为宣传页人物风格）。
 *
 * 用户明确要求：自拍风格要跟 web 宣传页（promo/assets/character-*.jpg）一致，
 * 不要之前 cafe 那张的高饱和厚涂动漫风。
 * 画风锚点：低饱和冷灰蓝色调、细腻铅笔/墨线 + 淡彩水彩晕染、轻微纸纹、
 * 深色简洁背景、留白多、浅蓝短发、灰蓝眼睛、苍白皮肤、克制的微笑。
 *
 * 参考图：服务器 /workspace/data/karen-ref-promo/character-1.jpg（宣传页主角立绘，
 * 由 promo/assets/character-1.jpg 上传；KAREN_SELFIE_REF 可覆盖）。
 * 注意：这里只锁"画风/角色"，不锁衣服和场景；场景由 prompt 决定。
 */

/** 服务器上的画风/角色参考图（宣传页人物；生成新自拍时必须传）。 */
export const SELFIE_STYLE_REF =
  (process.env.KAREN_SELFIE_REF ?? "").trim() ||
  "/workspace/data/karen-ref-promo/character-1.jpg";

/** 统一画风提示词；追加到每条自拍 prompt 后 */
export const SELFIE_STYLE_PROMPT =
  "保持参考图的人物与画风：低饱和冷灰蓝色调，细腻铅笔/墨线线条 + 淡彩水彩晕染、轻微纸纹质感；浅蓝/灰蓝短发（细碎发丝）、灰蓝眼睛、苍白皮肤、轻微腮红、克制的微笑；不要厚涂、不要高饱和、不要油光、不要 3D 渲染；背景按场景描述绘制，低饱和、简洁但要有明确的场景环境，不要纯白或纯灰的空白背景，也不要照搬参考图的深色纯色背景；近景自拍构图，胸部以上，不出现手和手臂";

/** 把场景描述和统一画风拼成最终自拍 prompt。 */
export function buildSelfiePrompt(scenePrompt: string): string {
  const scene = scenePrompt.trim().replace(/[。；;]+$/g, "");
  return `${scene}；${SELFIE_STYLE_PROMPT}`;
}
