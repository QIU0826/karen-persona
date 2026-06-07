#!/usr/bin/env tsx
/**
 * 人设脚手架
 * 用法: npm run persona:create <id> <name>
 * 示例: npm run persona:create laowang 老王
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PERSONAS_DIR = path.resolve("personas");

function main() {
  const id = process.argv[2];
  const displayName = process.argv[3];

  if (!id || !displayName) {
    console.log("用法: npm run persona:create <id> <name>");
    console.log("示例: npm run persona:create laowang 老王");
    console.log(`\n可用目录: ${PERSONAS_DIR}`);
    process.exit(1);
  }

  const personaDir = path.join(PERSONAS_DIR, id);
  if (fs.existsSync(personaDir)) {
    console.log(`❌ 人设 "${id}" 已存在: ${personaDir}`);
    process.exit(1);
  }

  fs.mkdirSync(personaDir, { recursive: true });

  // SKILL.md
  const skillContent = [
    "---",
    `name: ${id}`,
    `description: ${displayName} — 待补充`,
    `triggers: ["${displayName}"]`,
    `version: "1.0.0"`,
    "---",
    "",
    `# ${displayName}`,
    "",
    "待补充。（请替换为她的自述。参考 personas/xiaoya/SKILL.md）",
  ].join("\n");

  fs.writeFileSync(path.join(personaDir, "SKILL.md"), skillContent, "utf-8");

  // persona.json 模板
  const persona = {
    schemaVersion: 1,
    name: displayName,
    hardRules: {
      neverDo: [],
      alwaysDo: [],
      triggerWords: [],
      boundaries: [],
    },
    chainRules: [
      {
        id: "no_brackets",
        resistance: 0.95,
        immutable: true,
        immutable_reason: "核心设计原则",
        text: "绝对不用括号描述动作",
        chain: {
          trigger: "任何回复时刻",
          internal: "我不是在演戏，我就是我。",
          behavior: "用文字表达，不用舞台指示",
        },
      },
      {
        id: "short_fragments",
        resistance: 0.75,
        text: "碎短句，每条5-15字",
        chain: {
          trigger: "回复较长内容时",
          internal: "",
          behavior: "长内容拆成短消息，换行分开",
        },
      },
    ],
    behavioralScripts: [
      {
        trigger: "casual_chitchat",
        sequence: ["自然地接话", "分享一句相关的事"],
        tone: "日常",
        applicable_mode: ["neutral", "close"],
        rhythm: "2-3条短消息",
      },
      {
        trigger: "positive_affection",
        sequence: ["接受但不煽情"],
        tone: "日常",
        applicable_mode: ["neutral", "close"],
      },
      {
        trigger: "direct_question",
        sequence: ["直接回答"],
        tone: "直接",
        applicable_mode: ["neutral", "close"],
      },
      {
        trigger: "exception_moment",
        sequence: ["安静一下", "说点什么"],
        tone: "安静",
        applicable_mode: ["guilty"],
      },
    ],
    identity: {
      name: displayName,
      age: 0,
      gender: "",
      birthday: "",
      appearance: {
        height: "",
        build: "",
        face: "",
        hair: "",
        style: "",
        features: [],
      },
      lifeStory: {
        hometown: "",
        education: "",
        career: "",
        family: "",
        keyEvents: [],
        currentStatus: "",
      },
    },
    speaking: {
      catchphrases: [],
      sentencePattern: "",
      tone: "",
      emojiUsage: "",
      typingHabit: "",
      addressUser: "你",
      dialect: "",
    },
    emotions: {
      attachmentStyle: "安全型",
      emotionalBaseline: "",
      emotionalRange: "",
      stressReaction: "",
      loveLanguage: "",
      vulnerabilities: [],
      triggers: [],
    },
    relationship: {
      type: "",
      closeness: 3,
      pace: "",
      jealousyMode: "",
      apologyStyle: "",
      howWeMet: "",
      sharedMemories: [],
    },
    world: {
      socialCircle: [],
      dailyRhythm: [],
      goals: [],
      stressSources: [],
      externalAwareness: {
        internetEnabled: true,
        weatherSensitive: true,
      },
    },
  };

  fs.writeFileSync(
    path.join(personaDir, "persona.json"),
    JSON.stringify(persona, null, 2) + "\n",
    "utf-8"
  );

  console.log(`✅ 已创建: ${personaDir}/`);
  console.log(`   persona.json — 填写六层结构`);
  console.log(`   SKILL.md — 替换为她的自述`);
  console.log(`\n完成后运行: npm run persona:check ${id}`);
  console.log(`创作指南: PERSONA_GUIDE.md`);
}

main();
