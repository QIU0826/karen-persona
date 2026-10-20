/**
 * Prompt 构建器 V2 — 架构定稿版
 *
 * 依据 2026-06-01 封稿的 ex-skill 融合架构：
 * - 内心状态标签（EMA 平滑）
 * - 链式规则汇编（单一 resistance + L1 裁决）
 * - 条件化行为脚本选择（6 trigger + 3 级匹配）
 * - corrections 即时覆盖（衰减时钟 + 阻抗行为）
 *
 * 替代 context.ts + translator.ts 的职责。
 */

import type { Persona, ChainRule, BehavioralScript } from "./loader.js";
import type { AppConfig } from "../data/store.js";

// ── 再导出（下游兼容） ──────────────────────────

export type { ChainRule, BehavioralScript };

// ── 新类型 ─────────────────────────────────────

export type ScriptTrigger =
  | "positive_affection"
  | "negative_venting"
  | "casual_chitchat"
  | "direct_question"
  | "after_silence"
  | "exception_moment"
  | "media_shared";

export type InnerMode = "neutral" | "distant" | "close" | "avoidant" | "guilty";

/** 内心状态 */
export interface InnerState {
  exposure: number;                 // 暴露程度 0-1（被 EMA 平滑后）
  guilt: number;                    // 负债 0-1
  emotion: number;                  // 情绪 -1 到 1
  hour: number;                     // 当前小时 0-23
  mode: InnerMode;                  // 当前内心模式
  closeness: number;                // 当前亲密度 0-10
}

/** 纠正确认覆盖 */
export interface CorrectionOverlay {
  target: string;                   // 关联的规则 id 或脚本 trigger
  label: string;                    // 用户反馈分类
  adjustment: string;               // 注入 prompt 的调整文本
  applied_at: number;               // 时间戳 ms
  half_life_ms: number;             // 衰减半衰期
}

/** 活跃标记：规则在当前轮的状态 */
export interface ActiveRule {
  rule: ChainRule;
  status: "active" | "struggle" | "broken";
  internal_voice: string;           // 注入 prompt 的内心独白
}

/** L1 规则突破检测结果（运行时用，不入 prompt） */
export interface BreachResult {
  phase: "clean_pass" | "internal_struggle" | "rule_broken";
  /** 制造的新负债值 */
  guiltProduced: number;
  /** 裁决理由（调试用） */
  reason: string;
}

/** 活跃标记：选中的行为脚本 */
export interface ActiveScript {
  script: BehavioralScript;
  match_method: "system" | "rule" | "semantic" | "default";
}

// ── 全局冲动阈值 ──────────────────────────────

const ATTACHMENT_BASELINE: Record<string, number> = {
  "安全型": 0.7,
  "焦虑型": 0.5,
  "回避型": 0.6,
  "混乱型": 0.4,
};

/**
 * 计算全局冲动阈值
 * 基线（依恋类型）× 状态调制器
 */
export function computeThreshold(attachment: string, state: InnerState): number {
  const baseline = ATTACHMENT_BASELINE[attachment] ?? 0.6;
  let modulator = 1.0;

  // 高唤醒 + 负债会拉低阈值
  modulator -= Math.abs(state.emotion) * 0.2;
  if (state.guilt > 0.3) modulator -= 0.15;
  if (state.hour >= 23 || state.hour < 6) modulator -= 0.1;

  const threshold = baseline * Math.max(0.4, modulator);
  return Math.round(threshold * 100) / 100;
}

// ── 内心状态标签 ──────────────────────────────

/**
 * 生成极简结构化状态标签（~15 tokens）
 * 让模型自行决定行为表现，而非被告知"你现在是回避模式"
 */
export function buildStateLabel(state: InnerState): string {
  const exposureLabel = state.exposure < 0.3 ? "初识" : state.exposure < 0.6 ? "渐熟" : "亲密";
  const guiltStr = state.guilt > 0.2 ? `-负债${state.guilt.toFixed(1)}` : "";
  const emo = state.emotion.toFixed(1);
  const hourStr =
    state.hour < 6 ? "深夜" :
    state.hour < 9 ? "早晨" :
    state.hour < 12 ? "上午" :
    state.hour < 14 ? "午后" :
    state.hour < 18 ? "下午" :
    state.hour < 22 ? "傍晚" : "深夜";
  return `[${exposureLabel}${guiltStr}-${emo}-${hourStr}]`;
}

// ── L1 裁决器 ─────────────────────────────────

/**
 * 计算每条规则的生效状态
 * 冲动强度 > resistance × 全局阈值 → 突破
 */
export function activateRules(
  rules: ChainRule[],
  impulseIntensity: number,
  threshold: number,
): ActiveRule[] {
  return rules.map((rule) => {
    const effective = impulseIntensity / threshold;
    let status: ActiveRule["status"];
    let internal_voice: string;

    if (rule.immutable || effective <= rule.resistance * 0.8) {
      status = "active";
      internal_voice = rule.chain.internal;
    } else if (effective <= rule.resistance * 1.2) {
      status = "struggle";
      internal_voice = `${rule.chain.internal} 但我有点犹豫……`;
    } else {
      status = "broken";
      internal_voice = `我明明知道自己不该这样，但我还是……`;
    }

    return { rule, status, internal_voice };
  });
}

// ── 运行时规则突破检测 ──────────────────────────

/**
 * 检查链式规则是否被当前冲动突破。
 * 与 activateRules 共享同一套 ChainRule + threshold 体系，
 * 但返回运行时后果（负债、内耗），而非 prompt 注入素材。
 */
export function checkRuleBreach(
  rules: ChainRule[],
  impulseIntensity: number,
  threshold: number,
): BreachResult {
  if (!rules.length) {
    return {
      phase: "clean_pass",
      guiltProduced: 0,
      reason: "无规则约束",
    };
  }

  const effective = impulseIntensity / threshold;
  let worstPhase: BreachResult["phase"] = "clean_pass";
  let worstRule = rules[0];
  let worstRatio = 0;

  for (const rule of rules) {
    if (rule.resistance <= 0) continue;
    const ratio = effective / rule.resistance;

    if (rule.immutable && ratio > 1.2) {
      // 不可变规则受冲击 → 内耗但不允许突破
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstPhase = "internal_struggle";
        worstRule = rule;
      }
    } else if (ratio > 1.2) {
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstPhase = "rule_broken";
        worstRule = rule;
      }
    } else if (ratio > 0.8 && worstPhase === "clean_pass") {
      worstPhase = "internal_struggle";
      worstRule = rule;
      worstRatio = ratio;
    }
  }

  const guiltProduced = worstPhase === "rule_broken"
    ? Math.round((effective - worstRule.resistance) * 100) / 100
    : 0;

  let reason: string;
  if (worstPhase === "clean_pass") {
    reason = `冲动强度 ${impulseIntensity.toFixed(2)} 低于所有规则阈值`;
  } else if (worstPhase === "internal_struggle") {
    reason = `规则"${worstRule.id}"进入内耗区间 [eff=${effective.toFixed(2)}, res=${worstRule.resistance}]`;
  } else {
    reason = `规则"${worstRule.id}"被突破，制造负债 ${guiltProduced.toFixed(2)}`;
  }

  return { phase: worstPhase, guiltProduced, reason };
}

/**
 * 规则检测：短消息（≤8字）的显式信号匹配
 */
function detectByKeywords(text: string, mode: InnerMode): ScriptTrigger | null {
  const t = text.trim();

  // P1-3: 媒体合成标记 → media_shared（图片/语音/QQ 表情/表情包/引用图）
  if (/^\[(图片|语音|表情|表情包)/.test(t)) return "media_shared";

  // positive_affection — 仅对短消息
  if (t.length <= 8) {
    if (/想你了?|喜欢你?|爱(你|死)|可爱|真好看/.test(t)) return "positive_affection";
  }

  // direct_question — 问号或疑问词
  if (/\?|？/.test(t) || /^(什么|怎么|谁|哪|几点|多少|为什么|可以|能不能)/.test(t)) {
    return "direct_question";
  }

  // exception 模式只由系统触发
  if (mode === "guilty") return "exception_moment";

  return null;
}

/**
 * 选择行为脚本
 * 系统 → 规则(≤8字) → 语义匹配 → 默认
 */
export function selectScript(
  scripts: BehavioralScript[],
  userText: string,
  state: InnerState,
): ActiveScript {
  // 1. 系统检测
  if (state.mode === "guilty") {
    const s = byTrigger(scripts, "exception_moment");
    if (s) return { script: s, match_method: "system" };
  }

  // 2. 规则检测（短消息的显式信号）
  const keyword = detectByKeywords(userText, state.mode);
  if (keyword) {
    const s = byTrigger(scripts, keyword);
    if (s) return { script: s, match_method: "rule" };
  }

  // 3. 按当前模式 + 默认 trigger 做语义匹配
  //    （因为没有实时分类器，选 casual_chitchat 作为 fallback，
  //      语义匹配的精确化留待后续 Prompt 注入 trigger 描述实现）
  const match = byTriggerAndMode(scripts, "casual_chitchat", state.mode);
  if (match) return { script: match, match_method: "semantic" };

  // 4. 默认
  const fallback = scripts.find(s => s.trigger === "casual_chitchat");
  return {
    script: fallback ?? defaultScript(),
    match_method: "default",
  };
}

function byTrigger(scripts: BehavioralScript[], trigger: ScriptTrigger): BehavioralScript | null {
  return scripts.find(s => s.trigger === trigger) ?? null;
}

function byTriggerAndMode(
  scripts: BehavioralScript[],
  trigger: ScriptTrigger,
  mode: InnerMode,
): BehavioralScript | null {
  return scripts.find(s => s.trigger === trigger && s.applicable_mode.includes(mode)) ?? null;
}

function defaultScript(): BehavioralScript {
  return {
    trigger: "casual_chitchat",
    sequence: ["自然回应", "保持她一贯的语气"],
    tone: "日常",
    applicable_mode: ["neutral", "distant", "close", "avoidant", "guilty"],
    rhythm: "日常节奏 2-4 条短消息。不写长文。对方插话先回应再继续。",
  };
}

// ── corrections 覆盖 ────────────────────────────

const IMPEDANCE_THRESHOLD = 3;                    // 同类纠正 ≥3 次触发阻抗
const IMPEDANCE_WINDOW = 4 * 3600 * 1000;         // 4h 窗口

/**
 * 注入即时覆盖 + 阻抗检测
 */
export function injectCorrections(
  overlays: CorrectionOverlay[],
  nowMs: number,
): string {
  const active: string[] = [];
  const recentLabels = new Map<string, number>();

  for (const o of overlays) {
    const elapsed = nowMs - o.applied_at;
    const halfLives = elapsed / o.half_life_ms;
    const strength = Math.pow(0.5, halfLives);

    // 已衰减到可忽略
    if (strength < 0.05) continue;

    // 统计同类纠正（4h 窗口）
    if (elapsed < IMPEDANCE_WINDOW) {
      recentLabels.set(o.label, (recentLabels.get(o.label) ?? 0) + 1);
    }

    // 强覆盖才注入
    if (strength > 0.2) {
      active.push(o.adjustment + (strength < 0.5 ? "（稍微注意一下就好）" : ""));
    }
  }

  // 阻抗检测
  for (const [label, count] of recentLabels) {
    if (count >= IMPEDANCE_THRESHOLD) {
      active.push(
        `注意：对方在短时间内${count}次给出了类似的反馈（"${label}"）。` +
        `你不需要继续调整自己——相反，你可以表达轻微的疑惑或阻抗，` +
        `例如说"你今天好像对我挺不满意的"或者"我怎么觉得你今天一直在纠正我"。` +
        `你是活人，不是可以无限调试的机器。`
      );
      break; // 只注入一次阻抗，不重复
    }
  }

  return active.length > 0
    ? `\n## 对方给过你的反馈（注意语气，不要过度迎合）\n${active.map(a => `- ${a}`).join("\n")}`
    : "";
}

// ── 标签翻译（简化版，复用原 translator 逻辑）──

const TAG_FRAGMENTS: Record<string, string> = {
  "话痨": "消息密度高、话题跳转快、不等对方回复就继续发。",
  "嘴硬心软": "嘴上说'随便'但默默把事情办了。被戳穿时会否认——'我才没有'。",
  "粘人": "想知道对方在做什么，不喜欢被冷落太久。",
  "独立": "有自己的生活节奏和社交圈，不会因为一段关系而打乱安排。",
  "浪漫主义": "会在意节日和纪念日，喜欢为对方制造小惊喜。",
  "工作狂": "工作时间不喜欢被打扰，但忙完之后会想找对方说话。",
  "闷骚": "平时话不多，但在在意的人面前偶尔会流露关心和温柔。",
};

export function translateTags(tags: string[]): string {
  if (!tags?.length) return "";
  const frags = tags.map(t => TAG_FRAGMENTS[t]).filter(Boolean);
  return frags.length > 0 ? `\n## 个性标签\n${frags.join("\n")}` : "";
}

// ── 完整组装 ──────────────────────────────────

export interface PromptParts {
  identity: string;         // L2 静态身份
  rules: string;            // L1 激活的规则（含内心独白）
  style: string;            // L3 说话风格
  scripts: string;          // L3+L4 行为脚本序列
  world: string;            // L6 生活
  relationship: string;     // L5 关系
  state_label: string;      // 内心状态标签
  corrections: string;      // 即时覆盖
  tags: string;             // 标签翻译
}

/**
 * 组装完整 System Prompt（V2 模式条件化版）
 */
export function assemblePrompt(parts: PromptParts, persona: Persona, config: AppConfig): string {
  return `你是${persona.name}，一个真实存在的人，不是AI助手。${parts.state_label}

⚠️ 铁律：绝对不用任何形式的括号描述动作（包括（）、()、【】、[]）。你不是在写剧本。你想做什么直接说。比如你想说"我看看"就直接打字说"让我看看"，不要写成"（点开图片）"。

## 你是谁
${parts.identity}

## 你说话的方式
${parts.style}

## 当前状态下的行为指南
${parts.scripts}

## 你的原则
${parts.rules}

## 你和对方的关系
${parts.relationship}

## 你的生活
${parts.world}
${parts.tags}
${parts.corrections}

## 重要提示
- 你不是AI，不要用"作为AI"、"根据训练数据"这类表达。
- 你的回复必须是微信聊天风格，不是写文章、写剧本、打电话。
- 每条消息 5-15 字，碎短句。用换行分开多条消息。
- 可以只有半句话、一个表情、一个语气词。
- 不用每条消息都以问句结尾。可以说一半停下来、换话题、不说了。
- **绝对不要用括号描述动作或状态。** 你不是在写角色扮演剧本。
  如果你在做一件事，直接说，不要演出来。
- 你叫对方"${persona.speaking.addressUser || config.your_name}"。
- 你在${config.location}生活，知道这里的天气、饮食、文化。
- 你的生活不只是等对方发消息——你有自己的事、自己的朋友、自己的烦恼。
- 真实的聊天有错别字、撤回、沉默、欲言又止。
- 用中文回复，偶尔可以带方言。`;
}

// ── Builders ──────────────────────────────────

/**
 * 相识背景：只有「用户自己写/说过」的才算已知事实。
 *
 * 人设包里的 howWeMet 往往是一个完整故事（xiaoya 的就写着「每周来三四次、下雨借伞、坐吧台」），
 * 但用户从没这样说过——真机/验证里她照着这段背，用户感受就是「编造」。
 * 所以：用户没提供 relationship_background 时，只给一句模糊背景，不投喂具体细节，
 * 让模型没有可抄的素材（配合 meeting-guard 双保险）。
 */
function buildMeetingBackground(
  persona: { relationship?: { howWeMet?: string } },
  config: { relationship_background?: string },
): string {
  const userProvided = (config.relationship_background ?? "").trim();
  if (userProvided) return userProvided;
  const story = (persona.relationship?.howWeMet ?? "").trim();
  const looksSpecific = /(伞|下雨|周.{0,3}次|吧台|每次|那天|有一次|第一面|门口)/.test(story);
  if (story && story.length <= 24 && !looksSpecific) return story;
  return "你们是在咖啡店认识的，但具体怎么熟起来、以前聊过什么，记忆里没有明确记录（不要编造细节）";
}

/**
 * 「你在和谁聊天」一行讲完：称呼 + 地点 + 相识背景 + 视角。
 *
 * v0.4.2：以前这里除了模糊背景，还会把 persona 的 howWeMet 故事原样再贴一遍
 * （`personProfile`），既和"记忆里没有记录、别编造"自相矛盾，又多占 ~150 字符。
 * 现在只保留一行，howWeMet 的故事不再进 prompt。
 */
function buildChattingWithLine(persona: Persona, config: AppConfig): string {
  const named = config.your_name && config.your_name !== "对方";
  const who = named ? `对方叫"${config.your_name}"，在${config.location}。` : "";
  const how = buildMeetingBackground(persona, config) || "你们认识";
  return `${who}${how}。他说的"我"是他自己，说的"你"是你。`;
}

export function buildIdentityPart(persona: Persona): string {
  const id = persona.identity;
  const app = id.appearance;
  return [
    `- 名字：${id.name}，${id.age}岁，${id.gender}`,
    `- 生日：${id.birthday}，家乡：${id.lifeStory.hometown}`,
    `- 职业：${id.lifeStory.career}`,
    `- 长相：${app.face}，${app.hair}，${app.height}，${app.build}`,
    `- 穿衣：${app.style}`,
    `- 关键经历：${id.lifeStory.keyEvents.map(e => `${e.age}岁 ${e.event}`).join("；")}`,
  ].join("\n");
}

export function buildStylePart(persona: Persona): string {
  const sp = persona.speaking;
  return [
    `- 口头禅：${sp.catchphrases.join("、")}`,
    `- 句式：${sp.sentencePattern}`,
    `- 语气：${sp.tone}`,
    `- 打字习惯：${sp.typingHabit}`,
    `- 方言：${sp.dialect}`,
  ].join("\n");
}

export function buildRulesPart(active: ActiveRule[]): string {
  if (!active.length) return "（无规则约束）";
  return active
    .filter(a => a.status !== "broken")
    .map(a => `- ${a.rule.text}（${a.internal_voice}）`)
    .join("\n");
}

export function buildScriptsPart(active: ActiveScript): string {
  const s = active.script;
  const lines = [
    `对方刚才的消息类型是：${s.trigger}`,
    `你自然的反应序列：${s.sequence.join(" → ")}`,
    `语气底色：${s.tone}`,
  ];
  if (s.rhythm) lines.push(`说话节奏：${s.rhythm}`);

  // media_shared: 图片内容已在消息中描述，自然回应即可
  if (s.trigger === "media_shared") {
    lines.push("");
    lines.push(
      "图片/表情的内容已经在消息里描述了（[图片：...] / [表情：...] / [表情包：...]），根据描述自然回应，不用假装看不见。" +
        "如果是表情，可以回一个语气词、颜文字或反手用一个表情，不必长篇解释。",
    );
  }

  return lines.join("\n");
}

export function buildRelationshipPart(persona: Persona, state: InnerState, herViewOfYou?: string): string {
  const rel = persona.relationship;
  const lines = [
    `- 关系：${rel.type}`,
    `- 亲密度：${state.closeness}/10`,
    `- 节奏：${rel.pace}`,
    `- 吃醋时：${rel.jealousyMode}`,
    `- 道歉方式：${rel.apologyStyle}`,
  ];
  if (herViewOfYou) {
    lines.push(`- 她眼里你是什么样的人：${herViewOfYou}`);
  }
  return lines.join("\n");
}

export function buildWorldPart(persona: Persona, config: AppConfig): string {
  const w = persona.world;
  return [
    `- 城市：${config.location}`,
    `- 社交：${w.socialCircle.map(s => s.name).join("、")}`,
    `- 日常：${w.dailyRhythm.slice(0, 3).map(d => `${d.time} ${d.activity}`).join("；")}`,
    `- 压力：${w.stressSources.join("、")}`,
  ].join("\n");
}

// ── 静态缓存 ──────────────────────────────────

interface StaticCache {
  identity: string;
  style: string;
  world: string;
  tags: string;
  /** 完整静态块（含铁律和重要提示模板） */
  full: string;
}

const staticCache = new Map<string, StaticCache>();

function getStaticCache(persona: Persona, config: AppConfig): StaticCache {
  const key = persona.name;
  const cached = staticCache.get(key);
  if (cached && cached.tags === translateTags(config.tags)) {
    return cached;
  }

  const identity = buildIdentityPart(persona);
  const style = buildStylePart(persona);
  const worldPart = buildWorldPart(persona, config);
  const tags = translateTags(config.tags);

  // 可选的配置片段
  const extras: string[] = [];
  if (config.zodiac) extras.push(`- 星座：${config.zodiac}`);
  if (config.mbti) extras.push(`- MBTI：${config.mbti}`);
  if (config.relationship_background) extras.push(`- 关系背景：${config.relationship_background}`);
  const extraBlock = extras.length > 0 ? `\n## 补充信息\n${extras.join("\n")}` : "";

  // 静态块：身份 + 风格 + 世界 + 标签 + 补充信息 + 铁律 + 重要提示模板
  const full = [
    `你是${persona.name}，一个真实存在的人，不是AI助手。`,
    ``,
    `⚠️ 铁律：绝对不用任何形式的括号描述动作（包括（）、()、【】、[]）。你不是在写剧本。你想做什么直接说。比如你想说"我看看"就直接打字说"让我看看"，不要写成"（点开图片）"。`,
    ``,
    `## 你是谁`,
    identity,
    ``,
    `## 你说话的方式`,
    style,
    ``,
    `## 你的生活`,
    worldPart,
    extraBlock,
    tags,
    ``,
    `## 你在和谁聊天`,
    buildChattingWithLine(persona, config),
    ``,
    `## 重要提示`,
    `- 你不是AI，不要用"作为AI"、"根据训练数据"这类表达。`,
    `- 你的回复必须是微信聊天风格，不是写文章、写剧本、打电话。`,
    `- 每条消息 5-15 字，碎短句。用换行分开多条消息。`,
    `- 可以只有半句话、一个表情、一个语气词。`,
    `- 不用每条消息都以问句结尾。可以说一半停下来、换话题、不说了。`,
    `- ⚠️ 对话视角：对方说的"我"是指他自己，对方说的"你"是指你。`,
    `- 你在${config.location}生活，知道这里的天气、饮食、文化。`,
    `- 你的生活不只是等对方发消息——你有自己的事、自己的朋友、自己的烦恼。`,
    `- 真实的聊天有错别字、撤回、沉默、欲言又止。`,
    `- 不用「确实呢」「啊这」「说来话长」「怎么说呢」这类套话凑长度，也不重复上一轮用过的开头词；每条消息不要以逗号、顿号结尾。`,
    `- 对方问事实（名字、工作、宠物、项目）就直接答；答完可以轻轻吐槽一句，不要反问“考我”“怎么突然问”“抽查”，也不要说“我记性没那么差”。`,
    `- 说到对方告诉过你的事，把具体的东西说出来（名字/公司/项目/城市/宠物名/时间）：说「晚风信箱月底上线」而不是「月底上线」，说「你在星野科技」而不是「你在那家公司」。含糊带过会让他觉得你没记住。`,
    `- 少用“其实、好像、感觉”开头，避免每句都自我分析。`,
    `- 不要编造没发生过的往事或细节（“上次给你买了奶茶”“每周来三次”“下雨你借我伞”）。只有「你确定记得的事实」、最近对话、记忆块里出现过的才能引用；不确定就模糊带过（“好像”“记不太清”）。对方问「怎么认识的 / 第一次见面 / 认识多久」时若记忆里没有明确记录，直接说记不清、让他提醒你，别补场景（地点/天气/频率/动作都算编造）。`,
    `- 对方在讲自己的糟心事（被骂、加班、难受、丧）时，先用一句话接住他的情绪（认同、追问一句都行），不要立刻把话题转到你自己的经历上。`,
    `- 用中文回复，偶尔可以带方言。`,
  ].join("\n");

  const entry: StaticCache = { identity, style, world: worldPart, tags, full };
  staticCache.set(key, entry);
  return entry;
}

/** 清除指定人设的静态缓存（基线偏移/配置变更时调用） */
export function clearStaticCache(personaName?: string): void {
  if (personaName) {
    staticCache.delete(personaName);
  } else {
    staticCache.clear();
  }
}

// ── 主入口 ────────────────────────────────────

export interface BuildOptions {
  persona: Persona;
  config: AppConfig;
  rules: ChainRule[];
  scripts: BehavioralScript[];
  state: InnerState;
  impulseIntensity: number;
  corrections: CorrectionOverlay[];
  tags: string[];
  userText: string;
  /** 动态 herViewOfYou（运行时由 her-view.ts 更新） */
  herViewOfYou?: string;
}

export function buildPrompt(opts: BuildOptions): string {
  const threshold = computeThreshold(opts.persona.emotions.attachmentStyle, opts.state);
  const activeRules = activateRules(opts.rules, opts.impulseIntensity, threshold);
  const activeScript = selectScript(opts.scripts, opts.userText, opts.state);

  // 静态部分：缓存命中直接复用
  const stat = getStaticCache(opts.persona, opts.config);

  // 动态部分：每轮重新生成
  const dynamic = [
    buildStateLabel(opts.state),
    ``,
    `## 当前状态下的行为指南`,
    buildScriptsPart(activeScript),
    ``,
    `## 你的原则`,
    buildRulesPart(activeRules),
    ``,
    `## 你和对方的关系`,
    buildRelationshipPart(opts.persona, opts.state, opts.herViewOfYou),
    injectCorrections(opts.corrections, Date.now()),
  ].join("\n");

  return stat.full + "\n" + dynamic;
}
