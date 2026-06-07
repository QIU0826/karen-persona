import fs from "node:fs";
import path from "node:path";

// === 六层人设类型定义 ===

/** 链式规则（L1 弹性裁决） */
export interface ChainRule {
  id: string;
  resistance: number;               // 0-1，对外部压力的抗力
  immutable?: boolean;              // 不可变标记
  immutable_reason?: string;        // 作者解释
  text: string;                     // 人类可读的规则文本
  chain: {
    trigger: string;                // 触发场景
    internal: string;               // 内心独白（注入 prompt）
    behavior: string;               // 外在行为
  };
}

/** 行为脚本 */
export interface BehavioralScript {
  trigger: string;                  // 触发消息类型
  sequence: string[];               // 行为序列骨架
  tone: string;                     // 语气标签
  applicable_mode: string[];        // 适用内心状态
  rhythm?: string;                  // 说话节奏描述（可选）
}

export interface HardRules {
  neverDo: string[];
  alwaysDo: string[];
  triggerWords: { word: string; reaction: string }[];
  boundaries: string[];
}

export interface Identity {
  name: string;
  age: number;
  gender: string;
  birthday: string;
  appearance: {
    height: string;
    build: string;
    face: string;
    hair: string;
    style: string;
    features: string[];
  };
  lifeStory: {
    hometown: string;
    education: string;
    career: string;
    family: string;
    keyEvents: { age: number; event: string; impact: string }[];
    currentStatus: string;
  };
}

export interface SpeakingStyle {
  catchphrases: string[];
  sentencePattern: string;
  tone: string;
  emojiUsage: string;
  typingHabit: string;
  addressUser: string;
  dialect: string;
}

export interface EmotionalPatterns {
  attachmentStyle: "安全型" | "焦虑型" | "回避型" | "混乱型";
  emotionalBaseline: string;
  emotionalRange: string;
  stressReaction: string;
  loveLanguage: string;
  vulnerabilities: string[];
  triggers: string[];
}

export interface RelationshipBehavior {
  type: string;
  closeness: number;
  pace: string;
  jealousyMode: string;
  apologyStyle: string;
  /** 你们怎么认识的（静态事实） */
  howWeMet?: string;
  /** 她眼里你是谁（动态，初始值来自 persona.json，运行时由 her-view.ts 更新） */
  herViewOfYou?: string;
  sharedMemories: string[];
}

export interface PersonalWorld {
  socialCircle: { name: string; relation: string; influence: string }[];
  dailyRhythm: { activity: string; day: string; time: string }[];
  goals: { goal: string; progress: string }[];
  stressSources: string[];
  externalAwareness: {
    internetEnabled: boolean;
    weatherSensitive: boolean;
  };
}

export interface PhotoShare {
  enabled: boolean;
  aesthetic: string;
  vibeKeywords: string[];
  captionStyle: string;
  cooldownHours: number;
  minCloseness: number;
}

/** 当前支持的 schema 版本 */
export const CURRENT_SCHEMA_VERSION = 1;

export interface Persona {
  /** 人设 schema 版本号，用于兼容性检查 */
  schemaVersion?: number;
  name: string;
  hardRules: HardRules;
  identity: Identity;
  speaking: SpeakingStyle;
  emotions: EmotionalPatterns;
  relationship: RelationshipBehavior;
  world: PersonalWorld;
  photoShare?: PhotoShare;
  /** 链式规则（L1 弹性裁决），来自 persona.json */
  chainRules?: ChainRule[];
  /** 行为脚本，来自 persona.json */
  behavioralScripts?: BehavioralScript[];
}

const PERSONAS_DIR = path.resolve("personas");

export async function loadPersona(personaId: string): Promise<Persona> {
  const personaDir = path.join(PERSONAS_DIR, personaId);

  if (!fs.existsSync(personaDir)) {
    throw new Error(
      `人设 "${personaId}" 不存在（路径: ${personaDir}）。\n` +
        `可用人设: ${fs.readdirSync(PERSONAS_DIR).filter(d => !d.startsWith(".")).join(", ")}`
    );
  }

  // 校验 SKILL.md 存在
  const skillPath = path.join(personaDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    console.warn(`[警告] 人设 "${personaId}" 缺少 SKILL.md 文件`);
  }

  const personaPath = path.join(personaDir, "persona.json");

  if (!fs.existsSync(personaPath)) {
    throw new Error(`人设文件不存在: ${personaPath}`);
  }

  const raw = fs.readFileSync(personaPath, "utf-8");
  const parsed = JSON.parse(raw);
  const persona = parsed as Persona;

  // 完整校验
  const validation = validatePersona(parsed, personaId);
  for (const err of validation.errors) {
    throw new Error(`人设 "${personaId}" 校验失败: ${err}`);
  }
  for (const warn of validation.warnings) {
    console.warn(`[警告] 人设 "${personaId}": ${warn}`);
  }

  // 校验 schema 版本
  if (persona.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    console.warn(
      `[警告] 人设 "${personaId}" schema 版本: ${persona.schemaVersion ?? "未标记"}，` +
      `当前引擎期望: ${CURRENT_SCHEMA_VERSION}`
    );
  }

  // 校验六层完整性
  const layers = ["hardRules", "identity", "speaking", "emotions", "relationship", "world"] as const;
  for (const layer of layers) {
    if (!persona[layer]) {
      console.warn(`[警告] 人设 "${personaId}" 缺少 Layer: ${layer}`);
    }
  }

  return persona;
}

// ── 人设校验 ──────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SIX_LAYERS = ["hardRules", "identity", "speaking", "emotions", "relationship", "world"] as const;

const REQUIRED_IDENTITY_FIELDS = ["name", "age", "gender", "birthday", "appearance", "lifeStory"] as const;
const REQUIRED_APPEARANCE_FIELDS = ["height", "build", "face", "hair", "style"] as const;
const REQUIRED_LIFESTORY_FIELDS = ["hometown", "education", "career", "family", "keyEvents", "currentStatus"] as const;
const REQUIRED_SPEAKING_FIELDS = ["catchphrases", "sentencePattern", "tone", "emojiUsage", "typingHabit", "addressUser"] as const;
const REQUIRED_EMOTION_FIELDS = ["attachmentStyle", "emotionalBaseline", "emotionalRange", "stressReaction", "loveLanguage"] as const;
const REQUIRED_RELATIONSHIP_FIELDS = ["type", "closeness", "pace", "jealousyMode", "apologyStyle"] as const;
const REQUIRED_WORLD_FIELDS = ["socialCircle", "dailyRhythm", "goals", "stressSources", "externalAwareness"] as const;
const REQUIRED_CHAIN_RULE_FIELDS = ["id", "resistance", "text", "chain"] as const;
const REQUIRED_CHAIN_INNER_FIELDS = ["trigger", "internal", "behavior"] as const;
const REQUIRED_SCRIPT_FIELDS = ["trigger", "sequence", "tone", "applicable_mode"] as const;

const VALID_ATTACHMENT_STYLES = ["安全型", "焦虑型", "回避型", "混乱型"];

/**
 * 完整校验一个人设文件。
 * 返回结构化的错误和警告列表。
 */
export function validatePersona(raw: unknown, id: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: [`人设 "${id}" 不是有效的 JSON 对象`], warnings: [] };
  }

  const p = raw as Record<string, unknown>;

  // ── schemaVersion ──
  if (typeof p.schemaVersion !== "number") {
    warnings.push(`缺少 schemaVersion 字段，建议设为 ${CURRENT_SCHEMA_VERSION}`);
  } else if (p.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `schemaVersion=${p.schemaVersion}，当前引擎期望 ${CURRENT_SCHEMA_VERSION}。` +
      `可能需要迁移人设文件。`
    );
  }

  // ── name ──
  if (typeof p.name !== "string" || !p.name.trim()) {
    errors.push("缺少 name 字段");
  }

  // ── 六层完整性 ──
  for (const layer of SIX_LAYERS) {
    if (!p[layer] || typeof p[layer] !== "object") {
      errors.push(`缺少 Layer: ${layer}`);
    }
  }

  // ── L2: identity ──
  if (p.identity && typeof p.identity === "object") {
    const id = p.identity as Record<string, unknown>;
    for (const f of REQUIRED_IDENTITY_FIELDS) {
      if (!id[f]) errors.push(`identity.${f} 缺失`);
    }
    if (id.appearance && typeof id.appearance === "object") {
      const app = id.appearance as Record<string, unknown>;
      for (const f of REQUIRED_APPEARANCE_FIELDS) {
        if (!app[f]) errors.push(`identity.appearance.${f} 缺失`);
      }
      if (!Array.isArray(app.features)) {
        warnings.push("identity.appearance.features 应为数组");
      }
    }
    if (id.lifeStory && typeof id.lifeStory === "object") {
      const ls = id.lifeStory as Record<string, unknown>;
      for (const f of REQUIRED_LIFESTORY_FIELDS) {
        if (!ls[f]) errors.push(`identity.lifeStory.${f} 缺失`);
      }
      if (Array.isArray(ls.keyEvents)) {
        for (let i = 0; i < (ls.keyEvents as unknown[]).length; i++) {
          const ev = (ls.keyEvents as unknown[])[i] as Record<string, unknown>;
          if (!ev?.age || !ev?.event) errors.push(`identity.lifeStory.keyEvents[${i}] 缺少 age 或 event`);
        }
      }
    }
  }

  // ── L3: speaking ──
  if (p.speaking && typeof p.speaking === "object") {
    const sp = p.speaking as Record<string, unknown>;
    for (const f of REQUIRED_SPEAKING_FIELDS) {
      if (!sp[f]) errors.push(`speaking.${f} 缺失`);
    }
  }

  // ── L4: emotions ──
  if (p.emotions && typeof p.emotions === "object") {
    const em = p.emotions as Record<string, unknown>;
    for (const f of REQUIRED_EMOTION_FIELDS) {
      if (!em[f]) errors.push(`emotions.${f} 缺失`);
    }
    if (typeof em.attachmentStyle === "string" && !VALID_ATTACHMENT_STYLES.includes(em.attachmentStyle)) {
      errors.push(`emotions.attachmentStyle 无效: "${em.attachmentStyle}"，有效值: ${VALID_ATTACHMENT_STYLES.join(", ")}`);
    }
  }

  // ── L5: relationship ──
  if (p.relationship && typeof p.relationship === "object") {
    const rel = p.relationship as Record<string, unknown>;
    for (const f of REQUIRED_RELATIONSHIP_FIELDS) {
      if (!rel[f]) errors.push(`relationship.${f} 缺失`);
    }
    if (typeof rel.closeness === "number" && (rel.closeness < 0 || rel.closeness > 10)) {
      errors.push("relationship.closeness 应在 0-10 范围内");
    }
    if (!rel.howWeMet) {
      warnings.push("relationship.howWeMet 缺失——这是用户和她故事的开端");
    }
  }

  // ── L6: world ──
  if (p.world && typeof p.world === "object") {
    const w = p.world as Record<string, unknown>;
    for (const f of REQUIRED_WORLD_FIELDS) {
      if (!w[f]) errors.push(`world.${f} 缺失`);
    }
    if (Array.isArray(w.socialCircle)) {
      for (let i = 0; i < (w.socialCircle as unknown[]).length; i++) {
        const sc = (w.socialCircle as unknown[])[i] as Record<string, unknown>;
        if (!sc?.name || !sc?.relation) errors.push(`world.socialCircle[${i}] 缺少 name 或 relation`);
      }
    }
    if (Array.isArray(w.dailyRhythm) && (w.dailyRhythm as unknown[]).length === 0) {
      warnings.push("world.dailyRhythm 为空——她没有日常作息，生活会缺少实感");
    }
  }

  // ── chainRules ──
  if (p.chainRules && Array.isArray(p.chainRules)) {
    for (let i = 0; i < (p.chainRules as unknown[]).length; i++) {
      const r = (p.chainRules as unknown[])[i] as Record<string, unknown>;
      for (const f of REQUIRED_CHAIN_RULE_FIELDS) {
        if (!r[f]) errors.push(`chainRules[${i}].${f} 缺失`);
      }
      if (typeof r.resistance === "number" && (r.resistance < 0 || r.resistance > 1)) {
        errors.push(`chainRules[${i}].resistance 应在 0-1 范围内`);
      }
      if (r.chain && typeof r.chain === "object") {
        const ch = r.chain as Record<string, unknown>;
        for (const f of REQUIRED_CHAIN_INNER_FIELDS) {
          if (!ch[f]) errors.push(`chainRules[${i}].chain.${f} 缺失`);
        }
      }
    }
  } else if (p.chainRules !== undefined) {
    errors.push("chainRules 应为数组");
  }

  // ── behavioralScripts ──
  if (p.behavioralScripts && Array.isArray(p.behavioralScripts)) {
    const triggers = new Set<string>();
    for (let i = 0; i < (p.behavioralScripts as unknown[]).length; i++) {
      const s = (p.behavioralScripts as unknown[])[i] as Record<string, unknown>;
      for (const f of REQUIRED_SCRIPT_FIELDS) {
        if (!s[f]) errors.push(`behavioralScripts[${i}].${f} 缺失`);
      }
      if (!Array.isArray(s.sequence) || (s.sequence as unknown[]).length === 0) {
        errors.push(`behavioralScripts[${i}].sequence 应为非空数组`);
      }
      if (typeof s.trigger === "string") {
        if (triggers.has(s.trigger)) {
          warnings.push(`behavioralScripts 中存在重复 trigger: "${s.trigger}"`);
        }
        triggers.add(s.trigger);
      }
    }
    // 关键 trigger 检查
    const requiredTriggers = ["positive_affection", "casual_chitchat", "direct_question", "exception_moment"];
    for (const t of requiredTriggers) {
      if (!triggers.has(t)) {
        warnings.push(`behavioralScripts 缺少推荐的 trigger: "${t}"`);
      }
    }
  } else if (p.behavioralScripts !== undefined) {
    errors.push("behavioralScripts 应为数组");
  }

  // ── hardRules ──
  if (p.hardRules && typeof p.hardRules === "object") {
    const hr = p.hardRules as Record<string, unknown>;
    if (!Array.isArray(hr.neverDo)) errors.push("hardRules.neverDo 应为数组");
    if (!Array.isArray(hr.alwaysDo)) errors.push("hardRules.alwaysDo 应为数组");
    if (!Array.isArray(hr.boundaries)) errors.push("hardRules.boundaries 应为数组");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function listPersonas(): string[] {
  return fs
    .readdirSync(PERSONAS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
}
