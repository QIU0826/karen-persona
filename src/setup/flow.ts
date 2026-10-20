/**
 * Setup 流程的纯函数部分（无 IO，便于单测）。
 *
 * 目标：把「首次引导 2.0」里可验证的逻辑从 CLI 中拆出来：
 * - 输入解析/校验（标签、端口、白名单）；
 * - config.yaml 合并（保留用户手写扩展字段）；
 * - 第一段对话与「她应该记住的事实」的生成；
 * - 是否需要跳过已完成的引导。
 */

export interface SetupAnswers {
  personaId: string;
  herName: string;
  /** 怎么认识的（可为空 → 用「偶遇」） */
  howWeMet: string;
  yourName: string;
  /** 用户所在城市（可为空 → 不写入事实，也不改 config） */
  location: string;
  tags: string[];
  allowedUsers: number[];
  oneBotPort: number;
}

export interface OnboardingDialogueLine {
  role: "user" | "assistant";
  content: string;
}

/** 「她该记得的关于你的事」——写入 user_facts 的结构。 */
export interface OnboardingFact {
  key: string;
  value: string;
  category: "profile" | "work" | "pet" | "relationship" | "plan" | "preference" | "other";
}

export const DEFAULT_YOUR_NAME = "你";

/** 标签输入：空格/逗号分隔，去重、去空。 */
export function normalizeTagsInput(raw: string): string[] {
  const parts = raw
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

/** 端口校验：空串 → 默认值；非法 → null。 */
export function parsePortInput(raw: string, fallback: number): number | null {
  const text = raw.trim();
  if (text === "") return fallback;
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * 合并 config.yaml：保留已有扩展字段，只覆盖 setup 负责的键。
 * 与现有 setup 行为一致（缺省补 message_frequency_limit / log_level 方便用户手改）。
 */
export function buildConfigPatch(
  existing: Record<string, unknown>,
  answers: SetupAnswers,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...existing };
  config.persona = answers.personaId;
  config.her_name = answers.herName;
  config.your_name = answers.yourName.trim() || DEFAULT_YOUR_NAME;
  if (answers.location.trim()) config.location = answers.location.trim();
  config.tags = answers.tags;
  config.one_bot_ws_port = answers.oneBotPort;
  config.allowed_users = answers.allowedUsers;
  if (config.message_frequency_limit === undefined) config.message_frequency_limit = 10;
  if (config.log_level === undefined) config.log_level = "info";
  return config;
}

/**
 * 生成「第一段对话」的消息序列（会写入会话，让她之后记得）。
 * 顺序：她问 → 你答 → … → 她的收尾。
 */
export interface OnboardingDialogueAnswers {
  howWeMet: string;
  yourName: string;
  location: string;
  /** 她所在城市（来自人设 hometown；缺省「上海」） */
  herCity?: string;
}

export function buildOnboardingDialogue(
  herName: string,
  answers: OnboardingDialogueAnswers,
): OnboardingDialogueLine[] {
  const lines: OnboardingDialogueLine[] = [];
  const herCity = (answers.herCity ?? "").trim() || "上海";

  lines.push({ role: "assistant", content: "嘿，你是从哪知道我的？" });
  lines.push({
    role: "user",
    content: answers.howWeMet.trim() || "……就当是偶遇吧。",
  });

  lines.push({ role: "assistant", content: `哦……他们叫我${herName}。那我该叫你什么？` });
  lines.push({ role: "user", content: answers.yourName.trim() || DEFAULT_YOUR_NAME });

  lines.push({ role: "assistant", content: `我现在在${herCity}，你呢？` });
  if (answers.location.trim()) {
    lines.push({ role: "user", content: answers.location.trim() });
  }

  lines.push({ role: "assistant", content: "好，记住了。我先去忙了，你随时找我。" });
  return lines;
}

/** 从引导答案生成「用户事实」（空值不写；默认称呼「你」不算名字）。 */
export function buildOnboardingFacts(
  answers: Pick<SetupAnswers, "howWeMet" | "yourName" | "location">,
): OnboardingFact[] {
  const facts: OnboardingFact[] = [];
  const name = answers.yourName.trim();
  if (name && name !== DEFAULT_YOUR_NAME) {
    facts.push({ key: "name", value: name, category: "profile" });
  }
  const location = answers.location.trim();
  if (location) {
    facts.push({ key: "city", value: location, category: "profile" });
  }
  const howWeMet = answers.howWeMet.trim();
  if (howWeMet) {
    facts.push({ key: "how_we_met", value: howWeMet, category: "relationship" });
  }
  return facts;
}

/** 是否应跳过引导：已完成过且没有 --force。 */
export function shouldSkipSetup(input: {
  hasConfig: boolean;
  hasOnboarding: boolean;
  force: boolean;
}): boolean {
  return input.hasConfig && input.hasOnboarding && !input.force;
}
