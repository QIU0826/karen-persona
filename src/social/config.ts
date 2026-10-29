/**
 * 社会化配置：env → SocialConfig；所有上限夹在代码级硬上限内（只能调低）。
 */
import {
  SOCIAL_DEFAULT_APPROVAL_TTL_MIN,
  SOCIAL_DEFAULT_CAPS,
  SOCIAL_DEFAULT_CIRCUIT_COOLDOWN_HOURS,
  SOCIAL_DEFAULT_MIN_GAP_MIN,
  SOCIAL_HARD_CAPS,
  type SocialCaps,
  type SocialConfig,
  type SocialMode,
} from "./types.js";

const MODES: SocialMode[] = ["off", "observe", "approve", "auto", "high"];

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) ? Math.floor(raw) : fallback;
}

function clampCaps(env: NodeJS.ProcessEnv): SocialCaps {
  const pick = (key: string, fallback: number, hard: number): number => {
    const value = intEnv(env, key, fallback);
    return Math.max(0, Math.min(hard, value));
  };
  return {
    commentsPerDay: pick("KAREN_SOCIAL_COMMENTS_PER_DAY", SOCIAL_DEFAULT_CAPS.commentsPerDay, SOCIAL_HARD_CAPS.commentsPerDay),
    repliesPerDay: pick("KAREN_SOCIAL_REPLIES_PER_DAY", SOCIAL_DEFAULT_CAPS.repliesPerDay, SOCIAL_HARD_CAPS.repliesPerDay),
    dynamicsPerDay: pick("KAREN_SOCIAL_DYNAMICS_PER_DAY", SOCIAL_DEFAULT_CAPS.dynamicsPerDay, SOCIAL_HARD_CAPS.dynamicsPerDay),
    likesPerDay: pick("KAREN_SOCIAL_LIKES_PER_DAY", SOCIAL_DEFAULT_CAPS.likesPerDay, SOCIAL_HARD_CAPS.likesPerDay),
    favoritesPerDay: pick("KAREN_SOCIAL_FAVS_PER_DAY", SOCIAL_DEFAULT_CAPS.favoritesPerDay, SOCIAL_HARD_CAPS.favoritesPerDay),
    coinsPerDay: pick("KAREN_SOCIAL_COINS_PER_DAY", SOCIAL_DEFAULT_CAPS.coinsPerDay, SOCIAL_HARD_CAPS.coinsPerDay),
    followsPerDay: pick("KAREN_SOCIAL_FOLLOWS_PER_DAY", SOCIAL_DEFAULT_CAPS.followsPerDay, SOCIAL_HARD_CAPS.followsPerDay),
    sharesPerDay: pick("KAREN_SOCIAL_SHARES_PER_DAY", SOCIAL_DEFAULT_CAPS.sharesPerDay, SOCIAL_HARD_CAPS.sharesPerDay),
    dmsPerDay: pick("KAREN_SOCIAL_DMS_PER_DAY", SOCIAL_DEFAULT_CAPS.dmsPerDay, SOCIAL_HARD_CAPS.dmsPerDay),
    totalPerDay: pick("KAREN_SOCIAL_TOTAL_PER_DAY", SOCIAL_DEFAULT_CAPS.totalPerDay, SOCIAL_HARD_CAPS.totalPerDay),
  };
}

export function loadSocialConfig(env: NodeJS.ProcessEnv = process.env): SocialConfig {
  const rawMode = (env.KAREN_SOCIAL ?? "approve").trim().toLowerCase();
  const mode: SocialMode = (MODES as string[]).includes(rawMode)
    ? (rawMode as SocialMode)
    : "approve";
  const dryRun = (env.KAREN_SOCIAL_DRY_RUN ?? "on").trim().toLowerCase() !== "off";
  return {
    mode,
    dryRun,
    minGapMinutes: Math.max(5, Math.min(180, intEnv(env, "KAREN_SOCIAL_MIN_GAP_MIN", SOCIAL_DEFAULT_MIN_GAP_MIN))),
    approvalTtlMinutes: Math.max(1, Math.min(60, intEnv(env, "KAREN_SOCIAL_APPROVAL_TTL_MIN", SOCIAL_DEFAULT_APPROVAL_TTL_MIN))),
    circuitCooldownHours: Math.max(1, Math.min(72, intEnv(env, "KAREN_SOCIAL_CIRCUIT_HOURS", SOCIAL_DEFAULT_CIRCUIT_COOLDOWN_HOURS))),
    cookieFile: (env.KAREN_BILIBILI_COOKIE_FILE ?? "data/secrets/bilibili-cookie.json").trim(),
    caps: clampCaps(env),
  };
}

/** 是否允许某个动作在该 mode 下自动执行（高风险动作即使 high 也建议审批）。 */
export function isWriteEnabled(mode: SocialMode): boolean {
  return mode === "approve" || mode === "auto" || mode === "high";
}

export function isAutoMode(mode: SocialMode): boolean {
  return mode === "auto" || mode === "high";
}
