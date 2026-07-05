import {
  EmotionType, SceneType, ClosenessLevel, ToneCategory,
  TONE_VAULT, CATEGORY_CONFIG, getToneWordsByContext, calculateCategoryProbability,
} from "./tone-vault.js";

export interface ContextFactors {
  emotion: EmotionType;
  scene: SceneType;
  closeness: ClosenessLevel;
  recentMessages: string[];
  currentTopic: string;
  impulseIntensity: number;
  guilt: number;
  busyLevel: number;
}

export interface ToneStyleProfile {
  name: string;
  description: string;
  frequency: number;
  intensityModifiers: Record<ToneCategory, number>;
  emotionBias: Partial<Record<EmotionType, number>>;
  sceneBias: Partial<Record<SceneType, number>>;
}

export const TONE_STYLES: Record<string, ToneStyleProfile> = {
  natural: {
    name: "自然",
    description: "中性自然的表达，符合日常聊天习惯",
    frequency: 0.5,
    intensityModifiers: {
      sentenceEnd: 1.0, hesitation: 1.0, transition: 1.0, emphasis: 1.0, reaction: 0.8, softener: 0.8,
    },
    emotionBias: {},
    sceneBias: {},
  },
  friendly: {
    name: "友好",
    description: "亲切友好的表达，适合朋友之间",
    frequency: 0.7,
    intensityModifiers: {
      sentenceEnd: 1.2, hesitation: 0.8, transition: 1.0, emphasis: 1.0, reaction: 1.2, softener: 1.2,
    },
    emotionBias: { happy: 1.2, excited: 1.2 },
    sceneBias: { greeting: 1.3, sharing: 1.2 },
  },
  coy: {
    name: "撒娇",
    description: "可爱撒娇的表达，适合亲密关系",
    frequency: 0.8,
    intensityModifiers: {
      sentenceEnd: 1.4, hesitation: 1.2, transition: 1.0, emphasis: 1.2, reaction: 1.4, softener: 1.4,
    },
    emotionBias: { shy: 1.3, happy: 1.2, excited: 1.3 },
    sceneBias: { casual: 1.3, joking: 1.4 },
  },
  casual: {
    name: "随意",
    description: "轻松随意的表达，适合同辈之间",
    frequency: 0.6,
    intensityModifiers: {
      sentenceEnd: 1.0, hesitation: 1.0, transition: 1.1, emphasis: 0.9, reaction: 1.0, softener: 0.9,
    },
    emotionBias: { neutral: 1.2 },
    sceneBias: { casual: 1.3, sharing: 1.1 },
  },
  serious: {
    name: "严肃",
    description: "稳重严肃的表达，适合正式场合",
    frequency: 0.3,
    intensityModifiers: {
      sentenceEnd: 0.5, hesitation: 0.8, transition: 1.0, emphasis: 1.2, reaction: 0.3, softener: 0.3,
    },
    emotionBias: { angry: 1.2, surprised: 1.0 },
    sceneBias: { serious: 1.5, arguing: 1.2 },
  },
  shy: {
    name: "害羞",
    description: "羞涩内敛的表达，适合内向人设",
    frequency: 0.6,
    intensityModifiers: {
      sentenceEnd: 1.1, hesitation: 1.3, transition: 0.8, emphasis: 0.8, reaction: 0.6, softener: 1.2,
    },
    emotionBias: { shy: 1.5, anxious: 1.2 },
    sceneBias: { greeting: 0.8, sharing: 1.0 },
  },
};

export interface ToneDecision {
  category: ToneCategory;
  word: string;
  position: "start" | "middle" | "end";
  probability: number;
}

export class ToneDecisionEngine {
  private styleProfile: ToneStyleProfile;

  constructor(styleName: string = "natural") {
    this.styleProfile = TONE_STYLES[styleName] || TONE_STYLES.natural;
  }

  setStyle(styleName: string): void {
    this.styleProfile = TONE_STYLES[styleName] || TONE_STYLES.natural;
  }

  analyzeContext(factors: ContextFactors): { emotion: EmotionType; scene: SceneType; closeness: ClosenessLevel } {
    let adjustedEmotion = factors.emotion;
    let adjustedScene = factors.scene;
    let adjustedCloseness = factors.closeness;

    if (factors.guilt > 0.5) {
      adjustedEmotion = "anxious";
    }

    if (factors.busyLevel >= 2) {
      adjustedScene = "serious";
    }

    if (factors.impulseIntensity > 0.7) {
      adjustedEmotion = factors.emotion === "happy" ? "excited" : adjustedEmotion;
    }

    return { emotion: adjustedEmotion, scene: adjustedScene, closeness: adjustedCloseness };
  }

  generateDecisions(factors: ContextFactors): ToneDecision[] {
    const adjusted = this.analyzeContext(factors);
    const decisions: ToneDecision[] = [];
    const baseFrequency = this.styleProfile.frequency;
    const categories: ToneCategory[] = ["sentenceEnd", "hesitation", "transition", "emphasis", "reaction", "softener"];

    for (const category of categories) {
      const config = CATEGORY_CONFIG[category];
      if (!config) continue;

      let probability = calculateCategoryProbability(
        config, adjusted.emotion, adjusted.scene, adjusted.closeness, baseFrequency
      );

      const styleIntensity = this.styleProfile.intensityModifiers[category] || 1;
      const emotionBias = this.styleProfile.emotionBias[adjusted.emotion] || 1;
      const sceneBias = this.styleProfile.sceneBias[adjusted.scene] || 1;

      probability *= styleIntensity * emotionBias * sceneBias;

      if (probability > 0.05 && Math.random() < probability) {
        const candidates = getToneWordsByContext(adjusted.emotion, adjusted.scene, adjusted.closeness, category);
        
        if (candidates.length > 0) {
          const weights = candidates.map(c => c.intensity * c.frequency);
          const totalWeight = weights.reduce((a, b) => a + b, 0);
          let random = Math.random() * totalWeight;
          let selected = candidates[0];

          for (let i = 0; i < candidates.length; i++) {
            random -= weights[i];
            if (random <= 0) {
              selected = candidates[i];
              break;
            }
          }

          let position: "start" | "middle" | "end" = "end";
          switch (category) {
            case "hesitation": position = "start"; break;
            case "transition": position = "start"; break;
            case "reaction": position = "start"; break;
            case "emphasis": position = "middle"; break;
            case "softener": position = "middle"; break;
            case "sentenceEnd": position = "end"; break;
          }

          decisions.push({ category, word: selected.word, position, probability });
        }
      }
    }

    return decisions;
  }

  getStyleProfile(): ToneStyleProfile {
    return this.styleProfile;
  }
}