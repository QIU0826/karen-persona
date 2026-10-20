/**
 * 本地 Web 控制台页面（步骤 5，只读单页）。
 *
 * 设计要点：
 * - **零新依赖**：服务端 HTML + 内联 CSS/JS（node:http 直接吐页面），无构建步骤；
 * - **单页四视图**：聊天 / 记忆 / 关系 / 状态（含健康与成本），移动端适配、深色风格；
 * - **转义**：所有来自用户/记忆/LLM 的文本都经过 escapeHtml（服务端首屏）或页面内
 *   esc()（刷新时）转义，禁止 XSS；页面本身不含任何外域脚本/样式（配合 server.ts 的 CSP）。
 * - **刷新**：内联 JS 每 5 秒拉一次 API 刷新，可暂停；暂停后仍可手动点击「继续刷新」。
 * - 服务端首屏把数据直接渲染进 HTML（无 JS 也能看），JS 只负责后续刷新与搜索。
 */
import type {
  CostData,
  HealthData,
  MemoryHit,
  MemoryHitProbeData,
  MemoryItem,
  MemoryListData,
  OverviewData,
  SessionData,
  SessionMessage,
  TimelineData,
  TimelineEvent,
  TimelineMilestone,
  UserFactItem,
  UserFactsData,
  WebPersonaContext,
} from "./data.js";
import { FACT_CATEGORY_LABELS, FACT_CATEGORY_ORDER, MEMORY_PROBE_SAMPLE_QUERY } from "./data.js";
import { formatLocalTime } from "../evolution/journal-view.js";

/** HTML 转义（服务端首屏渲染用）。 */
export function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 把对象序列化成可安全内联进 `<script>` 的 JSON：
 * 把 `<` / `>` / `&` / U+2028 / U+2029 全部转义，防止 `</script>` 提前闭合。
 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface DashboardData {
  overview: OverviewData;
  session: SessionData;
  memory: MemoryListData;
  /** 用户事实（只读 user_facts，按分类分组展示）。 */
  facts: UserFactsData;
  /** 记忆命中回放首屏（示例 query 的同步检索结果）。 */
  probe: MemoryHitProbeData;
  timeline: TimelineData;
  health: HealthData;
  cost: CostData;
}

// ── 数值 / 文本格式化（服务端）──────────────────

const HER_NAME_FALLBACK = "她";

function num(value: unknown, digits: number = 2): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return n.toFixed(digits);
}

function pct(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

/** 截断长文本（回放列表只展示摘要，完整内容留在记忆列表里）。 */
function truncateText(value: unknown, max: number = 160): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function deltaText(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  return (n > 0 ? "+" : "") + n.toFixed(3);
}

function fmtCny(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n === 0) return "¥0";
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(2)}`;
}

function fmtInt(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return String(n);
}

function fmtTokens(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return n.toLocaleString("en-US");
}

function fmtUptime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
  if (total < 86400) return `${Math.floor(total / 3600)} 小时`;
  return `${Math.floor(total / 86400)} 天`;
}

function time(value: string | null | undefined): string {
  return formatLocalTime(value ?? null);
}

function personaName(persona: WebPersonaContext | null | undefined): string {
  const name = persona?.name?.trim();
  return name ? name : HER_NAME_FALLBACK;
}

// ── 各视图（服务端首屏）────────────────────────

function renderChat(session: SessionData, herName: string): string {
  const rows =
    session.messages.length === 0
      ? `<p class="empty">还没有聊天记录。等她和你说上话，这里会热闹起来。</p>`
      : session.messages
          .map((message: SessionMessage) => {
            const isUser = message.role === "user";
            return (
              `<div class="msg ${isUser ? "user" : "assistant"}">` +
              `<div class="bubble">${escapeHtml(message.content)}</div>` +
              `<div class="meta">${isUser ? "你" : escapeHtml(herName)} · ${escapeHtml(time(message.at))}</div>` +
              `</div>`
            );
          })
          .join("");
  return (
    `<section class="panel active" id="panel-chat" data-panel="chat">` +
    `<div class="card">` +
    `<div class="card-head"><h2>聊天</h2><span class="muted small" id="chat-stats">` +
    `共 ${fmtInt(session.total)} 条 · 最近活跃 ${escapeHtml(time(session.last_active_at))}</span></div>` +
    `<div class="chat-list" id="chat-list">${rows}</div>` +
    `</div>` +
    `</section>`
  );
}

function renderMemoryItems(items: MemoryItem[]): string {
  if (items.length === 0) return `<p class="empty">还没有记忆。等她经历过一些事情，这里会慢慢长出来。</p>`;
  return items
    .map(
      (item: MemoryItem) =>
        `<div class="item">` +
        `<div class="item-head">` +
        `<span class="chip">${escapeHtml(item.source_label)}</span>` +
        `<span class="muted small">${escapeHtml(time(item.created_at))}</span>` +
        `<span class="muted small">强度 ${pct(item.strength)}%</span>` +
        `</div>` +
        `<div class="item-body">${escapeHtml(item.content)}</div>` +
        `</div>`,
    )
    .join("");
}

interface FactGroup {
  category: string;
  label: string;
  items: UserFactItem[];
}

/** 按 category 分组（已知分类按固定顺序，未知分类排在「其他」之后）。 */
function groupFactsByCategory(items: UserFactItem[]): FactGroup[] {
  const buckets = new Map<string, UserFactItem[]>();
  for (const item of items) {
    const category = item.category in FACT_CATEGORY_LABELS ? item.category : "other";
    const bucket = buckets.get(category);
    if (bucket) bucket.push(item);
    else buckets.set(category, [item]);
  }
  const known = FACT_CATEGORY_ORDER.filter((category) => buckets.has(category));
  const unknown = [...buckets.keys()]
    .filter((category) => !(category in FACT_CATEGORY_LABELS))
    .sort();
  return [...known, ...unknown].map((category) => ({
    category,
    label: FACT_CATEGORY_LABELS[category] ?? FACT_CATEGORY_LABELS.other,
    items: buckets.get(category) ?? [],
  }));
}

function renderFactRows(items: UserFactItem[]): string {
  return items
    .map(
      (item: UserFactItem) =>
        `<div class="fact-row">` +
        `<span class="fact-key">${escapeHtml(item.key)}</span>` +
        `<span class="fact-value">${escapeHtml(item.value)}</span>` +
        `<span class="muted small fact-time">${escapeHtml(time(item.updatedAt))}</span>` +
        `</div>`,
    )
    .join("");
}

/** 用户事实卡片：按分类分组展示 key / value / updated_at，空态给中文说明。 */
function renderFacts(facts: UserFactsData): string {
  const groups = groupFactsByCategory(facts.items);
  const body =
    facts.items.length === 0
      ? `<p class="empty">还没有关于你的用户事实。多聊几句，等她记住了你的名字、工作或喜好，这里会慢慢长出来。</p>`
      : groups
          .map(
            (group: FactGroup) =>
              `<h3>${escapeHtml(group.label)}` +
              `<span class="muted small fact-count">${fmtInt(group.items.length)} 条</span></h3>` +
              renderFactRows(group.items),
          )
          .join("");
  return (
    `<div class="card" id="facts-card">` +
    `<div class="card-head"><h2>用户事实</h2><span class="muted small" id="facts-status">` +
    `${fmtInt(facts.count)} 条 · ${escapeHtml(facts.owner)}</span></div>` +
    `<div id="facts-list">${body}</div>` +
    `</div>`
  );
}

function confidenceClass(confidence: MemoryHit["confidence"]): string {
  if (confidence === "high") return "chip ok";
  if (confidence === "medium") return "chip warn";
  return "chip";
}

function renderProbeHits(hits: MemoryHit[]): string {
  if (hits.length === 0) {
    return `<p class="empty">没有命中任何记忆。换一个关键词试试——回放只读取本地记忆，不会修改数据。</p>`;
  }
  return hits
    .map(
      (hit: MemoryHit) =>
        `<div class="item">` +
        `<div class="item-head">` +
        `<span class="${confidenceClass(hit.confidence)}">${escapeHtml(hit.confidence_label)}</span>` +
        `<span class="chip">${escapeHtml(hit.source_label)}</span>` +
        (hit.time_label ? `<span class="chip">${escapeHtml(hit.time_label)}</span>` : "") +
        `<span class="muted small">相关度 ${pct(hit.relevance)}%</span>` +
        `</div>` +
        `<div class="item-body">${escapeHtml(truncateText(hit.content))}</div>` +
        `<div class="bar probe-bar"><i style="width:${pct(hit.relevance)}%"></i></div>` +
        `</div>`,
    )
    .join("");
}

/**
 * 记忆命中回放卡片：输入关键词 → /api/memory-probe → 展示命中内容/置信度/相关度。
 * 首屏先渲染示例 query 的结果（服务端已查好），之后由内联 JS 局部刷新。
 */
function renderMemoryProbe(probe: MemoryHitProbeData): string {
  const query = probe.query || MEMORY_PROBE_SAMPLE_QUERY;
  const status =
    probe.hits.length > 0
      ? `回放「${query}」命中 ${fmtInt(probe.hits.length)} 条`
      : `回放「${query}」没有命中记忆`;
  return (
    `<div class="card" id="memory-probe-card">` +
    `<div class="card-head"><h2>记忆命中回放</h2>` +
    `<span class="muted small" id="probe-status">${escapeHtml(status)}</span></div>` +
    `<p class="muted small">看看这句话会让她想起哪些记忆——只读回放，不会写入记忆。</p>` +
    `<form class="search-row" id="probe-form">` +
    `<input id="probe-query" type="search" value="${escapeHtml(query)}" ` +
    `placeholder="输入关键词，例如：下雨 / 咖啡 / 加班" autocomplete="off" maxlength="200">` +
    `<button class="btn primary" type="submit">回放</button>` +
    `</form>` +
    `<div class="item-list" id="probe-list">${renderProbeHits(probe.hits)}</div>` +
    `</div>`
  );
}

function renderMemory(
  memory: MemoryListData,
  facts: UserFactsData,
  probe: MemoryHitProbeData,
): string {
  return (
    `<section class="panel" id="panel-memory" data-panel="memory">` +
    renderFacts(facts) +
    `<div class="card">` +
    `<div class="card-head"><h2>记忆</h2><span class="muted small" id="memory-status">` +
    `共 ${fmtInt(memory.total)} 条记忆（显示最近 ${fmtInt(memory.items.length)} 条）</span></div>` +
    `<form class="search-row" id="memory-form">` +
    `<input id="memory-query" type="search" placeholder="搜索记忆，例如：下雨 / 咖啡" autocomplete="off" maxlength="120">` +
    `<button class="btn primary" type="submit">搜索</button>` +
    `</form>` +
    `<div class="item-list" id="memory-list">${renderMemoryItems(memory.items)}</div>` +
    `</div>` +
    renderMemoryProbe(probe) +
    `</section>`
  );
}

function renderMilestones(milestones: TimelineMilestone[]): string {
  if (milestones.length === 0) return `<p class="empty">还没有里程碑。等你们再熟一点，这里会记下第一个节点。</p>`;
  return milestones
    .map(
      (milestone: TimelineMilestone) =>
        `<div class="timeline-row">` +
        `<span class="timeline-dot"></span>` +
        `<span class="timeline-body">${escapeHtml(milestone.title)}` +
        `<span class="muted small">（${num(milestone.closeness)}/10 · ${escapeHtml(time(milestone.at))}）</span></span>` +
        `</div>`,
    )
    .join("");
}

function renderEvents(events: TimelineEvent[]): string {
  if (events.length === 0) return `<p class="empty">还没有关系变化记录。关系需要一点时间，也需要几次聊到深处的对话。</p>`;
  return events
    .map(
      (event: TimelineEvent) =>
        `<div class="item compact">` +
        `<div class="item-head">` +
        `<span class="chip ${event.delta >= 0 ? "ok" : "warn"}">${escapeHtml(deltaText(event.delta))}</span>` +
        `<span class="muted small">→ ${num(event.closeness)}</span>` +
        `<span class="muted small">${escapeHtml(time(event.at))}</span>` +
        `</div>` +
        `<div class="item-body">${escapeHtml(event.reason)}</div>` +
        `</div>`,
    )
    .join("");
}

// ── 页面骨架 ────────────────────────────────────

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0d0f14; --bg2: #141821; --card: #171c26; --line: #242b39;
  --text: #e7eaf2; --muted: #8b93a7; --accent: #d98e9b; --accent2: #8fbfe0;
  --ok: #7fce9a; --warn: #e6c07b; --err: #e07b7b; --chip: #222a3a;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: radial-gradient(1200px 600px at 20% -10%, #1a2030 0%, var(--bg) 55%) fixed, var(--bg);
  color: var(--text); min-height: 100vh;
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent2); }
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 12px 20px; background: rgba(13, 15, 20, 0.88); border-bottom: 1px solid var(--line);
  backdrop-filter: blur(10px);
}
.brand { display: flex; align-items: baseline; gap: 8px; font-weight: 700; letter-spacing: .3px; }
.brand-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); display: inline-block; }
.brand-sub { color: var(--muted); font-weight: 400; font-size: 12px; }
.topbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.persona { color: var(--accent); font-weight: 600; }
.wrap { max-width: 980px; margin: 0 auto; padding: 16px 16px 48px; }
.tabs { display: flex; gap: 8px; overflow-x: auto; padding: 14px 0 10px; position: sticky; top: 53px; background: linear-gradient(var(--bg) 70%, transparent); z-index: 5; }
.tab {
  flex: 0 0 auto; padding: 8px 16px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--bg2); color: var(--muted); cursor: pointer; font-size: 14px; font-family: inherit;
  transition: .15s; -webkit-tap-highlight-color: transparent;
}
.tab:hover { color: var(--text); border-color: #33405a; }
.tab.active { background: var(--accent); border-color: var(--accent); color: #1a1214; font-weight: 600; }
.panel { display: none; }
.panel.active { display: block; animation: fade .18s ease; }
@keyframes fade { from { opacity: .5; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.card {
  background: linear-gradient(180deg, rgba(255,255,255,.02), transparent), var(--card);
  border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; margin: 12px 0;
}
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
h2 { font-size: 16px; margin: 0; }
h3 { font-size: 13px; margin: 14px 0 8px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.empty { color: var(--muted); margin: 8px 0; }
.chat-list { display: flex; flex-direction: column; gap: 14px; max-height: 62vh; overflow-y: auto; padding: 4px 2px; }
.msg { display: flex; flex-direction: column; gap: 4px; }
.msg.user { align-items: flex-end; }
.msg.assistant { align-items: flex-start; }
.bubble {
  max-width: min(82%, 580px); padding: 10px 14px; border-radius: 16px;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  background: var(--bg2); border: 1px solid var(--line);
}
.msg.user .bubble { background: rgba(217, 142, 155, .16); border-color: rgba(217, 142, 155, .35); border-bottom-right-radius: 6px; }
.msg.assistant .bubble { border-bottom-left-radius: 6px; }
.meta { color: var(--muted); font-size: 12px; }
.search-row { display: flex; gap: 8px; margin: 4px 0 14px; }
.search-row input {
  flex: 1; min-width: 0; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--line);
  background: var(--bg2); color: var(--text); font: inherit; outline: none;
}
.search-row input:focus { border-color: var(--accent); }
.btn {
  padding: 9px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg2);
  color: var(--text); cursor: pointer; font: inherit; transition: .15s;
}
.btn:hover { border-color: #3a4663; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #1a1214; font-weight: 600; }
.btn.paused { border-color: var(--warn); color: var(--warn); }
.item-list { display: flex; flex-direction: column; gap: 10px; max-height: 58vh; overflow-y: auto; }
.item { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
.item.compact { padding: 8px 12px; }
.item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.item-body { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-size: 14.5px; }
.fact-row {
  display: grid; grid-template-columns: minmax(64px, 120px) minmax(0, 1fr) auto;
  gap: 10px; align-items: baseline; padding: 7px 0;
  border-bottom: 1px dashed rgba(255,255,255,.05); font-size: 14px;
}
.fact-row:last-child { border-bottom: 0; }
.fact-key {
  color: var(--accent2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px; word-break: break-all;
}
.fact-value { word-break: break-word; overflow-wrap: anywhere; }
.fact-time { white-space: nowrap; }
.fact-count { margin-left: 8px; text-transform: none; letter-spacing: 0; font-weight: 400; }
.probe-bar { margin: 7px 0 0; max-width: none; height: 5px; }
.chip {
  display: inline-block; padding: 1px 9px; border-radius: 999px; background: var(--chip);
  color: var(--accent2); font-size: 12px; border: 1px solid transparent;
}
.chip.ok { color: var(--ok); }
.chip.warn { color: var(--warn); }
.chip.err { color: var(--err); }
.rel-hero { text-align: center; padding: 24px 18px; }
.rel-score { font-size: 46px; font-weight: 700; line-height: 1.1; letter-spacing: -.02em; }
.rel-score .muted { font-size: 18px; font-weight: 400; }
.rel-label { margin: 4px 0 14px; display: flex; gap: 8px; justify-content: center; align-items: center; flex-wrap: wrap; }
.bar { height: 8px; border-radius: 999px; background: var(--chip); overflow: hidden; max-width: 520px; margin: 0 auto 12px; }
.bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--warn)); }
blockquote { margin: 6px 0 8px; padding: 2px 0 2px 14px; border-left: 3px solid var(--accent); color: var(--text); }
.timeline-row { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; }
.timeline-dot { flex: 0 0 auto; width: 9px; height: 9px; margin-top: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(217,142,155,.16); }
.timeline-body { flex: 1; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0 12px; }
.grid .card { margin: 12px 0; }
.card.wide { grid-column: 1 / -1; }
.stat { font-size: 30px; font-weight: 700; line-height: 1.2; }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px dashed rgba(255,255,255,.05); font-size: 14px; }
.kv:last-child { border-bottom: 0; }
.kv span { color: var(--muted); }
.kv b { font-weight: 500; text-align: right; word-break: break-all; }
.ok-text { color: var(--ok); }
.err-text { color: var(--err); }
.cost-list { display: flex; flex-direction: column; gap: 7px; }
.cost-row { display: grid; grid-template-columns: 42px 1fr 82px 60px; align-items: center; gap: 10px; font-size: 13px; }
.cost-date { color: var(--muted); font-variant-numeric: tabular-nums; }
.cost-bar { height: 7px; background: var(--chip); border-radius: 999px; overflow: hidden; }
.cost-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent2), var(--accent)); border-radius: 999px; }
.cost-val { text-align: right; font-variant-numeric: tabular-nums; }
.footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 26px; }
#conn.offline { color: var(--err); }
#conn.online { color: var(--ok); }
@media (max-width: 720px) {
  .topbar { padding: 10px 14px; }
  .wrap { padding: 10px 12px 40px; }
  .tabs { top: 0; }
  .card { padding: 14px; border-radius: 14px; }
  .rel-score { font-size: 38px; }
  .chat-list { max-height: 58vh; }
  .cost-row { grid-template-columns: 38px 1fr 70px; }
  .cost-row .muted { display: none; }
  .stat { font-size: 26px; }
  .fact-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "key time" "value value"; row-gap: 2px; }
  .fact-key { grid-area: key; }
  .fact-value { grid-area: value; }
  .fact-time { grid-area: time; }
}
`;

const CLIENT_JS = `
(function () {
  "use strict";
  var TOKEN = new URLSearchParams(window.location.search).get("token");
  var BOOT = window.__KAREN_BOOT__ || {};
  var PANELS = ["chat", "memory", "timeline", "status"];
  var REFRESH_MS = 5000;
  var FACT_LABELS = BOOT.fact_labels || { profile: "基本信息", work: "工作", pet: "宠物", relationship: "关系", plan: "最近计划", preference: "偏好", other: "其他" };
  var FACT_ORDER = ["profile", "work", "pet", "relationship", "plan", "preference", "other"];
  var view = { paused: false, memorySearchActive: false, herName: BOOT.persona_name || "她" };

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function two(n) { return (n < 10 ? "0" : "") + n; }
  function fmtTime(iso) {
    if (!iso) return "时间未知";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "时间未知";
    var base = two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
    return d.getFullYear() === new Date().getFullYear() ? base : d.getFullYear() + "-" + base;
  }
  function fmtCny(value) {
    var n = Number(value || 0);
    if (n === 0) return "¥0";
    if (n < 0.01) return "¥" + n.toFixed(4);
    return "¥" + n.toFixed(2);
  }
  function pct(value) {
    var n = Math.round(Number(value || 0) * 100);
    return Math.max(0, Math.min(100, n)) + "%";
  }
  function truncateText(value) {
    var text = String(value === null || value === undefined ? "" : value);
    return text.length > 160 ? text.slice(0, 159) + "…" : text;
  }
  function deltaText(value) {
    var n = Number(value || 0);
    return (n > 0 ? "+" : "") + n.toFixed(3);
  }
  function fmtUptime(seconds) {
    var total = Math.max(0, Math.round(Number(seconds || 0)));
    if (total < 60) return total + " 秒";
    if (total < 3600) return Math.floor(total / 60) + " 分钟";
    if (total < 86400) return Math.floor(total / 3600) + " 小时";
    return Math.floor(total / 86400) + " 天";
  }
  function fmtInt(value) { return String(Math.round(Number(value || 0))); }
  function fmtTokens(value) { return Number(value || 0).toLocaleString("en-US"); }

  function apiUrl(path) {
    if (!TOKEN) return path;
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  }
  function fetchJson(path) {
    return fetch(apiUrl(path), { headers: { "Accept": "application/json" }, cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      });
  }
  function setConn(online) {
    var el = $("conn");
    if (!el) return;
    el.textContent = online ? "在线" : "连接中断";
    el.className = "chip " + (online ? "online" : "offline");
  }
  function setUpdated(iso) {
    var el = $("updated");
    if (el) el.textContent = "更新于 " + fmtTime(iso);
  }
  function showPanel(name) {
    if (PANELS.indexOf(name) < 0) name = "chat";
    for (var i = 0; i < PANELS.length; i++) {
      var key = PANELS[i];
      var panel = $("panel-" + key);
      if (panel) panel.className = "panel" + (key === name ? " active" : "");
      var tab = document.querySelector('.tab[data-view="' + key + '"]');
      if (tab) tab.className = "tab" + (key === name ? " active" : "");
    }
    if (window.history && history.replaceState) history.replaceState(null, "", "#" + name);
  }

  function renderChat(data) {
    if (data.persona && data.persona.name) view.herName = data.persona.name;
    var list = $("chat-list");
    if (data.messages.length === 0) {
      list.innerHTML = '<p class="empty">还没有聊天记录。等她和你说上话，这里会热闹起来。</p>';
    } else {
      list.innerHTML = data.messages.map(function (message) {
        var isUser = message.role === "user";
        return '<div class="msg ' + (isUser ? "user" : "assistant") + '">' +
          '<div class="bubble">' + esc(message.content) + '</div>' +
          '<div class="meta">' + (isUser ? "你" : esc(view.herName)) + " · " + esc(fmtTime(message.at)) + "</div>" +
          "</div>";
      }).join("");
    }
    var stats = $("chat-stats");
    if (stats) stats.textContent = "共 " + fmtInt(data.total) + " 条 · 最近活跃 " + fmtTime(data.last_active_at);
  }

  function memoryItemHtml(item, isSearch) {
    var head;
    if (isSearch) {
      head = '<span class="chip">' + esc(item.source_label) + "</span>" +
        '<span class="muted small">相关度 ' + pct(item.relevance) + "</span>" +
        '<span class="muted small">' + esc(item.confidence_label) + "</span>";
    } else {
      head = '<span class="chip">' + esc(item.source_label) + "</span>" +
        '<span class="muted small">' + esc(fmtTime(item.created_at)) + "</span>" +
        '<span class="muted small">强度 ' + pct(item.strength) + "%</span>";
    }
    return '<div class="item"><div class="item-head">' + head + "</div>" +
      '<div class="item-body">' + esc(item.content) + "</div></div>";
  }
  function renderMemoryList(data) {
    var list = $("memory-list");
    var status = $("memory-status");
    var isSearch = data.mode === "search";
    if (!list) return;
    if (data.items.length === 0) {
      list.innerHTML = '<p class="empty">' + (isSearch ? "没有找到匹配的记忆。" : "还没有记忆。等她经历过一些事情，这里会慢慢长出来。") + "</p>";
    } else {
      list.innerHTML = data.items.map(function (item) { return memoryItemHtml(item, isSearch); }).join("");
    }
    if (status) {
      status.textContent = isSearch
        ? "搜索「" + data.query + "」找到 " + fmtInt(data.items.length) + " 条"
        : "共 " + fmtInt(data.total) + " 条记忆（显示最近 " + fmtInt(data.items.length) + " 条）";
    }
  }

  function renderFacts(data) {
    var list = $("facts-list");
    if (!list) return;
    var items = data.items || [];
    if (items.length === 0) {
      list.innerHTML = '<p class="empty">还没有关于你的用户事实。多聊几句，等她记住了你的名字、工作或喜好，这里会慢慢长出来。</p>';
    } else {
      var buckets = {};
      for (var i = 0; i < items.length; i++) {
        var category = FACT_LABELS[items[i].category] ? items[i].category : "other";
        (buckets[category] = buckets[category] || []).push(items[i]);
      }
      var order = FACT_ORDER.filter(function (key) { return buckets[key]; });
      Object.keys(buckets).sort().forEach(function (key) {
        if (FACT_ORDER.indexOf(key) < 0) order.push(key);
      });
      list.innerHTML = order.map(function (key) {
        var rows = buckets[key].map(function (item) {
          return '<div class="fact-row">' +
            '<span class="fact-key">' + esc(item.key) + "</span>" +
            '<span class="fact-value">' + esc(item.value) + "</span>" +
            '<span class="muted small fact-time">' + esc(fmtTime(item.updatedAt)) + "</span>" +
            "</div>";
        }).join("");
        return "<h3>" + esc(FACT_LABELS[key] || "其他") +
          '<span class="muted small fact-count">' + fmtInt(buckets[key].length) + " 条</span></h3>" + rows;
      }).join("");
    }
    var status = $("facts-status");
    if (status) status.textContent = fmtInt(data.count) + " 条 · " + (data.owner || "");
  }

  function confidenceClass(confidence) {
    if (confidence === "high") return "chip ok";
    if (confidence === "medium") return "chip warn";
    return "chip";
  }

  function probeItemHtml(hit) {
    return '<div class="item"><div class="item-head">' +
      '<span class="' + confidenceClass(hit.confidence) + '">' + esc(hit.confidence_label || "相关") + "</span>" +
      '<span class="chip">' + esc(hit.source_label) + "</span>" +
      (hit.time_label ? '<span class="chip">' + esc(hit.time_label) + "</span>" : "") +
      '<span class="muted small">相关度 ' + pct(hit.relevance) + "</span>" +
      "</div>" +
      '<div class="item-body">' + esc(truncateText(hit.content)) + "</div>" +
      '<div class="bar probe-bar"><i style="width:' + pct(hit.relevance) + '%"></i></div>' +
      "</div>";
  }

  function renderProbe(data) {
    var list = $("probe-list");
    var status = $("probe-status");
    if (!list) return;
    var hits = data.hits || [];
    if (hits.length === 0) {
      list.innerHTML = '<p class="empty">没有命中任何记忆。换一个关键词试试——回放只读取本地记忆，不会修改数据。</p>';
    } else {
      list.innerHTML = hits.map(probeItemHtml).join("");
    }
    if (status) status.textContent = "回放「" + data.query + "」命中 " + fmtInt(hits.length) + " 条";
  }

  function onProbe(event) {
    if (event) event.preventDefault();
    var input = $("probe-query");
    if (!input) return;
    var query = input.value.trim();
    var statusEl = $("probe-status");
    if (!query) {
      if (statusEl) statusEl.textContent = "请输入要回放的关键词。";
      return;
    }
    if (query.length > 200) {
      if (statusEl) statusEl.textContent = "关键词太长（最多 200 字）。";
      return;
    }
    if (statusEl) statusEl.textContent = "回放中…";
    fetchJson("/api/memory-probe?q=" + encodeURIComponent(query) + "&limit=8")
      .then(renderProbe)
      .catch(function () {
        if (statusEl) statusEl.textContent = "回放失败，请稍后重试。";
      });
  }

  function renderTimeline(data) {
    var hero = $("timeline-hero");
    if (hero) {
      var streak = data.interaction_streak > 1 ? '<span class="chip">连续互动 ' + fmtInt(data.interaction_streak) + " 天</span>" : "";
      hero.innerHTML =
        '<div class="card rel-hero">' +
        '<div class="rel-score">' + Number(data.closeness || 0).toFixed(2) + '<span class="muted">/10</span></div>' +
        '<div class="rel-label">' + esc(data.label) + streak + "</div>" +
        '<div class="bar"><i style="width:' + pct((data.closeness || 0) / 10) + '%"></i></div>' +
        '<div class="muted small">' + (data.has_state ? "关系状态已持久化 · 最近保存 " + esc(fmtTime(data.state_saved_at)) : "还没有持久化的关系状态——先和她聊几句，这里会开始记录。") + "</div>" +
        "</div>";
    }
    var viewEl = $("her-view");
    if (viewEl) {
      var hv = data.her_view || {};
      viewEl.innerHTML = hv.current
        ? '<blockquote>「' + esc(hv.current) + "」</blockquote>" +
          '<div class="muted small">' + (hv.updated_at ? "写于 " + esc(fmtTime(hv.updated_at)) + (hv.updated_closeness !== null ? " · 亲密度 " + Number(hv.updated_closeness).toFixed(2) + " 时" : "") : "最初写在人设里的印象，还没再更新过") + "</div>" +
          (hv.previous && hv.previous !== hv.current ? '<div class="muted small">更早的时候她写的是：「' + esc(hv.previous) + "」</div>" : "")
        : '<p class="empty">她还没把对你的看法写下来——也许还太早，也许她还在藏。</p>';
    }
    var milestones = $("timeline-milestones");
    if (milestones) {
      milestones.innerHTML = data.milestones.length === 0
        ? '<p class="empty">还没有里程碑。等你们再熟一点，这里会记下第一个节点。</p>'
        : data.milestones.map(function (milestone) {
            return '<div class="timeline-row"><span class="timeline-dot"></span><span class="timeline-body">' +
              esc(milestone.title) + '<span class="muted small">（' + Number(milestone.closeness || 0).toFixed(2) + "/10 · " + esc(fmtTime(milestone.at)) + "）</span></span></div>";
          }).join("");
    }
    var events = $("timeline-events");
    if (events) {
      events.innerHTML = data.events.length === 0
        ? '<p class="empty">还没有关系变化记录。关系需要一点时间，也需要几次聊到深处的对话。</p>'
        : data.events.map(function (event) {
            return '<div class="item compact"><div class="item-head">' +
              '<span class="chip ' + (event.delta >= 0 ? "ok" : "warn") + '">' + esc(deltaText(event.delta)) + "</span>" +
              '<span class="muted small">→ ' + Number(event.closeness || 0).toFixed(2) + "</span>" +
              '<span class="muted small">' + esc(fmtTime(event.at)) + "</span></div>" +
              '<div class="item-body">' + esc(event.reason) + "</div></div>";
          }).join("");
    }
  }

  function renderStatus(healthData, costData, timeline) {
    var h = healthData.health;
    var emotion = timeline ? timeline.emotion : null;
    var guilt = timeline ? timeline.guilt : null;
    var drift = timeline ? timeline.drift : null;
    var narrative = timeline ? timeline.narrative : null;
    var stateGrid = $("state-grid");
    if (stateGrid) {
      stateGrid.innerHTML =
        '<div class="card"><div class="card-head"><h2>情绪</h2></div>' +
        (emotion
          ? '<div class="stat">' + esc(emotion.label) + '</div><div class="muted small">情绪 ' + Number(emotion.vector || 0).toFixed(2) + " · 波动 " + Number(emotion.arousal || 0).toFixed(2) + " · 基线 " + Number(emotion.baseline || 0).toFixed(2) + "</div>"
          : '<p class="empty">还没有演化状态——先和她聊几句。</p>') + "</div>" +
        '<div class="card"><div class="card-head"><h2>负债</h2></div>' +
        (guilt
          ? '<div class="stat">' + Number(guilt.guilt || 0).toFixed(2) + '</div><div class="muted small">愧疚 ' + Number(guilt.guilt || 0).toFixed(2) + " · 怨气 " + Number(guilt.resentment || 0).toFixed(2) + "</div>"
          : '<p class="empty">还没有记录。</p>') + "</div>" +
        '<div class="card"><div class="card-head"><h2>基线漂移</h2></div>' +
        (drift
          ? '<div class="stat">' + Number(drift.actual || 0).toFixed(3) + '</div><div class="muted small">实际 ' + Number(drift.actual || 0).toFixed(3) + " · 她的自我感知 " + Number(drift.perceived || 0).toFixed(3) + " · 压力 " + Number(drift.pressure || 0).toFixed(2) + '</div><div class="muted small">' + esc(drift.alert || "") + "</div>"
          : '<p class="empty">还没有记录。</p>') + "</div>" +
        '<div class="card"><div class="card-head"><h2>心理阶段</h2></div>' +
        (narrative
          ? '<div class="stat">' + esc(narrative.stage_label) + '</div><div class="muted small">' + esc(narrative.hint) + (narrative.direction_label ? " · " + esc(narrative.direction_label) : "") + "</div>" + (narrative.narrative ? '<blockquote>「' + esc(narrative.narrative) + "」</blockquote>" : "")
          : '<p class="empty">还没有记录。</p>') + "</div>";
    }
    var healthCard = $("health-card");
    if (healthCard) {
      healthCard.innerHTML =
        '<div class="card-head"><h2>运行状态</h2></div>' +
        '<div class="kv"><span>数据库</span><b class="' + (h.db_ok ? "ok-text" : "err-text") + '">' + (h.db_ok ? "正常" : "异常") + "</b></div>" +
        '<div class="kv"><span>WS 连接</span><b>' + fmtInt(h.ws_connections) + "</b></div>" +
        '<div class="kv"><span>待补发</span><b>' + fmtInt(h.pending_replies) + "</b></div>" +
        '<div class="kv"><span>运行时长</span><b>' + esc(fmtUptime(h.uptime_seconds)) + "</b></div>" +
        '<div class="kv"><span>版本</span><b>' + esc(h.version) + "</b></div>" +
        '<div class="kv"><span>最近错误</span><b class="small">' + (h.last_error ? esc(h.last_error) : "无") + "</b></div>";
    }
    var todayCard = $("today-cost-card");
    if (todayCard) {
      todayCard.innerHTML =
        '<div class="card-head"><h2>今日成本</h2></div>' +
        '<div class="stat">' + esc(fmtCny(costData.today.cost_cny)) + "</div>" +
        '<div class="muted small">' + fmtInt(costData.today.calls) + " 次调用 · 输入 " + fmtTokens(costData.today.prompt_tokens) + " tokens（缓存命中 " + fmtTokens(costData.today.cached_tokens) + "）· 输出 " + fmtTokens(costData.today.completion_tokens) + " tokens</div>";
    }
    var weekCard = $("week-cost-card");
    if (weekCard) {
      var week = costData.week;
      var maxCost = 0;
      for (var i = 0; i < week.by_day.length; i++) maxCost = Math.max(maxCost, Number(week.by_day[i].cost_cny || 0));
      if (maxCost <= 0) maxCost = 0.0000001;
      var rows = week.by_day.map(function (day) {
        return '<div class="cost-row"><span class="cost-date">' + esc(String(day.date).slice(5)) + "</span>" +
          '<span class="cost-bar"><i style="width:' + pct(Number(day.cost_cny || 0) / maxCost) + '%"></i></span>' +
          '<span class="cost-val">' + esc(fmtCny(day.cost_cny)) + "</span>" +
          '<span class="muted small">' + fmtInt(day.calls) + " 次</span></div>";
      }).join("");
      var models = week.by_model.length === 0
        ? '<p class="empty">最近 7 天还没有调用记录。</p>'
        : week.by_model.map(function (model) {
            return '<div class="kv"><span>' + esc(model.model) + "</span><b>" + esc(fmtCny(model.cost_cny)) + " · " + fmtInt(model.calls) + " 次</b></div>";
          }).join("");
      weekCard.innerHTML =
        '<div class="card-head"><h2>最近 ' + fmtInt(week.window_days) + ' 天成本</h2><span class="muted small">合计 ' + esc(fmtCny(week.total.cost_cny)) + " · " + fmtInt(week.total.calls) + ' 次调用</span></div>' +
        '<div class="cost-list">' + rows + '</div><h3>按模型</h3>' + models;
    }
  }

  function refresh() {
    var paths = ["/api/overview", "/api/session?limit=30", "/api/memory?limit=30", "/api/timeline", "/api/health", "/api/cost", "/api/facts"];
    return Promise.allSettled(paths.map(fetchJson)).then(function (results) {
      var okCount = results.filter(function (result) { return result.status === "fulfilled"; }).length;
      setConn(okCount > 0);
      function value(index) { return results[index].status === "fulfilled" ? results[index].value : null; }
      var overview = value(0);
      var session = value(1);
      var memory = value(2);
      var timeline = value(3);
      var health = value(4);
      var cost = value(5);
      var facts = value(6);
      if (overview) {
        view.herName = (overview.persona && overview.persona.name) || view.herName;
        var personaEl = $("persona-name");
        if (personaEl) personaEl.textContent = view.herName;
        setUpdated(overview.generated_at);
        var conn = $("conn");
        if (conn) {
          var dbOk = overview.health && overview.health.db_ok;
          if (dbOk === false) { conn.textContent = "数据库异常"; conn.className = "chip err"; }
          else { conn.textContent = "在线"; conn.className = "chip online"; }
        }
      }
      if (facts) renderFacts(facts);
      if (session) renderChat(session);
      if (memory && !view.memorySearchActive) renderMemoryList(memory);
      if (timeline) renderTimeline(timeline);
      if (health && cost) renderStatus(health, cost, timeline);
      return true;
    }).catch(function () {
      setConn(false);
      return false;
    });
  }

  function onMemorySearch(event) {
    if (event) event.preventDefault();
    var input = $("memory-query");
    if (!input) return;
    var query = input.value.trim();
    var statusEl = $("memory-status");
    if (!query) {
      view.memorySearchActive = false;
      fetchJson("/api/memory?limit=30").then(renderMemoryList).catch(function () {
        if (statusEl) statusEl.textContent = "读取记忆失败，请稍后重试。";
      });
      return;
    }
    view.memorySearchActive = true;
    if (statusEl) statusEl.textContent = "搜索中…";
    fetchJson("/api/memory?query=" + encodeURIComponent(query) + "&limit=10")
      .then(renderMemoryList)
      .catch(function () {
        if (statusEl) statusEl.textContent = "搜索失败，请稍后重试。";
      });
  }

  function bind() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (event) {
        showPanel(event.currentTarget.getAttribute("data-view"));
      });
    }
    var form = $("memory-form");
    if (form) form.addEventListener("submit", onMemorySearch);
    var probeForm = $("probe-form");
    if (probeForm) probeForm.addEventListener("submit", onProbe);
    var toggle = $("refresh-toggle");
    if (toggle) {
      toggle.addEventListener("click", function () {
        view.paused = !view.paused;
        toggle.textContent = view.paused ? "继续刷新" : "暂停刷新";
        toggle.className = "btn" + (view.paused ? " paused" : "");
        if (!view.paused) refresh();
      });
    }
    showPanel((window.location.hash || "#chat").replace("#", ""));
    refresh();
    window.setInterval(function () {
      if (!view.paused && !document.hidden) refresh();
    }, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
`;

// ── 页面 ────────────────────────────────────────

/** 渲染整个控制台页面（服务端首屏 + 内联样式/脚本）。 */
export function renderDashboard(data: DashboardData): string {
  const { overview, session, memory, facts, probe, timeline, health, cost } = data;
  const herName = personaName(overview.persona);
  const boot = {
    generated_at: overview.generated_at,
    persona_name: herName,
    fact_labels: FACT_CATEGORY_LABELS,
  };
  return (
    `<!DOCTYPE html>` +
    `<html lang="zh-CN">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="dark">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>Karen · 本地控制台</title>` +
    `<style>${CSS}</style>` +
    `</head>` +
    `<body>` +
    `<header class="topbar">` +
    `<div class="brand"><span class="brand-dot"></span><span class="brand-name">Karen</span><span class="brand-sub">本地控制台 · 只读</span></div>` +
    `<div class="topbar-right">` +
    `<span class="persona" id="persona-name">${escapeHtml(herName)}</span>` +
    `<span class="muted small" id="updated">更新于 ${escapeHtml(time(overview.generated_at))}</span>` +
    `<span class="chip online" id="conn">在线</span>` +
    `<button class="btn" id="refresh-toggle" type="button">暂停刷新</button>` +
    `</div>` +
    `</header>` +
    `<div class="wrap">` +
    `<nav class="tabs" role="tablist">` +
    `<button class="tab active" type="button" data-view="chat">聊天</button>` +
    `<button class="tab" type="button" data-view="memory">记忆</button>` +
    `<button class="tab" type="button" data-view="timeline">关系</button>` +
    `<button class="tab" type="button" data-view="status">状态</button>` +
    `</nav>` +
    renderChat(session, herName) +
    renderMemory(memory, facts, probe) +
    `<section class="panel" id="panel-timeline" data-panel="timeline">` +
    `<div id="timeline-hero">${renderTimelineHero(timeline)}</div>` +
    `<div class="card"><div class="card-head"><h2>她眼中的你</h2></div><div id="her-view">${renderHerView(timeline)}</div></div>` +
    `<div class="card"><div class="card-head"><h2>里程碑</h2></div><div id="timeline-milestones">${renderMilestones(timeline.milestones)}</div></div>` +
    `<div class="card"><div class="card-head"><h2>关系变化</h2></div><div id="timeline-events">${renderEvents(timeline.events)}</div></div>` +
    `</section>` +
    `<section class="panel" id="panel-status" data-panel="status">` +
    `<div class="grid" id="state-grid">${renderStateCards(timeline)}</div>` +
    `<div class="grid"><div class="card" id="health-card">${renderHealthCard(health)}</div><div class="card" id="today-cost-card">${renderTodayCostCard(cost)}</div></div>` +
    `<div class="card wide" id="week-cost-card">${renderWeekCostCard(cost)}</div>` +
    `</section>` +
    `<p class="footer">只读控制台 · 每 5 秒自动刷新（可暂停）· 仅绑定 127.0.0.1</p>` +
    `</div>` +
    `<script>window.__KAREN_BOOT__ = ${escapeJsonForScript(boot)};</script>` +
    `<script>${CLIENT_JS}</script>` +
    `</body>` +
    `</html>`
  );
}

// 以下小函数只给首屏与 JS 渲染复用，保持输出一致。

function renderTimelineHero(timeline: TimelineData): string {
  const streak =
    timeline.interaction_streak > 1 ? `<span class="chip">连续互动 ${fmtInt(timeline.interaction_streak)} 天</span>` : "";
  return (
    `<div class="card rel-hero">` +
    `<div class="rel-score">${num(timeline.closeness)}<span class="muted">/10</span></div>` +
    `<div class="rel-label">${escapeHtml(timeline.label)}${streak}</div>` +
    `<div class="bar"><i style="width:${pct(timeline.closeness / 10)}%"></i></div>` +
    `<div class="muted small">` +
    (timeline.has_state
      ? `关系状态已持久化 · 最近保存 ${escapeHtml(time(timeline.state_saved_at))}`
      : "还没有持久化的关系状态——先和她聊几句，这里会开始记录。") +
    `</div>` +
    `</div>`
  );
}

function renderHerView(timeline: TimelineData): string {
  const herView = timeline.her_view;
  if (!herView.current) {
    return `<p class="empty">她还没把对你的看法写下来——也许还太早，也许她还在藏。</p>`;
  }
  const meta = herView.updated_at
    ? `写于 ${escapeHtml(time(herView.updated_at))}` +
      (herView.updated_closeness !== null ? ` · 亲密度 ${num(herView.updated_closeness)} 时` : "")
    : "最初写在人设里的印象，还没再更新过";
  const previous =
    herView.previous && herView.previous !== herView.current
      ? `<div class="muted small">更早的时候她写的是：「${escapeHtml(herView.previous)}」</div>`
      : "";
  return `<blockquote>「${escapeHtml(herView.current)}」</blockquote><div class="muted small">${meta}</div>${previous}`;
}

function renderStateCards(timeline: TimelineData): string {
  const emotion = timeline.emotion;
  const guilt = timeline.guilt;
  const drift = timeline.drift;
  const narrative = timeline.narrative;
  const emotionCard =
    `<div class="card"><div class="card-head"><h2>情绪</h2></div>` +
    (emotion
      ? `<div class="stat">${escapeHtml(emotion.label)}</div>` +
        `<div class="muted small">情绪 ${num(emotion.vector)} · 波动 ${num(emotion.arousal)} · 基线 ${num(emotion.baseline)}</div>`
      : `<p class="empty">还没有演化状态——先和她聊几句。</p>`) +
    `</div>`;
  const guiltCard =
    `<div class="card"><div class="card-head"><h2>负债</h2></div>` +
    (guilt
      ? `<div class="stat">${num(guilt.guilt)}</div>` +
        `<div class="muted small">愧疚 ${num(guilt.guilt)} · 怨气 ${num(guilt.resentment)}</div>`
      : `<p class="empty">还没有记录。</p>`) +
    `</div>`;
  const driftCard =
    `<div class="card"><div class="card-head"><h2>基线漂移</h2></div>` +
    (drift
      ? `<div class="stat">${num(drift.actual, 3)}</div>` +
        `<div class="muted small">实际 ${num(drift.actual, 3)} · 她的自我感知 ${num(drift.perceived, 3)} · 压力 ${num(drift.pressure)}</div>` +
        `<div class="muted small">${escapeHtml(drift.alert ?? "")}</div>`
      : `<p class="empty">还没有记录。</p>`) +
    `</div>`;
  const narrativeCard =
    `<div class="card"><div class="card-head"><h2>心理阶段</h2></div>` +
    (narrative
      ? `<div class="stat">${escapeHtml(narrative.stage_label)}</div>` +
        `<div class="muted small">${escapeHtml(narrative.hint)}` +
        (narrative.direction_label ? ` · ${escapeHtml(narrative.direction_label)}` : "") +
        `</div>` +
        (narrative.narrative ? `<blockquote>「${escapeHtml(narrative.narrative)}」</blockquote>` : "")
      : `<p class="empty">还没有记录。</p>`) +
    `</div>`;
  return emotionCard + guiltCard + driftCard + narrativeCard;
}

function renderHealthCard(health: HealthData): string {
  const h = health.health;
  return (
    `<div class="card-head"><h2>运行状态</h2></div>` +
    `<div class="kv"><span>数据库</span><b class="${h.db_ok ? "ok-text" : "err-text"}">${h.db_ok ? "正常" : "异常"}</b></div>` +
    `<div class="kv"><span>WS 连接</span><b>${fmtInt(h.ws_connections)}</b></div>` +
    `<div class="kv"><span>待补发</span><b>${fmtInt(h.pending_replies)}</b></div>` +
    `<div class="kv"><span>运行时长</span><b>${escapeHtml(fmtUptime(h.uptime_seconds))}</b></div>` +
    `<div class="kv"><span>版本</span><b>${escapeHtml(h.version)}</b></div>` +
    `<div class="kv"><span>最近错误</span><b class="small">${h.last_error ? escapeHtml(h.last_error) : "无"}</b></div>`
  );
}

function renderTodayCostCard(cost: CostData): string {
  const today = cost.today;
  return (
    `<div class="card-head"><h2>今日成本</h2></div>` +
    `<div class="stat">${escapeHtml(fmtCny(today.cost_cny))}</div>` +
    `<div class="muted small">${fmtInt(today.calls)} 次调用 · 输入 ${fmtTokens(today.prompt_tokens)} tokens（缓存命中 ${fmtTokens(today.cached_tokens)}）· 输出 ${fmtTokens(today.completion_tokens)} tokens</div>`
  );
}

function renderWeekCostCard(cost: CostData): string {
  const week = cost.week;
  const maxDayCost = Math.max(...week.by_day.map((day) => day.cost_cny), 0.0000001);
  const dayRows = week.by_day
    .map(
      (day) =>
        `<div class="cost-row">` +
        `<span class="cost-date">${escapeHtml(day.date.slice(5))}</span>` +
        `<span class="cost-bar"><i style="width:${pct(day.cost_cny / maxDayCost)}%"></i></span>` +
        `<span class="cost-val">${escapeHtml(fmtCny(day.cost_cny))}</span>` +
        `<span class="muted small">${fmtInt(day.calls)} 次</span>` +
        `</div>`,
    )
    .join("");
  const modelRows =
    week.by_model.length === 0
      ? `<p class="empty">最近 7 天还没有调用记录。</p>`
      : week.by_model
          .map(
            (model) =>
              `<div class="kv"><span>${escapeHtml(model.model)}</span><b>${escapeHtml(fmtCny(model.cost_cny))} · ${fmtInt(model.calls)} 次</b></div>`,
          )
          .join("");
  return (
    `<div class="card-head"><h2>最近 ${fmtInt(week.window_days)} 天成本</h2>` +
    `<span class="muted small">合计 ${escapeHtml(fmtCny(week.total.cost_cny))} · ${fmtInt(week.total.calls)} 次调用</span></div>` +
    `<div class="cost-list">${dayRows}</div>` +
    `<h3>按模型</h3>${modelRows}`
  );
}
