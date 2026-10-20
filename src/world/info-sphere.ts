/**
 * 信息圈层（域七 P2）。
 * Phase 5: 四维并集 + 穿透力层级 + 态度生成。
 */

export interface InfoSource {
  /** 信息源名称 */
  name: string;
  /** 圈层类型 */
  sphere: "职业" | "爱好" | "社交" | "生活";
  /** 当前活跃度 0-1 */
  activity: number;
}

export interface TrendingItem {
  title: string;
  layer: 1 | 2 | 3; // 1=全民级, 2=圈层级, 3=微圈层
  relatedSphere?: string;
}

/**
 * 由 L2 身份和 L6 兴趣生成信息圈层。
 */
export function buildInfoSphere(
  career: string,
  hobbies: string[],
  socialConnections: string[]
): InfoSource[] {
  const sources: InfoSource[] = [];

  // 职业信息源
  if (career.includes("程序员") || career.includes("开发")) {
    sources.push({ name: "GitHub Trending", sphere: "职业", activity: 0.8 });
    sources.push({ name: "技术社区", sphere: "职业", activity: 0.7 });
  } else if (career.includes("咖啡")) {
    sources.push({ name: "咖啡圈小红书", sphere: "职业", activity: 0.9 });
    sources.push({ name: "咖啡比赛资讯", sphere: "职业", activity: 0.6 });
  } else {
    sources.push({ name: "行业微信群", sphere: "职业", activity: 0.5 });
  }

  // 爱好信息源
  for (const hobby of hobbies) {
    sources.push({ name: `${hobby}相关内容`, sphere: "爱好", activity: 0.6 + Math.random() * 0.3 });
  }

  // 社交信息源
  for (const person of socialConnections) {
    sources.push({ name: `${person}的分享`, sphere: "社交", activity: 0.3 + Math.random() * 0.4 });
  }

  // 生活信息源
  sources.push({ name: "本地生活信息", sphere: "生活", activity: 0.4 });

  return sources;
}

/**
 * 判断一个热点对人设的穿透力。
 * Layer 1（全民级）→ 直接穿透，不论圈层。
 * Layer 2（圈层级）→ 需要匹配圈层。
 * Layer 3（微圈层）→ 深度圈层匹配。
 */
export function penetrationCheck(
  item: TrendingItem,
  sources: InfoSource[]
): {
  reaches: boolean;
  attitude: "care" | "know_but_dont_care" | "unaware" | "excited";
} {
  // Layer 1: 直接穿透
  if (item.layer === 1) {
    return {
      reaches: true,
      attitude: Math.random() > 0.5 ? "know_but_dont_care" : "care",
    };
  }

  // Layer 2/3: 需要圈层匹配
  const relatedSources = sources.filter(
    (s) => item.relatedSphere && s.sphere === item.relatedSphere
  );

  if (relatedSources.length > 0 && relatedSources.some((s) => s.activity > 0.5)) {
    return {
      reaches: true,
      attitude: item.layer === 2 ? "care" : "excited",
    };
  }

  return { reaches: false, attitude: "unaware" };
}

/**
 * 生成"知道但不关心"的回应模板。
 * 可以没有观点，但不能没有反应。
 */
export function neutralAwarenessResponse(_topic: string): string {
  const templates = [
    `哦那个，我不太追这些。怎么了？`,
    `好像瞥到过一眼，但没仔细看。发生什么了？`,
    `不太关注这个，不过看你反应很大，说说？`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}
