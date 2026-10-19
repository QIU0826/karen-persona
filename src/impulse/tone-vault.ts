export type EmotionType = "happy" | "sad" | "angry" | "surprised" | "anxious" | "neutral" | "shy" | "excited" | "thinking";

export type SceneType = "greeting" | "farewell" | "question" | "sharing" | "comforting" | "arguing" | "joking" | "serious" | "casual";

export type ClosenessLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type ToneCategory = "sentenceEnd" | "hesitation" | "transition" | "emphasis" | "reaction" | "softener";

export interface ToneWord {
  word: string;
  emotion: EmotionType | EmotionType[];
  scene: SceneType | SceneType[];
  closeness: { min: ClosenessLevel; max: ClosenessLevel };
  intensity: number;
  frequency: number;
}

export interface ToneCategoryConfig {
  category: ToneCategory;
  baseProbability: number;
  emotionMultiplier: Record<EmotionType, number>;
  closenessMultiplier: (level: ClosenessLevel) => number;
  sceneMultiplier: Record<SceneType, number>;
}

export const TONE_VAULT: Record<ToneCategory, ToneWord[]> = {
  sentenceEnd: [
    { word: "呀", emotion: ["happy", "excited", "neutral"], scene: ["casual", "sharing", "greeting"], closeness: { min: 3, max: 10 }, intensity: 0.8, frequency: 0.7 },
    { word: "呢", emotion: ["neutral", "shy", "anxious"], scene: ["question", "sharing", "comforting"], closeness: { min: 2, max: 10 }, intensity: 0.6, frequency: 0.8 },
    { word: "吧", emotion: ["neutral", "anxious", "shy"], scene: ["question", "serious", "casual"], closeness: { min: 1, max: 10 }, intensity: 0.5, frequency: 0.9 },
    { word: "哦", emotion: ["surprised", "neutral", "happy"], scene: ["sharing", "question", "casual"], closeness: { min: 2, max: 10 }, intensity: 0.7, frequency: 0.7 },
    { word: "啊", emotion: ["excited", "surprised", "sad"], scene: ["sharing", "greeting", "farewell"], closeness: { min: 4, max: 10 }, intensity: 0.9, frequency: 0.6 },
    { word: "哒", emotion: ["happy", "excited", "shy"], scene: ["casual", "greeting", "sharing"], closeness: { min: 5, max: 10 }, intensity: 1.0, frequency: 0.5 },
    { word: "哈", emotion: ["happy"], scene: ["casual", "joking", "sharing"], closeness: { min: 4, max: 10 }, intensity: 0.8, frequency: 0.5 },
    { word: "嘞", emotion: ["happy", "excited"], scene: ["casual", "greeting", "sharing"], closeness: { min: 5, max: 10 }, intensity: 0.9, frequency: 0.4 },
    { word: "喵", emotion: ["happy", "shy", "excited"], scene: ["casual", "joking"], closeness: { min: 7, max: 10 }, intensity: 1.0, frequency: 0.3 },
    { word: "嗷", emotion: ["excited", "surprised"], scene: ["casual", "joking", "sharing"], closeness: { min: 6, max: 10 }, intensity: 1.0, frequency: 0.3 },
    { word: "呜", emotion: ["sad", "anxious"], scene: ["comforting", "sharing"], closeness: { min: 5, max: 10 }, intensity: 0.9, frequency: 0.4 },
    { word: "嘛", emotion: ["shy", "anxious"], scene: ["question", "casual"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.5 },
    { word: "呗", emotion: ["neutral"], scene: ["casual", "question"], closeness: { min: 3, max: 8 }, intensity: 0.5, frequency: 0.6 },
    { word: "哦~", emotion: ["surprised", "happy"], scene: ["sharing", "casual"], closeness: { min: 5, max: 10 }, intensity: 0.8, frequency: 0.4 },
    { word: "呀~", emotion: ["excited", "happy"], scene: ["greeting", "sharing"], closeness: { min: 6, max: 10 }, intensity: 0.9, frequency: 0.4 },
  ],
  hesitation: [
    { word: "嗯...", emotion: ["neutral", "anxious", "thinking"], scene: ["question", "serious", "casual"], closeness: { min: 1, max: 10 }, intensity: 0.6, frequency: 0.5 },
    { word: "那个...", emotion: ["shy", "anxious"], scene: ["casual", "sharing", "question"], closeness: { min: 3, max: 10 }, intensity: 0.5, frequency: 0.6 },
    { word: "其实吧...", emotion: ["neutral", "shy"], scene: ["sharing", "serious", "casual"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.4 },
    { word: "嗯~", emotion: ["happy", "shy"], scene: ["casual", "greeting"], closeness: { min: 5, max: 10 }, intensity: 0.8, frequency: 0.3 },
    { word: "那个嘛...", emotion: ["shy", "anxious"], scene: ["casual", "question"], closeness: { min: 5, max: 10 }, intensity: 0.6, frequency: 0.4 },
    { word: "额...", emotion: ["surprised", "anxious"], scene: ["question", "serious"], closeness: { min: 2, max: 9 }, intensity: 0.5, frequency: 0.5 },
    { word: "唔...", emotion: ["thinking", "anxious"], scene: ["question", "serious"], closeness: { min: 3, max: 10 }, intensity: 0.6, frequency: 0.4 },
    { word: "嗯哼...", emotion: ["shy", "happy"], scene: ["casual", "joking"], closeness: { min: 7, max: 10 }, intensity: 0.9, frequency: 0.3 },
  ],
  transition: [
    { word: "然后", emotion: ["neutral"], scene: ["sharing", "casual"], closeness: { min: 1, max: 10 }, intensity: 0.4, frequency: 0.8 },
    { word: "接着", emotion: ["neutral"], scene: ["sharing", "casual"], closeness: { min: 1, max: 10 }, intensity: 0.4, frequency: 0.7 },
    { word: "不过", emotion: ["neutral", "surprised"], scene: ["sharing", "serious"], closeness: { min: 2, max: 10 }, intensity: 0.5, frequency: 0.7 },
    { word: "然后呢", emotion: ["happy", "excited"], scene: ["casual", "sharing"], closeness: { min: 4, max: 10 }, intensity: 0.6, frequency: 0.6 },
    { word: "接着呀", emotion: ["happy", "excited"], scene: ["casual", "sharing"], closeness: { min: 5, max: 10 }, intensity: 0.7, frequency: 0.5 },
    { word: "不过呢", emotion: ["neutral", "shy"], scene: ["sharing", "casual"], closeness: { min: 4, max: 10 }, intensity: 0.6, frequency: 0.5 },
    { word: "而且", emotion: ["excited", "happy"], scene: ["sharing", "casual"], closeness: { min: 3, max: 10 }, intensity: 0.5, frequency: 0.6 },
    { word: "话说", emotion: ["neutral"], scene: ["casual", "joking"], closeness: { min: 4, max: 10 }, intensity: 0.6, frequency: 0.5 },
  ],
  emphasis: [
    { word: "真的", emotion: ["happy", "surprised"], scene: ["sharing", "serious", "casual"], closeness: { min: 2, max: 10 }, intensity: 0.7, frequency: 0.6 },
    { word: "确实", emotion: ["neutral"], scene: ["sharing", "serious"], closeness: { min: 2, max: 10 }, intensity: 0.6, frequency: 0.7 },
    { word: "其实", emotion: ["neutral", "shy"], scene: ["sharing", "serious", "casual"], closeness: { min: 3, max: 10 }, intensity: 0.6, frequency: 0.7 },
    { word: "真的哦", emotion: ["happy", "excited"], scene: ["casual", "sharing"], closeness: { min: 5, max: 10 }, intensity: 0.8, frequency: 0.5 },
    { word: "确实呢", emotion: ["neutral", "happy"], scene: ["sharing", "casual"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.5 },
    { word: "其实呀", emotion: ["shy", "happy"], scene: ["casual", "sharing"], closeness: { min: 5, max: 10 }, intensity: 0.7, frequency: 0.4 },
    { word: "真的喵", emotion: ["happy", "excited"], scene: ["casual", "joking"], closeness: { min: 7, max: 10 }, intensity: 1.0, frequency: 0.3 },
    { word: "说实话", emotion: ["neutral"], scene: ["serious", "sharing"], closeness: { min: 4, max: 10 }, intensity: 0.8, frequency: 0.4 },
    { word: "老实说", emotion: ["shy"], scene: ["serious", "sharing"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.4 },
  ],
  reaction: [
    { word: "哇", emotion: ["surprised", "excited"], scene: ["sharing", "greeting"], closeness: { min: 4, max: 10 }, intensity: 0.9, frequency: 0.5 },
    { word: "天呐", emotion: ["surprised"], scene: ["sharing"], closeness: { min: 3, max: 10 }, intensity: 0.8, frequency: 0.4 },
    { word: "哎呀", emotion: ["surprised", "sad"], scene: ["sharing", "comforting"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.5 },
    { word: "哦豁", emotion: ["surprised"], scene: ["casual", "joking"], closeness: { min: 5, max: 10 }, intensity: 0.8, frequency: 0.4 },
    { word: "诶", emotion: ["surprised"], scene: ["question", "sharing"], closeness: { min: 2, max: 10 }, intensity: 0.6, frequency: 0.6 },
    { word: "嘿", emotion: ["happy", "excited"], scene: ["greeting", "casual"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.5 },
    { word: "哼", emotion: ["angry", "shy"], scene: ["arguing", "casual"], closeness: { min: 5, max: 10 }, intensity: 0.8, frequency: 0.4 },
    { word: "嘻", emotion: ["happy", "shy"], scene: ["casual", "joking"], closeness: { min: 6, max: 10 }, intensity: 0.8, frequency: 0.4 },
  ],
  softener: [
    { word: "啦", emotion: ["happy", "shy", "excited"], scene: ["casual", "greeting", "sharing"], closeness: { min: 4, max: 10 }, intensity: 0.7, frequency: 0.6 },
    { word: "哟", emotion: ["happy", "excited"], scene: ["greeting", "casual"], closeness: { min: 5, max: 10 }, intensity: 0.8, frequency: 0.5 },
    { word: "呢~", emotion: ["shy", "happy"], scene: ["casual", "question"], closeness: { min: 6, max: 10 }, intensity: 0.8, frequency: 0.4 },
    { word: "哦哟", emotion: ["surprised", "happy"], scene: ["casual", "sharing"], closeness: { min: 5, max: 10 }, intensity: 0.7, frequency: 0.4 },
    { word: "呀~", emotion: ["excited", "happy"], scene: ["greeting", "sharing"], closeness: { min: 6, max: 10 }, intensity: 0.9, frequency: 0.4 },
  ],
};

export const CATEGORY_CONFIG: Record<ToneCategory, ToneCategoryConfig> = {
  sentenceEnd: {
    category: "sentenceEnd",
    baseProbability: 0.5,
    emotionMultiplier: {
      happy: 1.3, sad: 1.2, angry: 0.5, surprised: 1.2, anxious: 1.0, neutral: 1.0, shy: 1.1, excited: 1.4, thinking: 1.0,
    },
    closenessMultiplier: (level) => 0.5 + level * 0.05,
    sceneMultiplier: {
      greeting: 1.2, farewell: 1.1, question: 1.0, sharing: 1.1, comforting: 1.2, arguing: 0.3, joking: 1.3, serious: 0.5, casual: 1.2,
    },
  },
  hesitation: {
    category: "hesitation",
    baseProbability: 0.15,
    emotionMultiplier: {
      happy: 0.5, sad: 1.2, angry: 0.8, surprised: 1.0, anxious: 1.5, neutral: 1.0, shy: 1.3, excited: 0.5, thinking: 1.5,
    },
    closenessMultiplier: (level) => 0.3 + level * 0.04,
    sceneMultiplier: {
      greeting: 0.3, farewell: 0.5, question: 1.2, sharing: 1.0, comforting: 1.0, arguing: 0.8, joking: 0.5, serious: 1.3, casual: 0.8,
    },
  },
  transition: {
    category: "transition",
    baseProbability: 0.2,
    emotionMultiplier: {
      happy: 1.0, sad: 0.8, angry: 0.8, surprised: 1.0, anxious: 0.9, neutral: 1.0, shy: 0.9, excited: 1.1, thinking: 1.0,
    },
    closenessMultiplier: (level) => 0.4 + level * 0.03,
    sceneMultiplier: {
      greeting: 0.5, farewell: 0.5, question: 0.8, sharing: 1.3, comforting: 1.0, arguing: 1.0, joking: 1.0, serious: 1.0, casual: 1.2,
    },
  },
  emphasis: {
    category: "emphasis",
    baseProbability: 0.2,
    emotionMultiplier: {
      happy: 1.2, sad: 1.1, angry: 1.3, surprised: 1.3, anxious: 1.0, neutral: 0.8, shy: 0.9, excited: 1.2, thinking: 1.1,
    },
    closenessMultiplier: (level) => 0.4 + level * 0.04,
    sceneMultiplier: {
      greeting: 0.5, farewell: 0.5, question: 0.8, sharing: 1.1, comforting: 1.0, arguing: 1.5, joking: 0.8, serious: 1.3, casual: 0.8,
    },
  },
  reaction: {
    category: "reaction",
    baseProbability: 0.1,
    emotionMultiplier: {
      happy: 1.5, sad: 1.0, angry: 0.5, surprised: 1.8, anxious: 0.8, neutral: 0.3, shy: 0.8, excited: 1.6, thinking: 0.5,
    },
    closenessMultiplier: (level) => 0.2 + level * 0.06,
    sceneMultiplier: {
      greeting: 1.5, farewell: 0.8, question: 1.2, sharing: 1.5, comforting: 0.8, arguing: 0.3, joking: 1.8, serious: 0.3, casual: 1.2,
    },
  },
  softener: {
    category: "softener",
    baseProbability: 0.15,
    emotionMultiplier: {
      happy: 1.3, sad: 1.1, angry: 0.2, surprised: 1.0, anxious: 1.2, neutral: 0.6, shy: 1.4, excited: 1.3, thinking: 0.8,
    },
    closenessMultiplier: (level) => 0.2 + level * 0.07,
    sceneMultiplier: {
      greeting: 1.3, farewell: 1.1, question: 1.0, sharing: 1.2, comforting: 1.3, arguing: 0.2, joking: 1.4, serious: 0.3, casual: 1.3,
    },
  },
};

export function getToneWordsByContext(
  emotion: EmotionType,
  scene: SceneType,
  closeness: ClosenessLevel,
  category: ToneCategory,
): ToneWord[] {
  const words = TONE_VAULT[category];
  return words.filter(word => {
    const emotionMatch = Array.isArray(word.emotion)
      ? word.emotion.includes(emotion)
      : word.emotion === emotion;
    const sceneMatch = Array.isArray(word.scene)
      ? word.scene.includes(scene)
      : word.scene === scene;
    const closenessMatch = closeness >= word.closeness.min && closeness <= word.closeness.max;
    return emotionMatch && sceneMatch && closenessMatch;
  });
}

export function calculateCategoryProbability(
  config: ToneCategoryConfig,
  emotion: EmotionType,
  scene: SceneType,
  closeness: ClosenessLevel,
  baseFrequency: number,
): number {
  const emotionMult = config.emotionMultiplier[emotion] || 1;
  const sceneMult = config.sceneMultiplier[scene] || 1;
  const closenessMult = config.closenessMultiplier(closeness);
  return config.baseProbability * emotionMult * sceneMult * closenessMult * baseFrequency;
}