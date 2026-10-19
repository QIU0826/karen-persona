import { ToneDecisionEngine, ContextFactors } from "./tone-engine.js";
import { ToneAdvisor, createToneAdvisor, ToneHistory } from "./tone-advisor.js";
import { EmotionType, SceneType, ClosenessLevel, TONE_VAULT, getToneWordsByContext } from "./tone-vault.js";

export interface ToneConfig {
  style: string;
  frequency: number;
  emotion?: EmotionType;
  scene?: SceneType;
  closeness?: ClosenessLevel;
}

export interface ToneContext {
  emotionVector: number;
  closeness: number;
  impulseIntensity: number;
  guilt: number;
  busyLevel: number;
  recentMessages?: string[];
  currentTopic?: string;
}

const EMOTION_VECTOR_MAP: Record<string, EmotionType[]> = {
  stronglyNegative: ["angry", "sad"],
  negative: ["sad", "anxious"],
  slightlyNegative: ["anxious", "shy"],
  neutral: ["neutral"],
  slightlyPositive: ["shy", "happy"],
  positive: ["happy"],
  stronglyPositive: ["happy", "excited"],
};

function mapEmotionVector(vector: number): EmotionType {
  if (vector < -0.5) return EMOTION_VECTOR_MAP.stronglyNegative[Math.floor(Math.random() * 2)];
  if (vector < -0.2) return EMOTION_VECTOR_MAP.negative[Math.floor(Math.random() * 2)];
  if (vector < 0) return EMOTION_VECTOR_MAP.slightlyNegative[Math.floor(Math.random() * 2)];
  if (vector < 0.2) return EMOTION_VECTOR_MAP.neutral[0];
  if (vector < 0.5) return EMOTION_VECTOR_MAP.slightlyPositive[Math.floor(Math.random() * 2)];
  if (vector < 0.8) return EMOTION_VECTOR_MAP.positive[0];
  return EMOTION_VECTOR_MAP.stronglyPositive[Math.floor(Math.random() * 2)];
}

function detectScene(text: string): SceneType {
  const trimmed = text.trim();
  
  if (/^(你好|嗨|哈喽|hi|hello|早上好|晚上好|早安|晚安)/i.test(trimmed)) {
    return "greeting";
  }
  if (/^(拜拜|再见|晚安|先走了|下次见)/i.test(trimmed)) {
    return "farewell";
  }
  if (/^(怎么|为什么|什么|谁|哪里|何时|是否|能不能)/i.test(trimmed) || trimmed.endsWith("？") || trimmed.endsWith("?")) {
    return "question";
  }
  if (/^(我觉得|我认为|其实|说实话|老实说|个人认为)/i.test(trimmed)) {
    return "serious";
  }
  if (/^(哈哈|呵呵|笑死|搞笑|好玩|笑)/i.test(trimmed)) {
    return "joking";
  }
  if (/^(难过|伤心|心情不好|难受|郁闷|不爽)/i.test(trimmed)) {
    return "comforting";
  }
  if (/^(不对|不是|你错了|我觉得不对)/i.test(trimmed)) {
    return "arguing";
  }
  
  return "casual";
}

function mapClosenessLevel(closeness: number): ClosenessLevel {
  const level = Math.round(closeness);
  return Math.max(0, Math.min(10, level)) as ClosenessLevel;
}

function selectSmartToneWord(
  category: string,
  emotion: EmotionType,
  scene: SceneType,
  closeness: ClosenessLevel,
  recentTones: ToneHistory[]
): string | null {
  const candidates = getToneWordsByContext(emotion, scene, closeness, category as any);
  
  if (candidates.length === 0) return null;

  const recentCategories = recentTones.map(t => t.toneWord);
  const availableCandidates = candidates.filter(c => !recentCategories.includes(c.word));

  const pool = availableCandidates.length > 0 ? availableCandidates : candidates;
  
  const weights = pool.map(c => c.intensity * c.frequency);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  
  let random = Math.random() * totalWeight;
  for (let i = 0; i < pool.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return pool[i].word;
    }
  }
  
  return pool[pool.length - 1].word;
}

export function insertToneMarkers(
  text: string,
  config: ToneConfig,
  context?: ToneContext
): string {
  if (config.frequency <= 0) return text;

  const emotion = config.emotion || (context ? mapEmotionVector(context.emotionVector) : "neutral");
  const scene = config.scene || detectScene(text);
  const closeness = config.closeness || (context ? mapClosenessLevel(context.closeness) : 5);

  const advisor = createToneAdvisor({
    recentTones: [],
    conversationPhase: "developing",
    emotionalMomentum: context?.impulseIntensity || 0,
  });

  const advice = advisor.analyzeToneNeed(text, emotion, scene, closeness);

  if (!advice.shouldInsert) {
    return text;
  }

  const effectiveFrequency = config.frequency * advice.confidence;
  if (Math.random() > effectiveFrequency) {
    return text;
  }

  const engine = new ToneDecisionEngine(config.style);

  const factors: ContextFactors = {
    emotion,
    scene,
    closeness,
    recentMessages: context?.recentMessages || [],
    currentTopic: context?.currentTopic || "",
    impulseIntensity: context?.impulseIntensity || 0,
    guilt: context?.guilt || 0,
    busyLevel: context?.busyLevel || 0,
  };

  let decisions = engine.generateDecisions(factors);

  if (advice.suggestedCategory) {
    const filtered = decisions.filter(d => d.category === advice.suggestedCategory);
    if (filtered.length > 0) {
      decisions = filtered;
    }
  }

  if (advice.suggestedPosition) {
    const filtered = decisions.filter(d => d.position === advice.suggestedPosition);
    if (filtered.length > 0) {
      decisions = filtered;
    }
  }

  let result = text;

  const startDecisions = decisions.filter(d => d.position === "start");
  const middleDecisions = decisions.filter(d => d.position === "middle");
  const endDecisions = decisions.filter(d => d.position === "end");

  for (const decision of startDecisions) {
    if (Math.random() < 0.7) {
      const toneWord = selectSmartToneWord(decision.category, emotion, scene, closeness, advisor.getRecentToneHistory());
      if (toneWord) {
        result = toneWord + " " + result;
      } else {
        result = decision.word + " " + result;
      }
    }
  }

  for (const decision of middleDecisions) {
    if (result.length > 8 && Math.random() < 0.6) {
      const insertPos = Math.floor(result.length * (0.3 + Math.random() * 0.4));
      const char = result[insertPos];
      if (char && !/[，。！？、：；]/.test(char)) {
        const toneWord = selectSmartToneWord(decision.category, emotion, scene, closeness, advisor.getRecentToneHistory());
        const word = toneWord || decision.word;
        result = result.slice(0, insertPos) + word + " " + result.slice(insertPos);
      }
    }
  }

  for (const decision of endDecisions) {
    if (Math.random() < 0.8) {
      const lastChar = result[result.length - 1];
      if (/[。！？]/.test(lastChar)) {
        const toneWord = selectSmartToneWord(decision.category, emotion, scene, closeness, advisor.getRecentToneHistory());
        const word = toneWord || decision.word;
        result = result.slice(0, -1) + word + lastChar;
      } else if (result.length > 0) {
        const toneWord = selectSmartToneWord(decision.category, emotion, scene, closeness, advisor.getRecentToneHistory());
        result = result + (toneWord || decision.word);
      }
    }
  }

  return result.replace(/\s+/g, " ").trim();
}
