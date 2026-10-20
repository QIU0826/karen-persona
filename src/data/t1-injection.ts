/**
 * T1 人格快照注入（P1：长期关系缺少「最近情绪弧线」）。
 *
 * 背景：`t1_snapshots` 每轮都会写一条（情绪/亲密度/负债），但此前完全没进 prompt。
 * 结果是她只看到「此刻」的状态标签，看不到「最近几轮关系在往哪走」——被问「我们最近
 * 是不是有点怪」时只能现编。这里把最近几条快照压成一句结构化状态弧注入 prompt。
 *
 * 设计约束：
 * - **不引用对话正文**：T1.content 里有用户消息片段，注入容易让她复述/串味；只用
 *   数值趋势（亲密度/情绪/负债），天然脱敏；
 * - 纯函数便于测试：`buildT1ArcContext` 只吃快照数组；
 * - 输出 ≤120 tokens，附在动态提示块里，不影响静态人设缓存前缀。
 */
import { getRecentSnapshots, type T1Snapshot } from "./vector.js";

/** 最多取最近几条快照（再多也没有「最近几轮」的意义，只增加 token） */
export const T1_ARC_WINDOW = 8;

/** 快照条数少于 2 就不生成（单点没有「弧线」） */
const MIN_SNAPSHOTS = 2;

function round2(value: number): string {
  return value.toFixed(2);
}

function emotionTrendLabel(delta: number): string {
  if (delta > 0.1) return "往上走";
  if (delta < -0.1) return "有点落";
  return "平稳";
}

/**
 * 把最近几轮 T1 快照压成「最近状态弧」提示块。
 *
 * @param snapshots 最近 T1 快照（**新→旧**，与 getRecentSnapshots 返回顺序一致）
 * @returns 注入块；快照不足/数据异常返回空串
 */
export function buildT1ArcContext(snapshots: T1Snapshot[]): string {
  const valid = (Array.isArray(snapshots) ? snapshots : []).filter(
    (snap) =>
      snap &&
      Number.isFinite(snap.closeness) &&
      Number.isFinite(snap.emotionVector),
  );
  if (valid.length < MIN_SNAPSHOTS) return "";

  // 新→旧 → 按时间正序（旧→新），便于算趋势
  const ordered = valid.slice(0, T1_ARC_WINDOW).reverse();
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  const closenessDelta = last.closeness - first.closeness;
  const emotionDelta = last.emotionVector - first.emotionVector;
  const maxGuilt = Math.max(...ordered.map((snap) => (Number.isFinite(snap.guilt) ? snap.guilt : 0)));

  const parts: string[] = [];
  parts.push(`最近 ${ordered.length} 轮互动`);

  if (Math.abs(closenessDelta) >= 0.02) {
    const dir = closenessDelta > 0 ? "升温" : "降温";
    parts.push(`亲密度 ${round2(first.closeness)} → ${round2(last.closeness)}（${dir}）`);
  } else {
    parts.push(`亲密度 ${round2(last.closeness)}（平稳）`);
  }

  parts.push(
    `情绪 ${round2(first.emotionVector)} → ${round2(last.emotionVector)}（${emotionTrendLabel(emotionDelta)}）`,
  );

  // 负债 <0.2 基本可以忽略，不占提示位
  if (maxGuilt >= 0.2) parts.push(`负债 ${round2(maxGuilt)}（还没还清）`);

  return (
    `\n## 你最近几轮的状态\n` +
    `${parts.join("；")}。\n` +
    `（这是你自己感觉到的变化，不用说出来，自然带着就行。）`
  );
}

/**
 * 读取当前人设（或指定 personaId）最近快照并生成状态弧；DB 异常时静默返回空。
 * 供 orchestrator 三条回复路径共用。
 */
export function getT1ArcContext(personaId?: string): string {
  try {
    const snapshots = getRecentSnapshots(T1_ARC_WINDOW, personaId);
    return buildT1ArcContext(snapshots);
  } catch {
    return "";
  }
}
