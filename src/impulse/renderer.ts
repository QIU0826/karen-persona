/**
 * 表达渲染器（域六）— V2 扩展版。
 * P1-d: 支持 QQ face 表情 CQ 码输出。
 * P1-a: 去硬截断，安全阈值 15。
 */

import { pickQQFace, toCqFace } from "../persona/emoji-map.js";
import { insertToneMarkers, ToneConfig, ToneContext } from "./tone-insertion.js";

/** 根据情绪向量 + 冲动强度选择 QQ 表情分类 */
function pickCategoryByMood(emotion: number, intensity: number): string {
  if (intensity > 0.7 && emotion > 0) return "happy";
  if (intensity > 0.7 && emotion < 0) return "sad";
  if (emotion > 0.3) return "happy";
  if (emotion < -0.3) return "sad";
  if (intensity > 0.5) return "surprised";
  return "coy"; // 日常默认害羞/撒娇
}

/** 安全阈值：单轮最大消息条数，仅防 API 异常暴走，正常对话不触发 */
const MAX_BURST = 15;

export type ExpressionMode = "single" | "burst" | "withdraw" | "delayed";

export interface RenderConfig {
  /** 人设的颜文字偏好类型 */
  emojiStyle: "动物系" | "日系" | "抽象系" | "none";
  /** 表情包使用频率 0-1 */
  stickerFrequency: number;
  /** 是否话痨 */
  isChatty: boolean;
  /** P1-d: 输出模式 — CLI 用 kaomoji，QQ 用 qqface */
  stickerMode?: "kaomoji" | "qqface";
  /** 语气词配置 */
  tone?: ToneConfig;
}

export interface RenderedMessage {
  text: string;
  mode: ExpressionMode;
  /** 如果是 burst 模式，拆分为多条消息 */
  burstParts?: string[];
  /** 如果触发了撤回 */
  willWithdraw?: boolean;
  /** 附加的颜文字 */
  kaomoji?: string;
  /** P1-d: QQ 表情 CQ 码（独立的附加消息） */
  qqFace?: string;
}

/**
 * 渲染表达。
 * - 话痨型 + 兴奋情绪 → 可能 burst 多条
 * - 高强度冲动 + 抑制 → 发-撤-发
 */
export interface RenderState {
  impulseIntensity: number;
  hasInternalStruggle: boolean;
  emotionVector: number;
  guilt: number;
  /** 0=空闲 1=普通 2=忙碌 3=深度专注 */
  busyLevel: number;
}

export function renderExpression(
  content: string,
  config: RenderConfig,
  state: RenderState,
): RenderedMessage {
  // 模型偶尔输出连续空行；压缩成单个换行，避免发出空消息/碎片
  content = content.replace(/\n{2,}/g, "\n").trim();
  let mode: ExpressionMode = "single";
  let kaomoji: string | undefined;
  let qqFace: string | undefined;
  let willWithdraw: boolean | undefined;
  let burstParts: string[] | undefined;

  if (config.tone) {
    const toneContext: ToneContext = {
      emotionVector: state.emotionVector,
      closeness: 5,
      impulseIntensity: state.impulseIntensity,
      guilt: state.guilt,
      busyLevel: state.busyLevel,
    };
    content = insertToneMarkers(content, config.tone, toneContext);
  }

  // 颜文字自动匹配
  kaomoji = Math.random() < 0.2 ? pickKaomoji(content, config.emojiStyle) : undefined;

  // QQ 表情：负面情绪时概率更高（需要表达），正面时偶尔点缀
  const faceProb = state.emotionVector < -0.2 ? 0.25 : 0.15;
  if (config.stickerMode === "qqface" && Math.random() < faceProb) {
    const qqCategory = pickCategoryByMood(state.emotionVector, state.impulseIntensity);
    qqFace = toCqFace(pickQQFace(qqCategory));
  }

  // 爆发自适应：情绪/负债/忙度影响拆分粒度
  const hasNewlines = content.includes("\n");
  if (hasNewlines || (config.isChatty && content.length > 20)) {
    mode = "burst";
    // 高负债/负面/忙碌 → 消息更碎、间隔更长
    const fragmentation = Math.max(0.5,
      1 - state.emotionVector * 0.3 + state.guilt * 0.5 + state.busyLevel * 0.15
    );
    burstParts = splitBurst(content, fragmentation);
  }

  // 高强度冲动 + 内耗 → 发-撤-发
  if (state.impulseIntensity > 0.7 && state.hasInternalStruggle && Math.random() > 0.6) {
    mode = "withdraw";
    willWithdraw = true;
  }

  return {
    text: kaomoji ? content + " " + kaomoji : content,
    mode,
    burstParts,
    willWithdraw,
    kaomoji,
    qqFace,
  };
}

function pickKaomoji(
  content: string,
  style: string
): string | undefined {
  if (style === "none") return undefined;
  if (Math.random() > 0.4) return undefined; // 不是每次都加

  const pool: Record<string, string[]> = {
    "动物系": ["(#￣～￣#)", "(=^･ω･^=)", "(:3[▓▓]", "(´•̥ ̯ •̥`)", "(＞﹏＜)"],
    "日系": ["QAQ", ">_<", "orz", "www", "(´▽`)"],
    "抽象系": ["(°ー°〃)", "(￣▽￣*)", "(╯‵□′)╯︵┻━┻", "(´･_･`)"],
  };

  const options = pool[style] || pool["日系"];
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * 拆分 burst。
 * fragmentation > 1 → 每条更短、条数更多（焦虑/内耗时）
 * fragmentation < 1 → 每条更长、条数更少（开心/放松时）
 */
/** 去掉消息末尾的软标点（逗号/顿号/分号），避免发出「……，」这种 AI 味碎片 */
function stripTrailingSoft(text: string): string {
  return text.replace(/[，,、;；:：\s]+$/g, "").trim();
}

function splitBurst(content: string, fragmentation: number = 1): string[] {
  const lines = content
    .split(/\n+/)
    .map(stripTrailingSoft)
    .filter((l) => l.length > 0);

  if (lines.length <= 1) {
    const parts = content.split(/(?<=[，。！？……！\.])/);
    const burst = parts.map(stripTrailingSoft).filter((p) => p.length > 0);
    if (burst.length <= 1) return [stripTrailingSoft(content) || content];
    // 碎片化高 → 保留更多小块
    const count = Math.min(MAX_BURST, Math.ceil(burst.length * fragmentation));
    return burst.slice(0, count);
  }

  // 多行：碎片化高 → 每行也拆得更细
  if (fragmentation > 1.2) {
    const result: string[] = [];
    for (const line of lines) {
      const subParts = line.split(/(?<=[，。！？……])/).map(stripTrailingSoft).filter(p => p.length > 0);
      if (subParts.length > 1 && Math.random() < fragmentation - 1) {
        result.push(...subParts);
      } else {
        result.push(stripTrailingSoft(line));
      }
    }
    return result.filter((p) => p.length > 0).slice(0, MAX_BURST);
  }

  return lines.slice(0, MAX_BURST);
}
