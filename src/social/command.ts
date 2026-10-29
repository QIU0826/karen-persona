/**
 * `/social` 治理命令：状态 / 开关 / 模式 / 待审批 / 审批 / 拒绝 / 撤销 / 手动跑一次。
 * 返回要发送的文本（null = 不是 /social 命令），由 bridge/CLI 负责发送。
 */
import { loadSocialRuntime, type SocialRuntimeState } from "./runtime.js";
import { listPending } from "./store.js";
import type { ExecuteSocialOutcome } from "./executor.js";
import type { SocialTickResult } from "./runner.js";
import type { SocialActionRecord, SocialConfig, SocialMode } from "./types.js";

export interface SocialCommandDeps {
  config: SocialConfig;
  runtime?: SocialRuntimeState;
  /** 当前账号（只读展示；不传则显示未连接） */
  account?: { loggedIn: boolean; uid?: number; uname?: string; fingerprint?: string } | null;
  setMode(mode: SocialMode): SocialConfig;
  approve(id: number): Promise<ExecuteSocialOutcome>;
  reject(id: number): { ok: boolean; reason: string };
  undo(id: number): Promise<ExecuteSocialOutcome>;
  postDynamic?(content: string): Promise<ExecuteSocialOutcome>;
  pending?(limit?: number): SocialActionRecord[];
  runTick?(): Promise<SocialTickResult>;
  now?: number;
}

const MODES: SocialMode[] = ["off", "observe", "approve", "auto", "high"];

function modeText(mode: SocialMode): string {
  return {
    off: "off（全部关闭）",
    observe: "observe（只看不写）",
    approve: "approve（全部先审批）",
    auto: "auto（低风险自动，高风险审批）",
    high: "high（高权限自动）",
  }[mode];
}

function actionLabel(action: string): string {
  return {
    comment: "评论",
    reply: "回复",
    dynamic: "动态",
    like: "点赞",
    favorite: "收藏",
    coin: "投币",
    follow: "关注",
    share: "转发",
  }[action] ?? action;
}

function preview(text: string, n = 30): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function buildSocialStatus(deps: SocialCommandDeps): string {
  const runtime = deps.runtime ?? loadSocialRuntime();
  const now = deps.now ?? Date.now();
  const pending = deps.pending ? deps.pending(20) : listPending({ limit: 20, nowMs: now });
  const lines: string[] = ["【她的网上生活】"];
  lines.push(`模式：${modeText(deps.config.mode)}`);
  lines.push(`Dry-run：${deps.config.dryRun ? "开（只预览，不真实写）" : "关（会真实发）"}`);
  if (deps.account) {
    lines.push(deps.account.loggedIn
      ? `账号：已登录${deps.account.uname ? ` @${deps.account.uname}` : ""}${deps.account.uid ? `（uid ${deps.account.uid}）` : ""}`
      : "账号：未登录/已失效（只读继续，写操作暂停）");
  } else {
    lines.push("账号：未连接（先配置 B 站 Cookie 才能写）");
  }
  const day = new Date(now).toLocaleDateString("en-CA");
  lines.push(`今日预算上限：评论 ${deps.config.caps.commentsPerDay} · 动态 ${deps.config.caps.dynamicsPerDay} · 点赞 ${deps.config.caps.likesPerDay} · 总 ${deps.config.caps.totalPerDay}`);
  lines.push(`待审批：${pending.length} 条${pending.length ? "（/social pending）" : ""}`);
  if (runtime.circuitOpenUntil && runtime.circuitOpenUntil > now) {
    lines.push(`⚠ 风控冷却到 ${fmtTime(runtime.circuitOpenUntil)}（${runtime.lastError ?? "risk_control"}）`);
  }
  lines.push(`日期：${day}`);
  lines.push("操作：/social on|off|mode observe|approve|auto|high|pending|approve <id>|reject <id>|undo <id>|run");
  return lines.join("\n");
}

export function buildPendingText(actions: SocialActionRecord[]): string {
  if (actions.length === 0) return "没有待审批的社交动作。";
  const lines = ["【待审批的社交动作】"];
  for (const a of actions.slice(0, 10)) {
    const target = a.target.title ? `「${preview(a.target.title, 20)}」` : a.target.targetId;
    lines.push(`#${a.id} ${actionLabel(a.action)} ${target} · ${preview(a.content, 40)}`);
  }
  lines.push("回复 /social approve <id> 或 /social reject <id>");
  return lines.join("\n");
}

function helpText(): string {
  return [
    "【/social 用法】",
    "/social — 状态",
    "/social on|off — 打开/关闭写操作",
    "/social mode observe|approve|auto|high — 切换模式",
    "/social pending — 看待审批",
    "/social approve <id> / reject <id> — 审批",
    "/social undo <id> — 撤销已发评论/动态（平台支持时）",
    "/social run — 手动跑一次自主 tick（仍受预算/安全/模式约束）",
    "/social post <正文> — 手动发一条动态（主人显式命令，仍过安全闸门；dry-run 下只预览）",
  ].join("\n");
}

/** 处理 `/social ...`；不是该命令返回 null。 */
export async function handleSocialCommand(text: string, deps: SocialCommandDeps): Promise<string | null> {
  const trimmed = text.trim();
  const m = /^\/social(?:\s+(.*))?$/i.exec(trimmed);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  const [sub, ...args] = rest.split(/\s+/).filter(Boolean);
  const cmd = (sub ?? "status").toLowerCase();

  if (cmd === "help") return helpText();
  if (cmd === "status" || cmd === "") return buildSocialStatus(deps);

  if (cmd === "on") {
    const cfg = deps.setMode("approve");
    return `已打开社会化写操作：${modeText(cfg.mode)}。${cfg.dryRun ? "当前 dry-run 开着，不会真实发布；确认后设 KAREN_SOCIAL_DRY_RUN=off。" : ""}`;
  }
  if (cmd === "off") {
    const cfg = deps.setMode("off");
    return `已关闭社会化写操作：${modeText(cfg.mode)}。`;
  }
  if (cmd === "mode") {
    const target = (args[0] ?? "").toLowerCase() as SocialMode;
    if (!MODES.includes(target)) return `模式无效：${args[0] ?? "（空）"}。可选 ${MODES.join(" / ")}。`;
    if (target === "high") {
      return "high 需要你明确确认后改 .env KAREN_SOCIAL=high（或在设置里二次确认）；这里先不直接切换。";
    }
    const cfg = deps.setMode(target);
    return `模式已切换：${modeText(cfg.mode)}。`;
  }
  if (cmd === "pending") {
    const actions = deps.pending ? deps.pending(20) : listPending({ limit: 20, nowMs: deps.now ?? Date.now() });
    return buildPendingText(actions);
  }
  if (cmd === "approve" || cmd === "reject" || cmd === "undo") {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id <= 0) return `用法：/social ${cmd} <id>`;
    if (cmd === "approve") {
      const out = await deps.approve(id);
      return `${out.reason}${out.result?.externalId ? `（外部 id：${out.result.externalId}）` : ""}`;
    }
    if (cmd === "reject") {
      const out = deps.reject(id);
      return out.reason;
    }
    const out = await deps.undo(id);
    return out.reason;
  }
  if (cmd === "post") {
    if (!deps.postDynamic) return "当前没有接入手动发动态。";
    const content = rest.replace(/^post\s*/i, "").trim();
    if (!content) return "用法：/social post <动态正文>";
    const out = await deps.postDynamic(content);
    return `${out.reason}${out.result?.externalId ? `（外部 id：${out.result.externalId}）` : ""}`;
  }
  if (cmd === "run") {
    if (!deps.runTick) return "当前没有接入自主 tick。";
    const result = await deps.runTick();
    const action = result.pending ?? result.sent ?? result.action;
    return [
      `手动 tick：${result.reason}`,
      ...(action ? [`#${action.id} ${actionLabel(action.action)} ${preview(action.content, 40)}`] : []),
      ...result.logs.slice(-3),
    ].join("\n");
  }
  return helpText();
}
