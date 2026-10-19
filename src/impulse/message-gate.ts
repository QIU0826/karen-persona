/**
 * 消息门（域六）— V2 会话感知版。
 *
 * P1-2 修正：
 * - 当天首条消息保护（前 3 条免工作延迟）
 * - 亲密度缩放延迟概率
 * - 5 分钟内连续消息豁免（急事信号）
 * - 短问句豁免（快速闲聊）
 */

export type GateAction =
  | { type: "reply"; delayMs: number }
  | { type: "delay"; reason: string; resumeAfterMs: number }
  | { type: "silence"; reason: string; silenceType: "selective" | "avoidant" | "guilt_driven" | "forgotten" };

export interface GateContext {
  personaId: string;
  currentHour: number;
  isWorkHours: boolean;
  emotionVector: number;
  guilt: number;
  messageType: "text" | "image" | "voice";
  isAvoidedTopic: boolean;
  isNaturalEnding: boolean;
  /** 当天用户消息数（本轮之前） */
  messageCountToday: number;
  /** 对方 5 分钟内是否连续发 ≥2 条 */
  isRapidFollowUp: boolean;
  /** 短问句豁免（≤6字 + 含问号，快速闲聊型） */
  isQuickChat: boolean;
  /** 亲密度 0-10 */
  closeness: number;
  /** 她的日常作息（匹配当前时段活动） */
  dailyRhythm?: DailySlot[];
  /** 免打扰时段（小时，支持小数；start === end 视为关闭） */
  quietHours?: QuietHoursConfig;
}

/** 免打扰时段配置（24 小时制小数小时，如 23 与 7） */
export interface QuietHoursConfig {
  start: number;
  end: number;
}

/** 当前小时是否落在免打扰时段内（支持跨午夜） */
export function isQuietHour(hour: number, quiet?: QuietHoursConfig): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  const h = ((hour % 24) + 24) % 24;
  return quiet.start < quiet.end
    ? h >= quiet.start && h < quiet.end
    : h >= quiet.start || h < quiet.end;
}

/** 距离免打扰结束还有多少毫秒 */
function quietHoursRemainingMs(hour: number, quiet: QuietHoursConfig): number {
  const remainder = ((quiet.end - hour + 24) % 24) * 60 * 60 * 1000;
  return remainder > 0 ? remainder : 60 * 60 * 1000;
}

export function decideGate(ctx: GateContext): GateAction {
  const hour = ctx.currentHour;
  const busy = getBusyLevel(hour, ctx.dailyRhythm);

  // 免打扰时段（默认 23:00-07:00，可通过 config.yaml 的 quiet_hours_start/end 配置）
  if (ctx.quietHours || (hour >= 23 || hour < 7)) {
    const quiet = ctx.quietHours ?? { start: 23, end: 7 };
    if (isQuietHour(hour, quiet)) {
      return {
        type: "delay",
        reason: "太晚了，明天再回",
        resumeAfterMs: quietHoursRemainingMs(hour, quiet),
      };
    }
  }

  // 负债驱动的不回（不变）
  if (ctx.guilt > 0.3 && Math.random() < ctx.guilt * 0.5) {
    return {
      type: "silence",
      reason: "不敢面对",
      silenceType: "guilt_driven",
    };
  }

  // 回避话题（不变）
  if (ctx.isAvoidedTopic) {
    if (Math.random() < 0.3) {
      return { type: "silence", reason: "不知道怎么回", silenceType: "avoidant" };
    }
    return { type: "delay", reason: "需要时间想怎么回", resumeAfterMs: 30 * 60 * 1000 };
  }

  // 自然收尾（不变）
  if (ctx.isNaturalEnding) {
    return { type: "silence", reason: "聊完了", silenceType: "selective" };
  }

  // ── V2 修正：工作/日常延迟 — 会话感知 ──────────

  const exemptEarlyMsg = ctx.messageCountToday < 3;
  const exemptRapid = ctx.isRapidFollowUp;
  const exemptQuick = ctx.isQuickChat;
  const shouldConsiderDelay = !exemptEarlyMsg && !exemptRapid && !exemptQuick;

  if (shouldConsiderDelay) {
    // P1-3: 多媒体更吸引注意力，基础概率更低
    const baseProb = ctx.messageType === "text" ? 0.15 : 0.08;

    if (ctx.isWorkHours || busy >= 2) {
      // 工作时段或忙时：延迟概率随忙碌程度升高
      const prob = baseProb * (1 + busy * 0.3) * (1 - ctx.closeness / 10);
      const reasons = busy >= 3
        ? ["在忙正事，等下回", "这边走不开，晚点找你"]
        : ["在忙，稍后回复", "手头有点事，等下回"];
      if (Math.random() < prob) {
        return {
          type: "delay",
          reason: reasons[Math.floor(Math.random() * reasons.length)],
          resumeAfterMs: 15 * 60 * 1000 + Math.random() * 60 * 60 * 1000,
        };
      }
    } else if (ctx.messageCountToday >= 3) {
      const prob = baseProb * 0.33 * (1 - ctx.closeness / 10);
      if (Math.random() < prob) {
        return {
          type: "delay",
          reason: "手头有点事，等下回",
          resumeAfterMs: 5 * 60 * 1000 + Math.random() * 20 * 60 * 1000,
        };
      }
    }
  }

  // 情绪极度低落（不变）
  if (ctx.emotionVector < -0.5 && Math.random() < 0.2) {
    return {
      type: "delay",
      reason: "心情不太好，想等下再回",
      resumeAfterMs: 30 * 60 * 1000 + Math.random() * 2 * 60 * 60 * 1000,
    };
  }

  // 正常回复
  const typingDelay = ctx.messageType === "text"
    ? 1500 + Math.random() * 3000
    : 2000 + Math.random() * 2000;

  return {
    type: "reply",
    delayMs: Math.round(1000 + typingDelay),
  };
}

// ── 忙碌程度 ──────────────────────────────────

export interface DailySlot {
  time: string;
  activity: string;
}

/**
 * 0 = 空闲（散步/休息）→ 回得快
 * 1 = 普通
 * 2 = 忙碌（上班/上课/做事）
 * 3 = 深度专注（创作/学习/课上）
 */
export function getBusyLevel(hour: number, dailyRhythm?: DailySlot[]): number {
  // 优先匹配她的实际作息
  if (dailyRhythm && dailyRhythm.length > 0) {
    for (const slot of dailyRhythm) {
      const slotHour = parseHour(slot.time);
      if (slotHour === hour || slotHour === hour - 1) {
        const act = slot.activity.toLowerCase();
        if (/上课|考试|开会|写|画|做|练|瑜伽|健身|喂/.test(act)) return 3;
        if (/上班|打工|值班|改稿|接稿/.test(act)) return 2;
        if (/散步|遛|逛|休息|午饭|晚饭|吃饭|午休|喝/.test(act)) return 0;
        return 1;
      }
    }
  }

  // 通用回退：时段映射
  if (hour >= 9 && hour <= 11) return 2;
  if (hour >= 14 && hour <= 17) return 2;
  if (hour >= 17 && hour <= 18) return 1;
  if (hour >= 20 && hour <= 22) return 1;
  if (hour === 23 || hour === 0) return 1;
  if (hour >= 1 && hour < 7) return 0;
  return 0;
}

function parseHour(timeStr: string): number {
  const m = timeStr.match(/(\d{1,2}):\d{2}/);
  if (m) return parseInt(m[1], 10);
  return -1;
}
