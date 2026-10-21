/**
 * 「她的一天」持久化（v0.9.6）：daily_life 表，按 人设 × owner × 天 唯一。
 * 表结构在 src/data/memory-v2.ts 的初始化 SQL 里创建（与 initiative_plans 同层）。
 */
import type Database from "better-sqlite3";

export interface DailyLifeRow {
  persona_id: string;
  owner_id: string;
  day: string;
  life_json: string;
  created_at: number;
}

/** 读某天她的生活（没有返回 null）。 */
export function getDailyLife(
  db: Database.Database,
  personaId: string,
  ownerId: string,
  day: string,
): DailyLifeRow | null {
  try {
    const row = db
      .prepare(`SELECT * FROM daily_life WHERE persona_id = ? AND owner_id = ? AND day = ?`)
      .get(personaId, ownerId, day) as DailyLifeRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** 写/覆盖某天她的生活。 */
export function saveDailyLife(
  db: Database.Database,
  input: { personaId: string; ownerId: string; day: string; lifeJson: string; now?: number },
): void {
  try {
    db.prepare(
      `INSERT INTO daily_life (persona_id, owner_id, day, life_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(persona_id, owner_id, day) DO UPDATE SET
         life_json = excluded.life_json, created_at = excluded.created_at`,
    ).run(input.personaId, input.ownerId, input.day, input.lifeJson, input.now ?? Date.now());
  } catch {
    // 忽略（生活流失败不影响对话）
  }
}

/** 最近 N 天（按天倒序，最多 7 天）。 */
export function listRecentDailyLife(
  db: Database.Database,
  personaId: string,
  ownerId: string,
  days: number,
): DailyLifeRow[] {
  try {
    return db
      .prepare(
        `SELECT * FROM daily_life WHERE persona_id = ? AND owner_id = ? ORDER BY day DESC LIMIT ?`,
      )
      .all(personaId, ownerId, Math.min(7, Math.max(1, days))) as DailyLifeRow[];
  } catch {
    return [];
  }
}
