/**
 * 跨轮/跨天一致性巡检（P1-5，2026-10-23）。
 *
 * 不做「像不像人」的主观评分，只查可确定判定的硬矛盾：
 * - 30 分钟内先说很忙/有客人，又说不忙/还好；
 * - 30 分钟内一会儿说在店里、一会儿说在家/床上；
 * 以及未兑现承诺数量（从承诺账本读，由 CLI 传入）。
 *
 * 纯函数；真实回放用 scripts/consistency-eval.ts 读会话 JSON。
 */
export interface ConsistencyMessage {
  role: string;
  content: string;
  timestamp?: number;
}

export type ConsistencyIssueKind = "busy_idle" | "shop_home";

export interface ConsistencyIssue {
  kind: ConsistencyIssueKind;
  at: number;
  gapMinutes: number;
}

export interface ConsistencyReport {
  checkedMessages: number;
  issues: ConsistencyIssue[];
  /** 0–100；每个硬矛盾扣 20 分。 */
  score: number;
}

const BUSY_RE = /(我[^。！？\n]{0,6}忙|忙(?:呢|着|完|死|不过)|客人|一桌|排队|走不开|手忙脚乱|没空)/;
const IDLE_RE = /(还好|不忙|闲下来|空了|没事|不忙了)/;
const SHOP_RE = /(在店|店里|吧台|擦杯子|做咖啡|拉花|收银)/;
const HOME_RE = /(在家|床上|沙发|家里)/;

function withinWindow(a: number, b: number, windowMs: number): boolean {
  return Math.abs(a - b) <= windowMs;
}

/** 扫描她自己的消息，找 30 分钟内相互矛盾的处境声明。 */
export function evaluateConsistency(
  messages: ConsistencyMessage[],
  options: { windowMinutes?: number } = {},
): ConsistencyReport {
  const windowMs = Math.max(5, options.windowMinutes ?? 30) * 60_000;
  const assistant = messages
    .filter(
      (m): m is ConsistencyMessage & { timestamp: number } =>
        m.role === "assistant" && typeof m.timestamp === "number",
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const issues: ConsistencyIssue[] = [];
  let busyAt: { at: number } | null = null;
  let idleAt: { at: number } | null = null;
  let shopAt: { at: number } | null = null;
  let homeAt: { at: number } | null = null;

  for (const message of assistant) {
    const at = message.timestamp;
    const text = message.content ?? "";
    if (BUSY_RE.test(text)) busyAt = { at };
    if (IDLE_RE.test(text)) idleAt = { at };
    if (SHOP_RE.test(text)) shopAt = { at };
    if (HOME_RE.test(text)) homeAt = { at };

    if (busyAt && idleAt && withinWindow(busyAt.at, idleAt.at, windowMs) && busyAt.at !== idleAt.at) {
      issues.push({
        kind: "busy_idle",
        at: Math.max(busyAt.at, idleAt.at),
        gapMinutes: Math.round(Math.abs(busyAt.at - idleAt.at) / 60_000),
      });
      busyAt = null;
      idleAt = null;
    }
    if (shopAt && homeAt && withinWindow(shopAt.at, homeAt.at, windowMs) && shopAt.at !== homeAt.at) {
      issues.push({
        kind: "shop_home",
        at: Math.max(shopAt.at, homeAt.at),
        gapMinutes: Math.round(Math.abs(shopAt.at - homeAt.at) / 60_000),
      });
      shopAt = null;
      homeAt = null;
    }
  }

  const unique = issues.filter(
    (issue, index, list) =>
      list.findIndex(
        (other) =>
          other.kind === issue.kind &&
          Math.abs(other.at - issue.at) < 60_000,
      ) === index,
  );

  return {
    checkedMessages: assistant.length,
    issues: unique,
    score: Math.max(0, 100 - unique.length * 20),
  };
}
