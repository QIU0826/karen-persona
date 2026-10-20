#!/usr/bin/env tsx
/**
 * 人设叙事创建器（P1-3）。
 *
 * 不打表——聊天式创建。
 * 五种入口，3-4 个引导问题，自动推导六层字段。
 * 输出带信任度标注的草稿 + 待补充清单。
 *
 * 用法: npm run persona:narrate
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const PERSONAS_DIR = path.resolve("personas");

// ── 类型 ──────────────────────────────────────

type Trust = "high" | "medium" | "low";
type Source = "derived" | "inferred" | "default" | "unfilled";

interface PersonaAnswers {
  id: string;
  displayName: string;
  entryPoint: number;
  // 入口回答
  entryAnswer: string;
  // 共同问题
  howSheSpeaks: string;
  whatSheBadAt: string;
  innerConflict: string;
}

// ── IO 工具 ───────────────────────────────────

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

function section(title: string): void {
  console.log(`\n${"-".repeat(50)}`);
  console.log(`  ${title}`);
  console.log(`${"-".repeat(50)}`);
}

// ── 入口问题 ──────────────────────────────────

const ENTRY_QUESTIONS: Record<number, { label: string; question: string }> = {
  1: {
    label: "一个具体的瞬间",
    question:
      "说说她吧。不用想什么六层结构——先告诉我一个瞬间。\n" +
      "她在做什么？在想什么？那个瞬间为什么让你记住了她？\n\n> ",
  },
  2: {
    label: "她心里的矛盾",
    question:
      "她心里最放不下的那件事是什么？\n" +
      "什么东西在她脑子里打架，但从来没分出胜负？\n\n> ",
  },
  3: {
    label: "她怎么对待一个人",
    question:
      "她怎么对待那个对她重要的人？\n" +
      "她表达在意的方式是什么？她不擅长表达什么？\n\n> ",
  },
  4: {
    label: "一段她说的话",
    question:
      "写一段她说的话。不用多——几句就行。\n" +
      "日常闲聊、有点生气、或者表达在意的时候。哪段最像她，就写哪段。\n\n> ",
  },
  5: {
    label: "一段聊天记录",
    question:
      "粘贴一段对话记录（你的隐私，不会保存）。\n" +
      "用 ⚡ 标记她。AI 会分析她的模式——矛盾、触发点、沉默、关系动态。\n\n> ",
  },
};

// ── 推导逻辑 ──────────────────────────────────

function deriveFromAnswers(a: PersonaAnswers): {
  persona: Record<string, any>;
  annotations: Record<string, Source>;
  trust: Record<string, Trust>;
  notes: Record<string, string>;
} {
  const p: Record<string, any> = {};
  const src: Record<string, Source> = {};
  const trust: Record<string, Trust> = {};
  const note: Record<string, string> = {};

  const mark = (path: string, value: any, s: Source, t: Trust, n: string) => {
    p[path] = value;
    src[path] = s;
    trust[path] = t;
    note[path] = n;
  };

  const text = [a.entryAnswer, a.howSheSpeaks, a.whatSheBadAt, a.innerConflict].join(" ");

  // ── 从入口回答提取身份线索 ──────────────────

  // 地点
  const locationMatch = text.match(/(?:在|住在|去|到)([^\s，。,\.]{2,6}(?:店|街|路|市|区|城|家|公司|学校|大学|学院))/);
  if (locationMatch) {
    mark("identity.lifeStory.currentStatus", `在${locationMatch[1]}`, "derived", "medium", "从入口回答中提取的地点");
  }

  // 年龄暗示
  const ageMatch = text.match(/(\d{1,2})\s*岁/);
  if (ageMatch) {
    mark("identity.age", parseInt(ageMatch[1]), "derived", "high", "从入口回答中提取");
  } else {
    mark("identity.age", 0, "unfilled", "low", "未在对话中提到，需手动填写");
  }

  // 职业暗示
  const careerMatches = [
    { pattern: /咖啡|咖啡师|咖啡店|拉花|吧台/, career: "咖啡师" },
    { pattern: /画|插画|绘本|画室|画画/, career: "插画师/画师" },
    { pattern: /会计|财务|审计|CPA/, career: "会计/财务" },
    { pattern: /程序员|代码|开发|写码|前端|后端/, career: "程序员/开发者" },
    { pattern: /学生|大学|上课|考研|考试|专业/, career: "学生" },
    { pattern: /便利店|店员|打工|收银/, career: "店员" },
    { pattern: /设计|UI|UX|平面/, career: "设计师" },
    { pattern: /老师|教师|上课|学生/, career: "教师" },
    { pattern: /医生|护士|医院|病人/, career: "医护" },
    { pattern: /写作|写东西|写稿|作者|编辑/, career: "写作者/编辑" },
  ];
  const careerHit = careerMatches.find((c) => c.pattern.test(text));
  if (careerHit) {
    mark("identity.lifeStory.career", careerHit.career, "derived", "medium", "从入口回答中的职业关键词推导");
  } else {
    mark("identity.lifeStory.career", "", "unfilled", "low", "未在对话中识别到职业线索");
  }

  // ── 从"怎么说话"提取 L3 ─────────────────────

  const quotes = a.howSheSpeaks.match(/[""]([^""]{3,60})[""]/g);
  const catchphrases: string[] = [];
  if (quotes) {
    for (const q of quotes.slice(0, 5)) {
      const clean = q.replace(/[""]/g, "").trim();
      if (clean.length >= 2 && clean.length <= 25) {
        catchphrases.push(clean);
      }
    }
  }
  mark("speaking.catchphrases", catchphrases, "derived", "high", quotes ? "从引用的例句中提取" : "未提取到引用句");

  // 句式
  if (/短|少|话不多|简洁|几个字/.test(a.howSheSpeaks)) {
    mark("speaking.sentencePattern", "短句为主，不写长文", "derived", "medium", "从说话方式描述推导");
  } else if (/长|多|话多|爱说|滔滔不绝/.test(a.howSheSpeaks)) {
    mark("speaking.sentencePattern", "句子偏长，喜欢展开说", "derived", "medium", "从说话方式描述推导");
  } else {
    mark("speaking.sentencePattern", "中等长度，自然节奏", "inferred", "low", "未明确说明，使用默认值");
  }

  // 方言
  const dialectMatch = text.match(/(四川话|上海话|粤语|东北话|北京话|陕西话|湖南话|闽南语|方言)/);
  if (dialectMatch) {
    mark("speaking.dialect", dialectMatch[1], "derived", "high", "从对话中提取");
  }
  // 从地点推断方言
  if (!p["speaking.dialect"]) {
    if (/成都|四川/.test(text)) mark("speaking.dialect", "四川话", "inferred", "medium", "从地点推断");
    else if (/上海/.test(text)) mark("speaking.dialect", "偶尔带上海腔", "inferred", "low", "从地点推断");
    else if (/广东|广州|深圳/.test(text)) mark("speaking.dialect", "偶尔粤语", "inferred", "low", "从地点推断");
    else mark("speaking.dialect", "", "unfilled", "low", "未在对话中提到方言");
  }

  mark("speaking.typingHabit",
    /撤回|删了|重发/.test(a.howSheSpeaks) ? "偶尔会撤回重发" : "很少撤回，发了就发了",
    "inferred", "low", "从说话方式描述推测");

  // ── 从"不擅长什么"提取 L1 + L4 + L5 ────────

  const vulnPatterns = [
    { pattern: /说不|拒绝|不会拒绝|不擅长拒绝/, rule: "不擅长拒绝别人", vuln: "难以说'不'" },
    { pattern: /道歉|说对不起|承认.*错/, rule: "不擅长道歉，但会用行动弥补", vuln: "口头道歉很困难" },
    { pattern: /在意|在乎|承认.*喜欢|表达.*感情/, rule: "不会直接表达感情", vuln: "承认在意别人" },
    { pattern: /被夸|接受.*好意|收.*礼物/, rule: "被夸时会先否认", vuln: "接受正面评价" },
    { pattern: /求助|找人帮忙|开口.*帮/, rule: "不习惯向人求助", vuln: "开口寻求帮助" },
    { pattern: /解释自己|跟人解释|说.*想法/, rule: "不习惯跟人解释自己", vuln: "表达自己的感受" },
  ];

  const hitVulns = vulnPatterns.filter((v) => v.pattern.test(a.whatSheBadAt));
  if (hitVulns.length > 0) {
    mark("emotions.vulnerabilities", hitVulns.map((v) => v.vuln), "derived", "high", "从不擅长描述推导");
  }

  // ── 从"内心冲突"提取 chainRules ─────────────

  const chainRules: any[] = [
    {
      id: "no_brackets",
      resistance: 0.95,
      immutable: true,
      immutable_reason: "核心设计原则",
      text: "绝对不用括号描述动作",
      chain: { trigger: "任何回复时刻", internal: "我不是在演戏，我就是我。", behavior: "用文字表达，不用舞台指示" },
    },
    {
      id: "short_fragments",
      resistance: 0.75,
      text: "碎短句，每条5-15字",
      chain: { trigger: "回复较长内容时", internal: "", behavior: "长内容拆成短消息，换行分开" },
    },
  ];

  // 从"不擅长"和"内心冲突"推导个性规则
  if (hitVulns.length > 0 && hitVulns[0].rule) {
    chainRules.push({
      id: "vulnerability_rule",
      resistance: 0.6,
      text: hitVulns[0].rule,
      chain: {
        trigger: "当需要" + hitVulns[0].vuln + "时",
        internal: "",
        behavior: hitVulns[0].rule,
      },
    });
    mark("chainRules", chainRules, "derived", "medium", `从"不擅长${hitVulns[0].vuln}"推导了一条个性规则`);
  } else {
    mark("chainRules", chainRules, "default", "low", "未从对话中推导出个性规则，仅包含系统规则");
  }

  // 从冲突推导第二条个性规则
  if (a.innerConflict.length > 10) {
    const conflictWords = a.innerConflict.slice(0, 40);
    chainRules.push({
      id: "inner_conflict",
      resistance: 0.55,
      text: "内心有放不下的事",
      chain: {
        trigger: "当话题触及那件事时",
        internal: conflictWords,
        behavior: "沉默或转移话题，不会主动展开说",
      },
    });
  }

  // ── 依恋类型推导 ────────────────────────────

  if (/怕.*失去|被抛弃|离不开|害怕.*走|担心.*离开|焦虑/.test(text)) {
    mark("emotions.attachmentStyle", "焦虑型", "inferred", "low", "从语言模式推测——请根据实际情况确认或修改");
  } else if (/太近|距离|独.*空间|不想.*靠近|回避|冷淡|疏远/.test(text)) {
    mark("emotions.attachmentStyle", "回避型", "inferred", "low", "从语言模式推测——请根据实际情况确认或修改");
  } else if (/忽冷忽热|搞不懂.*自己|矛盾|不定/.test(text)) {
    mark("emotions.attachmentStyle", "混乱型", "inferred", "low", "从语言模式推测——请根据实际情况确认或修改");
  } else {
    mark("emotions.attachmentStyle", "安全型", "inferred", "low", "未能从对话中明确识别依恋类型，默认安全型。请根据实际情况修改");
  }

  // ── 关系 ────────────────────────────────────
  mark("relationship.closeness", 3, "default", "low", "默认初始亲密度 3。如果她和对方已经是熟人，可以调到 4-5");

  // ── 默认值 ──────────────────────────────────
  mark("hardRules", { neverDo: [], alwaysDo: [], triggerWords: [], boundaries: [] }, "default", "low", "系统默认。请根据她的底线补充");
  mark("behavioralScripts", [
    { trigger: "casual_chitchat", sequence: ["自然地接话", "分享一句相关的事"], tone: "日常", applicable_mode: ["neutral", "close"], rhythm: "2-3条短消息" },
    { trigger: "positive_affection", sequence: ["接受但不煽情"], tone: "日常", applicable_mode: ["neutral", "close"] },
    { trigger: "direct_question", sequence: ["直接回答"], tone: "直接", applicable_mode: ["neutral", "close"] },
    { trigger: "exception_moment", sequence: ["安静一下", "说点什么"], tone: "安静", applicable_mode: ["guilty"] },
  ], "default", "low", "通用行为脚本。请根据她的性格调整每种场景下的反应序列");
  mark("identity.gender", "", "unfilled", "low", "未在对话中提到");
  mark("identity.birthday", "", "unfilled", "low", "未在对话中提到");
  mark("identity.lifeStory.hometown", "", "unfilled", "low", "未在对话中提到——可从地点线索推断");
  mark("identity.lifeStory.keyEvents", [], "unfilled", "low", "请将入口答案中的关键事件填入此数组");
  mark("relationship.howWeMet", "", "unfilled", "low", "未在对话中提到");
  mark("world.dailyRhythm", [], "unfilled", "low", "请补充她的日常作息");
  mark("world.socialCircle", [], "unfilled", "low", "请补充她的社交圈（具体人名和关系）");

  return { persona: p, annotations: src, trust, notes: note };
}

// ── JSON 生成 ─────────────────────────────────

function buildPersonaJson(
  a: PersonaAnswers,
  derived: ReturnType<typeof deriveFromAnswers>,
): any {
  const { persona: p } = derived;

  // 骨架（硬编码默认值 + 推导覆盖）
  return {
    schemaVersion: 1,
    name: a.displayName,

    hardRules: p.hardRules || { neverDo: [], alwaysDo: [], triggerWords: [], boundaries: [] },

    chainRules: p.chainRules || [],

    behavioralScripts: p.behavioralScripts || [],

    identity: {
      name: a.displayName,
      age: p["identity.age"] ?? 0,
      gender: p["identity.gender"] ?? "",
      birthday: p["identity.birthday"] ?? "",
      appearance: { height: "", build: "", face: "", hair: "", style: "", features: [] },
      lifeStory: {
        hometown: p["identity.lifeStory.hometown"] ?? "",
        education: "",
        career: p["identity.lifeStory.career"] ?? "",
        family: "",
        keyEvents: p["identity.lifeStory.keyEvents"] ?? [],
        currentStatus: p["identity.lifeStory.currentStatus"] ?? "",
      },
    },

    speaking: {
      catchphrases: p["speaking.catchphrases"] ?? [],
      sentencePattern: p["speaking.sentencePattern"] ?? "",
      tone: "",
      emojiUsage: "",
      typingHabit: p["speaking.typingHabit"] ?? "",
      addressUser: "你",
      dialect: p["speaking.dialect"] ?? "",
    },

    emotions: {
      attachmentStyle: p["emotions.attachmentStyle"] ?? "安全型",
      emotionalBaseline: "",
      emotionalRange: "",
      stressReaction: "",
      loveLanguage: "",
      vulnerabilities: p["emotions.vulnerabilities"] ?? [],
      triggers: [],
    },

    relationship: {
      type: "",
      closeness: p["relationship.closeness"] ?? 3,
      pace: "",
      jealousyMode: "",
      apologyStyle: "",
      howWeMet: p["relationship.howWeMet"] ?? "",
      sharedMemories: [],
    },

    world: {
      socialCircle: p["world.socialCircle"] ?? [],
      dailyRhythm: p["world.dailyRhythm"] ?? [],
      goals: [],
      stressSources: [],
      externalAwareness: { internetEnabled: true, weatherSensitive: true },
    },
  };
}

// ── SKILL.md 生成（七段模板）────────────────

function buildSkillMd(a: PersonaAnswers, derived: ReturnType<typeof deriveFromAnswers>): string {
  const { persona: p, notes } = derived;
  const name = a.displayName;

  const catchphraseStr = (p["speaking.catchphrases"] as string[] | undefined)?.map((c) => `"${c}"`).join(" ") || "待补充";
  const dialectStr = p["speaking.dialect"] || "";
  const currentStr = p["identity.lifeStory.currentStatus"] || "待补充";
  const attachmentStr = p["emotions.attachmentStyle"] || "安全型";
  const attachmentNote = notes["emotions.attachmentStyle"] || "";
  const vulnStr = (p["emotions.vulnerabilities"] as string[] | undefined)?.join("、") || "待补充";

  const momentStr = a.entryAnswer.slice(0, 100);
  const speakStr = a.howSheSpeaks.slice(0, 120);
  const badStr = a.whatSheBadAt.slice(0, 80);

  // 依恋类型演化提示
  const evolutionHints: Record<string, string> = {
    "回避型": "刚认识时礼貌有距离。熟了以后会怼你，但说到一半会停下来。亲密度高的时候，她开始说以前不会说的话——然后立刻转移话题。",
    "焦虑型": "刚认识时每条消息都斟酌。熟悉后发完消息会觉得自己说多了。如果你接住她，她会慢慢少撤回一些。",
    "安全型": "正常的时候怼你损你，生气时话变短但不消失。亲密度高的时候，照顾你的方式越来越自然，不记隔夜仇。",
    "混乱型": "忽冷忽热。有时候主动找你聊很久，有时候已读不回。她自己也不知道为什么——但她在你面前比在别人面前更稳定。",
  };
  const evolutionStr = evolutionHints[attachmentStr] || "随着关系深入，她的行为会根据依恋类型自然演化。";

  return [
    "---",
    `name: ${a.id}`,
    `description: ${name} — ${currentStr.slice(0, 40)}。${attachmentStr}依恋。`,
    `triggers: ["${name}"]`,
    `version: "1.0.0"`,
    "---",
    "",
    `# ${name}`,
    "",
    "## 一个瞬间",
    "",
    `> ${momentStr}${momentStr.length >= 100 ? "..." : ""}`,
    "",
    `📝 [待补充] 如果上面的瞬间不够准确，请替换为你心中最能定义她的那个时刻。`,
    "",
    "## 她的日常",
    "",
    `📝 [待补充] 她现在的生活——在哪里、做什么、周几最忙、没人的时候在干嘛。`,
    currentStr ? `  从对话推导：${currentStr}` : "",
    "",
    "## 怎么说话",
    "",
    `> ${catchphraseStr}`,
    "",
    speakStr ? `  ${speakStr}` : "  📝 [待补充]",
    dialectStr ? `  方言/口音：${dialectStr}` : "",
    "",
    "## 在意什么",
    "",
    "📝 [待补充] 她的底线和软肋。什么事情会让她反应不一样？",
    "",
    "## 不擅长什么",
    "",
    badStr ? `  ${badStr}` : "  📝 [待补充]",
    vulnStr !== "待补充" ? `  推导：${vulnStr}` : "",
    "",
    "## 跟你什么关系",
    "",
    "📝 [待补充] 你和她是怎样认识的？你在她的世界里是谁？",
    "",
    "## 她会怎么变",
    "",
    `  ${evolutionStr}`,
    "",
    "---",
    "",
    `> ⚠️ 此文件由 \`persona:narrate\` 对话生成，标注 📝 的段落需要你手动补充。`,
    `> 依恋类型: ${attachmentStr}（${attachmentNote ? attachmentNote : "系统推测，请确认"}）`,
  ].join("\n");
}

// ── 主流程 ────────────────────────────────────

async function main() {
  console.log("\n" + "=".repeat(56));
  console.log("  persona:narrate — 叙事式人设创建");
  console.log("=".repeat(56));
  console.log("\n你不是在填表。跟我说说她的故事，我帮你记下来。\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 0. 基本信息
  const id = await ask(rl, "人设 ID（英文，如 laowang）：");
  if (!id) { console.log("❌ ID 不能为空"); process.exit(1); }
  const personaDir = path.join(PERSONAS_DIR, id);
  if (fs.existsSync(personaDir)) {
    console.log(`❌ "${id}" 已存在。换个 ID 或用 persona:create 覆盖。`);
    process.exit(1);
  }

  const displayName = await ask(rl, "她的名字（中文）：");
  if (!displayName) { console.log("❌ 名字不能为空"); process.exit(1); }

  // 1. 选择入口
  section("怎么开始的？");
  for (const [k, v] of Object.entries(ENTRY_QUESTIONS)) {
    console.log(`  ${k}. ${v.label}`);
  }
  const entryStr = await ask(rl, "\n选一个 (1-5)：");
  const entryPoint = parseInt(entryStr) || 1;
  if (!ENTRY_QUESTIONS[entryPoint]) {
    console.log(`❌ 无效选项，请输入 1-5`);
    process.exit(1);
  }

  // 2. 入口问题
  section(ENTRY_QUESTIONS[entryPoint].label);
  const entryAnswer = await ask(rl, ENTRY_QUESTIONS[entryPoint].question);
  if (!entryAnswer) { console.log("❌ 不能为空——哪怕一句话也行。"); process.exit(1); }

  // 3. 共同问题
  section("她怎么说话？");
  const howSheSpeaks = await ask(rl,
    "什么句式？用什么词？话多还是话少？\n" +
    "如果能想起一两句她说的话，加引号写进去。\n\n> "
  );

  section("她不擅长什么？");
  const whatSheBadAt = await ask(rl,
    "什么对她来说很难？道歉、被夸、求助、还是表达在意？\n\n> "
  );

  section("她心里放不下的那件事");
  const innerConflict = await ask(rl,
    "什么东西在她脑子里打架很久了，但从来没分出胜负？\n" +
    "（可以回车跳过）\n\n> "
  );

  rl.close();

  // 4. 推导 + 生成
  console.log("\n" + "=".repeat(56));
  console.log("  正在生成...");
  console.log("=".repeat(56));

  const answers: PersonaAnswers = { id, displayName, entryPoint, entryAnswer, howSheSpeaks, whatSheBadAt, innerConflict };
  const derived = deriveFromAnswers(answers);
  const personaJson = buildPersonaJson(answers, derived);
  const skillMd = buildSkillMd(answers, derived);

  // 5. 写入文件
  fs.mkdirSync(personaDir, { recursive: true });
  fs.writeFileSync(
    path.join(personaDir, "persona.json"),
    JSON.stringify(personaJson, null, 2) + "\n",
    "utf-8"
  );
  fs.writeFileSync(
    path.join(personaDir, "SKILL.md"),
    skillMd,
    "utf-8"
  );

  // 6. 输出
  console.log(`\n✅ 已创建: ${personaDir}/`);
  console.log(`   persona.json — 带推导标注的草稿`);
  console.log(`   SKILL.md — 七段模板，标注了待补充段落`);

  // 待补充清单
  const unfilled = Object.entries(derived.notes)
    .filter(([, n]) => n.includes("待补充") || n.includes("未在对话") || n.includes("默认"))
    .map(([path, n]) => ({ path, note: n }));

  const lowTrust = Object.entries(derived.trust)
    .filter(([, t]) => t === "low")
    .map(([path]) => ({ path, note: derived.notes[path] || "" }));

  if (unfilled.length > 0 || lowTrust.length > 0) {
    console.log(`\n📋 待补充清单：`);
    console.log(`${"-".repeat(40)}`);

    if (unfilled.length > 0) {
      console.log("\n未填写的字段：");
      for (const { path, note } of unfilled.slice(0, 12)) {
        console.log(`  ⬜ ${path} — ${note}`);
      }
    }

    if (lowTrust.length > 0) {
      console.log("\n低信任度推导（请人工确认）：");
      for (const { path, note } of lowTrust.slice(0, 8)) {
        console.log(`  🔍 ${path} — ${note}`);
      }
    }
  }

  console.log(`\n下一步：`);
  console.log(`  1. 编辑 ${id}/persona.json — 补充 ⬜ 字段`);
  console.log(`  2. 编辑 ${id}/SKILL.md — 补充 📝 段落`);
  console.log(`  3. npm run persona:check ${id}`);
  console.log(`  4. 修改 config.yaml → persona: "${id}"`);
  console.log(`  5. npm run dev 找感觉`);
  console.log(`\n创作指南: PERSONA_GUIDE.md`);
}

main().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
