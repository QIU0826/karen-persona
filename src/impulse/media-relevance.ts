/**
 * 多媒体相关性（v0.9）：让照片/配文跟"正在聊的事"有关，而不是随情绪随机丢一张。
 *
 * 背景：21 轮全链路回归里，LLM 评审连续两轮给「多媒体 2/5」——照片/语音/表情确实都发了
 * （7/9/4 条），但评审认为**跟对话内容关联不强**。根因有两个：
 *  1. 选图只看情绪/时段/亲密度，不看"这轮在聊什么"；
 *  2. 配文是固定池（「随手拍了一张」「喏」），和刚聊的话题无关。
 *
 * 这个模块只做两件纯函数的事：
 *  - `assessPhotoRelevance`：这轮到底该不该发图（有钩子才发：点名 / 场景命中 / 她刚分享生活）；
 *  - `buildSceneCaption`：按场景给配文（晚霞/雨/猫/咖啡…），比通用池更贴题。
 *
 * 不负责发送、不碰 IO，便于单测与调参。
 */

export type PhotoShareReason = "requested" | "scene_match" | "life_signal" | "no_hook";

export interface PhotoRelevanceInput {
  /** 用户这轮说的话 */
  userText: string;
  /** 她刚发出的那句话 */
  lastReply: string;
  /** 从用户话里识别到的场景标签（detectPhotoSceneTags 的结果） */
  sceneTags: string[];
  /** 选中的照片标签 */
  photoTags: string[];
  /** 用户是否明确要照片 */
  requested: boolean;
}

export interface PhotoRelevance {
  share: boolean;
  reason: PhotoShareReason;
}

/**
 * 「她刚在分享自己生活」的信号：回复里有第一人称 + 具体正在做的事/地点/感受。
 * 目的是让照片像"顺着刚才那句话拍的"，而不是凭空插入。
 */
const LIFE_SIGNAL_PATTERN =
  /(我在|我刚|我正|我这儿|我这边|店里|路上|家里|窗|楼下|刚下班|刚吃完|刚到家|今天|外面|外面.{0,3}(天|雨|雪)|好累|挺累|有点闷|发呆|煮了|做了个|买了|路过|在(?:煮|写|做|改|练|收|洗|买|跑|看|吃|准备|忙|开会|加班)|加班|赶工|收拾)/;

/** 纯问句（"你在干嘛"这种）不算分享钩子——她回一句"在发呆"再配图才自然 */
const PURE_QUESTION_PATTERN = /^[^。！？!?\n]{0,12}[？?]$/;

export function assessPhotoRelevance(input: PhotoRelevanceInput): PhotoRelevance {
  // 1) 他明确要 → 一定发（亲密度/冷却仍由上游控制）
  if (input.requested) return { share: true, reason: "requested" };

  // 2) 场景命中 → 最相关（他说晚霞，就发晚霞）
  const photoTags = new Set(input.photoTags);
  if (input.sceneTags.some((tag) => photoTags.has(tag))) {
    return { share: true, reason: "scene_match" };
  }

  // 3) 她刚分享了生活细节 → 顺手拍一张是自然的
  const reply = (input.lastReply ?? "").replace(/\[CQ:[^\]]+\]/g, " ");
  if (LIFE_SIGNAL_PATTERN.test(reply)) {
    return { share: true, reason: "life_signal" };
  }

  // 4) 其它情况：纯问句、或聊的是抽象话题 → 不发（少而准胜过随机插一张）
  if (PURE_QUESTION_PATTERN.test((input.userText ?? "").trim())) {
    return { share: false, reason: "no_hook" };
  }
  return { share: false, reason: "no_hook" };
}

/** 场景 → 贴题配文（口语、短、像顺着话头说）。 */
const SCENE_CAPTIONS: Record<string, string[]> = {
  sunset: ["天这样了", "刚抬头看到的", "这会儿外面挺好看"],
  rain: ["外面在下雨", "雨还没停", "听着雨声有点困"],
  snow: ["下雪了", "外面白了一片"],
  cafe: ["这杯续命", "坐这儿发会儿呆", "今天这杯有点苦"],
  coffee: ["刚弄了杯", "续命中"],
  cat: ["它也在这儿", "它又赖着不走", "刚被它踩醒"],
  animal: ["它比我还闲", "这小家伙又来了"],
  window: ["窗边光挺好", "外面就这样"],
  plants: ["新长了两片", "忘了浇水"],
  flowers: ["路上顺手带的", "这样放着挺好看"],
  city: ["路过拍的", "这条街晚上更好看"],
  street: ["刚走这条路", "路边这盏灯不错"],
  food: ["刚弄好", "简单吃了点"],
  dinner: ["刚做好", "一个人也挺好"],
  mountain: ["远远看着", "天晴了才看得见"],
  lake: ["水面挺静", "风一吹全是波纹"],
  morning: ["刚醒", "早上这光还行"],
  book: ["刚翻了两页", "周末就这样过", "一页没看进去"],
};

/**
 * 按场景挑配文；没有场景就返回 null（调用方回退到照片自带的 era 配文）。
 * 同一个场景内随机，避免每张都一样。
 */
export function buildSceneCaption(
  sceneTags: string[] | undefined,
  random: () => number = Math.random,
): string | null {
  return buildSceneCaptionWithTag(sceneTags, random)?.caption ?? null;
}

/**
 * 同上，但把「配文来自哪个标签」也返回（v0.9.12）。
 * 调用方用它校验「这张图真的有这个场景」——避免把「天这样了」盖在一张咖啡杯上。
 */
export function buildSceneCaptionWithTag(
  sceneTags: string[] | undefined,
  random: () => number = Math.random,
): { caption: string; tag: string } | null {
  for (const tag of sceneTags ?? []) {
    const pool = SCENE_CAPTIONS[tag];
    if (pool && pool.length > 0) {
      return { caption: pool[Math.floor(random() * pool.length)] ?? pool[0]!, tag };
    }
  }
  return null;
}
