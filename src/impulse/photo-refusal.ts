/**
 * 「她这轮文字里是不是拒绝了发照片」（v0.9.19）。
 *
 * 背景：给模型加了「不想发就直说」之后，评测里出现她说「不要 我在上班呢」「我不怎么爱拍照的」，
 * 但程序因为是"用户点名要照片"仍会把照片发出去——**嘴和手不一致**，比模板化更像机器人。
 *
 * 规则：用户点名要照片时，如果她的文字明确拒绝/推脱，就尊重她的话，这一轮不发照片。
 * 只认明确的拒绝句式，避免把「不要担心，我拍给你」误判。
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /^\s*(不要|不用|不必|算了)/,
  /^\s*(不拍|不发|不给|不想|不爱|不要拍)/,
  /^\s*(改天|下次|晚点|待会|等会|以后)(再)?(给|拍|发)?/,
  /(不方便|上班呢|在忙|忙着|没空|腾不出手)/,
  /(不(怎么)?爱拍照|不喜欢拍照|不想拍|不拍照)/,
  /^(不了|不行|不要啦|不嘛)/,
];

/** 明确的"答应/会发"信号：出现则即使有「不」字也不视为拒绝。 */
const ACCEPT_HINTS = /(等等|等一下|马上|这就|我给你|拍给你|发你|看这个|给你看)/;

export function replyRefusesPhoto(replyText: string | null | undefined): boolean {
  const text = (replyText ?? "").trim();
  if (!text) return false;
  if (ACCEPT_HINTS.test(text)) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}
