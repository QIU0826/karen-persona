import { EmotionType, SceneType } from "./tone-vault.js";

export interface ConversationContext {
  recentTones: ToneHistory[];
  userStyleProfile: UserStyleProfile;
  conversationPhase: "opening" | "developing" | "deep" | "closing";
  topicContinuity: number;
  emotionalMomentum: number;
}

export interface ToneHistory {
  timestamp: number;
  toneCategory: string;
  toneWord: string;
  position: "start" | "middle" | "end";
  emotionAtTime: EmotionType;
  sceneAtTime: SceneType;
  text: string;
}

export interface UserStyleProfile {
  formalityLevel: number;
  emojiFrequency: number;
  sentenceLength: number;
  questionFrequency: number;
  exclamationFrequency: number;
}

export interface ToneAdvice {
  shouldInsert: boolean;
  suggestedCategory: string | null;
  suggestedWord: string | null;
  suggestedPosition: "start" | "middle" | "end" | null;
  confidence: number;
  reasoning: string;
}

const SCENE_COMPLEXITY: Record<SceneType, number> = {
  greeting: 1,
  farewell: 1,
  question: 2,
  sharing: 3,
  comforting: 4,
  arguing: 4,
  joking: 3,
  serious: 4,
  casual: 2,
};

export class ToneAdvisor {
  private context: ConversationContext;
  private maxHistorySize: number = 5;
  private coherenceWeight: number = 0.3;
  private momentumDecay: number = 0.7;

  constructor(context?: Partial<ConversationContext>) {
    this.context = {
      recentTones: context?.recentTones || [],
      userStyleProfile: context?.userStyleProfile || this.inferDefaultUserStyle(),
      conversationPhase: context?.conversationPhase || "opening",
      topicContinuity: context?.topicContinuity || 0,
      emotionalMomentum: context?.emotionalMomentum || 0,
    };
  }

  private inferDefaultUserStyle(): UserStyleProfile {
    return {
      formalityLevel: 0.5,
      emojiFrequency: 0.3,
      sentenceLength: 0.5,
      questionFrequency: 0.3,
      exclamationFrequency: 0.2,
    };
  }

  updateFromUserMessage(text: string): void {
    const sentences = text.split(/[。！？]/).filter(s => s.trim());
    const hasQuestion = /[？?]/.test(text);
    const hasExclamation = /[！!]/.test(text);
    const avgLength = sentences.reduce((sum, s) => sum + s.length, 0) / Math.max(1, sentences.length);

    this.context.userStyleProfile = {
      formalityLevel: this.adaptFuzzy(this.context.userStyleProfile.formalityLevel, 0.5, 0.1),
      emojiFrequency: this.adaptFuzzy(this.context.userStyleProfile.emojiFrequency, 0.3, 0.1),
      sentenceLength: this.adaptFuzzy(this.context.userStyleProfile.sentenceLength, avgLength / 50, 0.15),
      questionFrequency: this.adaptFuzzy(this.context.userStyleProfile.questionFrequency, hasQuestion ? 1 : 0, 0.2),
      exclamationFrequency: this.adaptFuzzy(this.context.userStyleProfile.exclamationFrequency, hasExclamation ? 1 : 0, 0.15),
    };

    this.context.emotionalMomentum = this.context.emotionalMomentum * this.momentumDecay;
  }

  private adaptFuzzy(current: number, observed: number, learningRate: number): number {
    return current + (observed - current) * learningRate;
  }

  updateFromAssistantMessage(history: ToneHistory): void {
    this.context.recentTones.push(history);
    if (this.context.recentTones.length > this.maxHistorySize) {
      this.context.recentTones.shift();
    }
    this.context.emotionalMomentum = Math.min(1, this.context.emotionalMomentum + 0.2);
  }

  analyzeToneNeed(
    text: string,
    emotion: EmotionType,
    scene: SceneType,
    closeness: number,
  ): ToneAdvice {
    const textLength = text.length;
    const sentences = text.split(/[。！？\n]/).filter(s => s.trim());
    const sentenceCount = sentences.length;

    if (textLength < 10) {
      return {
        shouldInsert: false,
        suggestedCategory: null,
        suggestedWord: null,
        suggestedPosition: null,
        confidence: 0.9,
        reasoning: "文本过短，不需要语气词修饰",
      };
    }

    if (textLength > 200 && sentenceCount > 3) {
      return {
        shouldInsert: true,
        suggestedCategory: "transition",
        suggestedWord: null,
        suggestedPosition: "start",
        confidence: 0.7,
        reasoning: "长文本需要过渡词增强连贯性",
      };
    }

    const sceneComplexity = SCENE_COMPLEXITY[scene];
    const coherencePenalty = this.calculateCoherencePenalty();
    const userAdaptPenalty = this.calculateUserAdaptPenalty();

    const baseNeed = this.calculateBaseNeed(scene, emotion, closeness);
    const adjustedNeed = baseNeed * (1 - coherencePenalty * this.coherenceWeight) * (1 - userAdaptPenalty * 0.2);

    if (adjustedNeed < 0.2) {
      return {
        shouldInsert: false,
        suggestedCategory: null,
        suggestedWord: null,
        suggestedPosition: null,
        confidence: 0.8,
        reasoning: "根据当前上下文分析，语气词插入可能显得不自然",
      };
    }

    if (sceneComplexity >= 4) {
      return {
        shouldInsert: true,
        suggestedCategory: this.selectCategoryForComplexScene(scene, emotion),
        suggestedWord: null,
        suggestedPosition: this.selectPositionForScene(scene),
        confidence: 0.6 + sceneComplexity * 0.05,
        reasoning: "复杂场景适合使用语气词增强情感表达",
      };
    }

    const position = this.selectBestPosition(sentences, textLength);
    const category = this.selectBestCategory(emotion, scene, closeness);

    return {
      shouldInsert: true,
      suggestedCategory: category,
      suggestedWord: null,
      suggestedPosition: position,
      confidence: adjustedNeed,
      reasoning: `基于情绪(${emotion})、场景(${scene})、亲密度(${closeness})综合判断`,
    };
  }

  private calculateCoherencePenalty(): number {
    if (this.context.recentTones.length === 0) return 0;

    const recentCategories = this.context.recentTones.slice(-3).map(t => t.toneCategory);
    const categoryFreq = new Map<string, number>();
    
    for (const cat of recentCategories) {
      categoryFreq.set(cat, (categoryFreq.get(cat) || 0) + 1);
    }

    let coherencePenalty = 0;
    for (const [, freq] of categoryFreq) {
      if (freq >= 2) {
        coherencePenalty = Math.max(coherencePenalty, (freq - 1) * 0.3);
      }
    }

    return Math.min(1, coherencePenalty);
  }

  private calculateUserAdaptPenalty(): number {
    const { userStyleProfile } = this.context;
    
    if (userStyleProfile.emojiFrequency < 0.1 && userStyleProfile.exclamationFrequency < 0.1) {
      return 0.4;
    }
    
    if (userStyleProfile.formalityLevel > 0.7) {
      return 0.3;
    }
    
    return 0;
  }

  private calculateBaseNeed(scene: SceneType, emotion: EmotionType, closeness: number): number {
    const sceneNeed = {
      greeting: 0.8,
      farewell: 0.7,
      question: 0.5,
      sharing: 0.6,
      comforting: 0.8,
      arguing: 0.3,
      joking: 0.7,
      serious: 0.2,
      casual: 0.6,
    }[scene];

    const emotionNeed = {
      happy: 0.8,
      excited: 0.9,
      shy: 0.7,
      sad: 0.6,
      anxious: 0.5,
      neutral: 0.4,
      angry: 0.3,
      surprised: 0.6,
      thinking: 0.4,
    }[emotion];

    const closenessBonus = closeness / 10 * 0.2;

    return Math.min(1, sceneNeed * emotionNeed + closenessBonus);
  }

  private selectCategoryForComplexScene(scene: SceneType, emotion: EmotionType): string {
    if (scene === "comforting" || scene === "arguing") {
      return emotion === "sad" || emotion === "angry" ? "softener" : "reaction";
    }
    if (scene === "serious") {
      return "emphasis";
    }
    return "transition";
  }

  private selectPositionForScene(scene: SceneType): "start" | "middle" | "end" {
    if (scene === "greeting" || scene === "farewell") {
      return "end";
    }
    if (scene === "question") {
      return "start";
    }
    if (scene === "serious") {
      return "middle";
    }
    return Math.random() > 0.5 ? "start" : "end";
  }

  private selectBestPosition(sentences: string[], _textLength: number): "start" | "middle" | "end" {
    if (sentences.length <= 1) {
      return Math.random() > 0.5 ? "start" : "end";
    }

    const firstSentenceLength = sentences[0]?.length || 0;
    const lastSentenceLength = sentences[sentences.length - 1]?.length || 0;

    if (firstSentenceLength < 10) {
      return "end";
    }
    if (lastSentenceLength < 10) {
      return "start";
    }

    const random = Math.random();
    if (random < 0.4) return "start";
    if (random < 0.7) return "end";
    return "middle";
  }

  private selectBestCategory(emotion: EmotionType, scene: SceneType, closeness: number): string {
    const priorities = this.getCategoryPriorities(emotion, scene, closeness);
    
    for (const category of priorities) {
      if (Math.random() < 0.6) {
        return category;
      }
    }

    return priorities[Math.floor(Math.random() * priorities.length)];
  }

  private getCategoryPriorities(emotion: EmotionType, _scene: SceneType, closeness: number): string[] {
    const base = ["sentenceEnd"];

    if (emotion === "excited" || emotion === "happy") {
      base.push("reaction", "softener", "emphasis");
    } else if (emotion === "sad" || emotion === "anxious" || emotion === "shy") {
      base.push("hesitation", "softener", "sentenceEnd");
    } else if (emotion === "angry") {
      base.push("emphasis", "reaction");
    } else {
      base.push("transition", "emphasis", "hesitation");
    }

    if (closeness >= 7) {
      base.push("softener", "reaction");
    }

    return base;
  }

  getContext(): ConversationContext {
    return { ...this.context };
  }

  getRecentToneHistory(): ToneHistory[] {
    return [...this.context.recentTones];
  }
}

export function createToneAdvisor(context?: Partial<ConversationContext>): ToneAdvisor {
  return new ToneAdvisor(context);
}