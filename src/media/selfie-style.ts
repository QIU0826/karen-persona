/**
 * Karen 自拍统一画风（2026-10-22，基于 assets/photos/karen-selfie-cafe.jpg）。
 *
 * 用户明确要求：后续所有自拍都按这张图的风格设计。
 * 画风锚点：日系动漫插画、干净线稿、柔和赛璐璐 + 轻厚涂、通透皮肤、浅景深暖光、
 * 近景头肩/胸上构图、不露手。
 *
 * 注意：这里只锁"画风/角色"，不锁衣服和场景；场景由 prompt 决定。
 */

/** 服务器上的画风/角色参考图（由 cafe 自拍上传；生成新自拍时必须传） */
export const SELFIE_STYLE_REF = "/workspace/data/karen-ref-selfie/karen-selfie-cafe.jpg";

/** 统一画风提示词；追加到每条自拍 prompt 后 */
export const SELFIE_STYLE_PROMPT =
  "保持参考图的日系动漫插画风格：干净细腻线稿、柔和赛璐璐上色、轻微厚涂质感、细致发丝、通透皮肤、浅景深、暖色自然光；近景自拍构图，胸部以上，不出现手和手臂";

/** 把场景描述和统一画风拼成最终自拍 prompt。 */
export function buildSelfiePrompt(scenePrompt: string): string {
  const scene = scenePrompt.trim().replace(/[。；;]+$/g, "");
  return `${scene}；${SELFIE_STYLE_PROMPT}`;
}
