/**
 * 网络热点感知（域七 P2）。
 *
 * 模拟她在网上刷到的内容——不追求"实时热搜"，
 * 而是基于信息圈层生成合理的话题曝光。
 *
 * 设计原则：
 * - 话题从本地池轮换（T TL 2-4 小时），不是实时 API
 * - 只展示穿透信息圈层的话题（她不会关注所有热搜）
 * - "可以没观点，但不能没反应"
 */

// ── 话题池 ──────────────────────────────────────

/** 圈层话题——按她的信息圈层分类，模拟刷小红书/微信群/朋友圈看到的内容 */
const TOPIC_POOL: TrendingTopic[] = [
  // 职业圈（会计专业学生）
  { title: "CPA成绩出来了", sphere: "职业", layer: 2, keywords: ["CPA", "会计", "考试", "成绩"] },
  { title: "四大会计师事务所秋招开始", sphere: "职业", layer: 2, keywords: ["四大", "秋招", "实习", "事务所"] },
  { title: "Excel又更新了函数", sphere: "职业", layer: 3, keywords: ["Excel", "函数", "办公"] },
  { title: "初级会计职称考试报名", sphere: "职业", layer: 2, keywords: ["会计", "考试", "报名", "初级"] },
  { title: "财务共享中心被AI替代", sphere: "职业", layer: 2, keywords: ["AI", "替代", "财务", "焦虑"] },

  // 生活圈（成都）
  { title: "成都又开了一家新火锅店", sphere: "生活", layer: 3, keywords: ["成都", "火锅", "探店"] },
  { title: "太古里街拍又火了", sphere: "生活", layer: 2, keywords: ["太古里", "街拍", "成都"] },
  { title: "成都地铁新线路开通", sphere: "生活", layer: 2, keywords: ["成都", "地铁", "交通"] },
  { title: "熊猫基地又生了小熊猫", sphere: "生活", layer: 2, keywords: ["熊猫", "成都", "可爱"] },
  { title: "青城山下雪了", sphere: "生活", layer: 3, keywords: ["青城山", "雪", "成都周边"] },

  // 社交圈（大学生）
  { title: "宿舍空调费吵起来了", sphere: "社交", layer: 3, keywords: ["宿舍", "空调", "室友"] },
  { title: "考研还是考公吵架帖", sphere: "社交", layer: 2, keywords: ["考研", "考公", "选择", "焦虑"] },
  { title: "社团招新被放鸽子", sphere: "社交", layer: 3, keywords: ["社团", "招新", "大学"] },
  { title: "毕业论文查重又涨价了", sphere: "社交", layer: 2, keywords: ["论文", "查重", "毕业", "涨价"] },
  { title: "室友脱单请吃饭", sphere: "社交", layer: 3, keywords: ["室友", "脱单", "八卦"] },

  // 全民级
  { title: "五一调休又上热搜了", sphere: "生活", layer: 1, keywords: ["调休", "放假", "热搜"] },
  { title: "新iPhone发布了", sphere: "生活", layer: 1, keywords: ["iPhone", "苹果", "手机"] },
  { title: "某明星塌房了", sphere: "社交", layer: 1, keywords: ["明星", "塌房", "八卦"] },
  { title: "气温又破40度了", sphere: "生活", layer: 1, keywords: ["高温", "天气", "热"] },
  { title: "高考作文题出来了", sphere: "社交", layer: 1, keywords: ["高考", "作文", "题目"] },
];

// ── 类型 ────────────────────────────────────────

export interface TrendingTopic {
  title: string;
  sphere: "职业" | "爱好" | "社交" | "生活";
  layer: 1 | 2 | 3;
  keywords: string[];
}

export interface MatchedTopic {
  topic: TrendingTopic;
  attitude: "care" | "know_but_dont_care" | "excited";
}

// ── 缓存 ────────────────────────────────────────

interface CacheEntry {
  topics: TrendingTopic[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时轮换一批话题

// ── 公开 API ────────────────────────────────────

/** 获取当前"刷到"的热点话题列表。每 2 小时轮换一次。 */
export function getTrendingTopics(): TrendingTopic[] {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.topics;
  }

  // 从池中随机选 5-8 个话题
  const count = 5 + Math.floor(Math.random() * 4);
  const shuffled = [...TOPIC_POOL].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, count);

  cache = { topics: selected, fetchedAt: now };
  return selected;
}

/**
 * 筛选当前人设"在乎"或"知道"的话题。
 * Layer 1（全民级）→ 直接穿透，attitude = know_but_dont_care 或 care
 * Layer 2（圈层级）→ 需要匹配 info-sphere 圈层
 * Layer 3（微圈层）→ 需要深度匹配
 */
export function matchTrendingTopics(
  topics: TrendingTopic[],
  careerKeywords: string[],
  hobbyKeywords: string[],
): MatchedTopic[] {
  const matched: MatchedTopic[] = [];

  for (const topic of topics) {
    if (topic.layer === 1) {
      // 全民级：直接穿透，但态度无所谓
      matched.push({
        topic,
        attitude: Math.random() > 0.6 ? "know_but_dont_care" : "care",
      });
    } else {
      // 圈层级：检查是否匹配人设
      const relevantKeywords = [...careerKeywords, ...hobbyKeywords];
      const hits = topic.keywords.filter(k =>
        relevantKeywords.some(rk => k.includes(rk) || rk.includes(k))
      );
      if (hits.length > 0) {
        matched.push({
          topic,
          attitude: topic.layer === 2 ? "care" : "excited",
        });
      }
    }
  }

  return matched;
}

/**
 * 生成 Prompt 注入用的自然语言片段。
 * 模拟"她刷手机时看到了什么"的感觉。
 */
export function buildTrendingContext(matched: MatchedTopic[]): string {
  if (matched.length === 0) return "";

  const cared = matched.filter(m => m.attitude === "care" || m.attitude === "excited");
  const meh = matched.filter(m => m.attitude === "know_but_dont_care");

  const lines: string[] = [];

  if (cared.length > 0) {
    const topic = cared[Math.floor(Math.random() * cared.length)];
    const phrases = [
      `今天刷手机看到"${topic.topic.title}"——你有点在意，因为跟你有关。`,
      `你刚在网上看到"${topic.topic.title}"，心里嘀咕了一下。`,
      `小红书刷到"${topic.topic.title}"，你停下来多看了两眼。`,
    ];
    lines.push(phrases[Math.floor(Math.random() * phrases.length)]);
  }

  if (meh.length > 0 && Math.random() < 0.3) {
    const topic = meh[Math.floor(Math.random() * meh.length)];
    lines.push(`热搜上挂着"${topic.topic.title}"，你瞥了一眼没太在意。`);
  }

  return lines.length > 0 ? `\n\n## 你今天在网上看到的\n${lines.join("\n")}` : "";
}

/** 重置缓存（测试用） */
export function resetTrendingCache(): void {
  cache = null;
}
