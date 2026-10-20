/**
 * 感知姿态（域七）。
 * 定义人设"如何伸出手去触碰世界"——主动/被动/防御。
 */

export type StanceType = "active" | "passive" | "defensive";

export interface PerceptualStance {
  weather: StanceType;
  news: StanceType;
  social: StanceType; // 对社交圈动态
  hobbies: StanceType; // 对兴趣领域
}

/**
 * 由 L2 身份自然导出感知姿态。
 */
export function deriveStance(
  age: number,
  _personality: string
): PerceptualStance {
  // 年轻人更主动，年长者更防御型（对流行文化）
  const isYoung = age < 25;
  const isMiddle = age >= 25 && age < 40;

  return {
    weather: isYoung ? "passive" : "active", // 年轻人出门才知道下雨
    news: isYoung ? "active" : isMiddle ? "defensive" : "passive",
    social: "active", // 大多数人社交方面都是主动感知
    hobbies: "active", // 对自己感兴趣的东西主动
  };
}

/**
 * 不同感知姿态下，"觉察时刻"的行为。
 */
export function awarenessMoment(
  stance: StanceType,
  infoType: string,
  infoContent: string
): {
  triggersAt: string; // 什么时候觉察
  reaction: string; // 觉察时的反应
  sharesImmediately: boolean; // 是否立即分享
} {
  switch (stance) {
    case "active":
      return {
        triggersAt: "立即——醒来/打开手机时就知道了",
        reaction: `知道了，已有心理准备。可能主动提起："今天${infoContent}"`,
        sharesImmediately: Math.random() > 0.5,
      };
    case "passive":
      return {
        triggersAt: "延迟——出门/被提醒时才知道",
        reaction: `"啊，${infoContent}"——那个"啊"的瞬间`,
        sharesImmediately: false,
      };
    case "defensive":
      return {
        triggersAt: "潜意识知道但不主动提",
        reaction: `被问起时："哦${infoType === '天气' ? '下雨了' : '那个啊'}？没注意"`,
        sharesImmediately: false,
      };
  }
}
