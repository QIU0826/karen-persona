/**
 * 「用户明确索要多媒体」意图识别。
 *
 * 为什么单独做这一层：
 * - 15 轮真实验证（mock OneBot + 真实 DeepSeek）里，用户连续 3 次说
 *   「拍张照片看看」/「你那边现在啥样，拍张照片看看」/「发个表情包给我看看」，
 *   她都只是嘴上接话、什么都没发 —— 真人朋友被点名要照片时，大概率会顺手拍一张。
 * - 这不属于「情感识别」（项目红线：禁止用关键词检测情绪），只是**行为触发**：
 *   用户点名要什么，就提高对应动作的概率，语气和内容仍由模型自己决定。
 *
 * 设计原则：
 * - 只做「显式请求」判定：宁漏不误（避免她莫名其妙一直发图）；
 * - 纯函数、无 IO，便于单测；
 * - 阈值/概率在调用方（orchestrator / bridge）决定，这里只回答「用户有没有要」。
 */

export interface MediaRequest {
  /** 明确要照片（拍张/发张图/自拍/看看你那边…） */
  photo: boolean;
  /** 明确要表情包/表情 */
  sticker: boolean;
  /** 明确要语音（发条语音/说句话听听/你的声音…） */
  voice: boolean;
}

/** 明确索要照片的说法（避免把「相机」「图片」这类普通词算进来） */
const PHOTO_PATTERNS: readonly RegExp[] = [
  /(拍|发|来|给)[^。！？\n]{0,10}(照片|相片|图|自拍|图片)/,
  /(照片|自拍|图|图图)[^。！？\n]{0,4}(看看|给我看|发我|有没有|瞧瞧)/,
  /看看你(那边|现在|店里|家|长啥样|什么样)?/,
  // 只认「样子类」问法；「你那边天气怎么样」不算要照片
  /你(那边|现在|店里|家)[^。！？\n]{0,6}(啥样|什么样|什么样子|长啥样)/,
  /(自拍|拍张|拍一张|拍个|发张图|发个图|来张图)/,
  // 「发张你那边晚霞看看」「随手拍两张」这类没有「照片/图」字样的说法
  /(发|拍|来)(一|两|几|三)?张/,
];

/** 明确索要表情包/表情 */
const STICKER_PATTERNS: readonly RegExp[] = [
  /(发|来|给)[^。！？\n]{0,4}(表情包|表情|贴纸)/,
  /(表情包|斗图|贴纸)[^。！？\n]{0,4}(看看|给我看|发我|来一个|有没有)/,
  /发个表情/,
  /斗图/,
];

/** 明确索要语音 */
const VOICE_PATTERNS: readonly RegExp[] = [
  /(发|来|给)[^。！？\n]{0,4}(语音|音条|声音|一段话)/,
  /(语音|声音)[^。！？\n]{0,4}(听听|听一下|发我|来一条|有没有)/,
  /说句话[^。！？\n]{0,4}(听听|听一下|呗|嘛)?/,
  /(听听|听一下|听下)[^。！？\n]{0,6}(声音|语音|你说的)/,
  /(用|发)语音/,
];

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * 识别用户是否明确索要照片/表情包/语音。
 * 空文本/非字符串返回全 false，绝不抛异常。
 */
export function detectMediaRequest(text: string | null | undefined): MediaRequest {
  const raw = typeof text === "string" ? text : "";
  const normalized = raw.replace(/\[CQ:[^\]]+\]/g, " ").trim();
  if (normalized.length === 0) return { photo: false, sticker: false, voice: false };
  return {
    photo: matches(PHOTO_PATTERNS, normalized),
    sticker: matches(STICKER_PATTERNS, normalized),
    voice: matches(VOICE_PATTERNS, normalized),
  };
}

/** 是否索要了任意一种多媒体（调用方用于「本轮要不要强一点」） */
export function hasAnyMediaRequest(request: MediaRequest): boolean {
  return request.photo || request.sticker || request.voice;
}

/**
 * 把「用户明确要东西」翻译成一句给模型的内部提示（不是给用户看的文案）。
 *
 * 解决的问题：真机/验证里她常说「等我哪天值班到傍晚」「拍出来也没啥好看的」，
 * 而程序这边其实会把照片/表情包/语音发出去 —— 嘴上说改天、手上却发了，读起来割裂。
 * 这段提示只要求「语气和动作对齐」：方便就现在发，不方便就直说，别空口承诺。
 */
export function buildMediaRequestNote(request: MediaRequest): string {
  const lines: string[] = [];
  if (request.photo) {
    lines.push("他现在想看你拍的照片：方便就现在拍一张发过去（系统会附上照片），别推说改天/等我哪天；不方便就直说。");
  }
  if (request.sticker) {
    lines.push("他想要个表情包：可以顺手丢一个过去（系统会发），别只说「我有」却不给。");
  }
  if (request.voice) {
    lines.push("他想听你说话：可以发一条短语音过去（系统会发），不用刻意解释「我要发语音了」。");
  }
  if (lines.length === 0) return "";
  return `\n[本条内部提示，不要照抄] ${lines.join(" ")}`;
}

/** 用户提到的场景 → 本地图库标签（用于「要晚霞别发花/山」这类内容错位修复） */
const SCENE_TAG_MAP: ReadonlyArray<{ re: RegExp; tags: string[] }> = [
  { re: /(晚霞|日落|夕阳|黄昏|粉色的天)/, tags: ["sunset"] },
  { re: /(下雪|雪|冬天|冷得)/, tags: ["snow", "winter"] },
  { re: /(咖啡|拿铁|美式|店里|吧台|杯子)/, tags: ["cafe", "coffee", "warm"] },
  { re: /(猫|狗|动物|五花|年糕)/, tags: ["animal", "cat"] },
  { re: /(山|爬山|旅行|风景|天空)/, tags: ["mountain", "travel", "sky"] },
  { re: /(花|植物|绿植|阳台)/, tags: ["flowers", "plants"] },
  { re: /(下雨|雨天|雨里|下雨了|淋雨)/, tags: ["rain", "window"] },
  { re: /(城市|街头|街上|下班路|路边)/, tags: ["city", "street"] },
  { re: /(晚饭|吃饭|餐厅|好吃的|宵夜)/, tags: ["food", "dinner"] },
  { re: /(早上|早晨|清晨)/, tags: ["morning"] },
  { re: /(湖水|湖边|码头|河边)/, tags: ["lake", "pier"] },
];

/**
 * 从用户这句话里推断「他想看什么」，返回图库标签（可能为空）。
 * 只做内容匹配，不改变发不发的决策。
 */
export function detectPhotoSceneTags(text: string | null | undefined): string[] {
  const raw = typeof text === "string" ? text : "";
  const normalized = raw.replace(/\[CQ:[^\]]+\]/g, " ").trim();
  if (!normalized) return [];
  const tags: string[] = [];
  for (const entry of SCENE_TAG_MAP) {
    if (entry.re.test(normalized)) {
      for (const tag of entry.tags) if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}
