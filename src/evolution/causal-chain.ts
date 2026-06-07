/**
 * 因果链状态机（域五核心）。
 * Phase 4: 三种链类型 + user_traces + 闯入事件。
 */

export type ChainType = "continuous" | "relational" | "sudden";
export type ChainPhase = "active" | "dormant" | "resolved" | "archived";

export interface ChainEvent {
  date: string;
  description: string;
  intensity: number; // 0-1
}

export interface UserTrace {
  date: string;
  content: string; // 用户说过的相关的话
  recalled: boolean; // 是否已被引用过
}

export interface CausalChain {
  id: string;
  type: ChainType;
  title: string;
  phase: ChainPhase;
  events: ChainEvent[];
  userTraces: UserTrace[];
  lastProgress: string; // 最后一次进度时间
  moodImpact: number; // 对情绪基线的累积影响 -1 到 1
}

export function createChain(
  id: string,
  type: ChainType,
  title: string,
  initialEvent: string,
  intensity: number
): CausalChain {
  return {
    id,
    type,
    title,
    phase: "active",
    events: [{ date: new Date().toISOString(), description: initialEvent, intensity }],
    userTraces: [],
    lastProgress: new Date().toISOString(),
    moodImpact: intensity * (Math.random() > 0.5 ? 1 : -1) * 0.5,
  };
}

/** 添加因果链进展事件 */
export function addChainEvent(
  chain: CausalChain,
  description: string,
  intensity: number
): CausalChain {
  chain.events.push({
    date: new Date().toISOString(),
    description,
    intensity,
  });
  chain.lastProgress = new Date().toISOString();
  chain.moodImpact += intensity * 0.3;
  chain.moodImpact = Math.max(-1, Math.min(1, chain.moodImpact));

  // 累计强度 > 2.0 → 接近解决
  const totalIntensity = chain.events.reduce((s, e) => s + e.intensity, 0);
  if (totalIntensity > 2.0 && chain.phase === "active") {
    chain.phase = "dormant";
  }

  return chain;
}

/** 添加用户痕迹 */
export function addUserTrace(chain: CausalChain, content: string): CausalChain {
  chain.userTraces.push({
    date: new Date().toISOString(),
    content,
    recalled: false,
  });
  return chain;
}

/** 回响用户痕迹——人设主动引用用户说过的话 */
export function recallUserTrace(chain: CausalChain): string | null {
  const unrealled = chain.userTraces.filter((t) => !t.recalled);
  if (unrealled.length === 0) return null;
  const trace = unrealled[0];
  trace.recalled = true;
  return trace.content;
}

/** 生成闯入事件 */
export function generateIntrusion(chains: CausalChain[]): ChainEvent | null {
  const active = chains.filter((c) => c.phase === "active");
  if (active.length === 0) return null;

  // 10% 概率今天有闯入
  if (Math.random() > 0.1) return null;

  const chain = active[Math.floor(Math.random() * active.length)];
  const intrusions: Record<string, string[]> = {
    continuous: ["又出问题了", "有新的进展——但不是好消息"],
    relational: ["突然发来一条消息", "打了一个电话"],
    sudden: ["突发状况", "完全没想到的事"],
  };

  const pool = intrusions[chain.type] || ["意外事件"];
  const desc = pool[Math.floor(Math.random() * pool.length)];

  return {
    date: new Date().toISOString(),
    description: `[闯入] ${chain.title}: ${desc}`,
    intensity: 0.4 + Math.random() * 0.4,
  };
}

/** 检查僵尸链（> 30 天无进展） */
export function findZombieChains(chains: CausalChain[]): CausalChain[] {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return chains.filter(
    (c) => c.phase !== "archived" && new Date(c.lastProgress).getTime() < thirtyDaysAgo
  );
}
