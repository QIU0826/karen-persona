/**
 * 记忆数据主权：把「你们的对话 + 她的状态 + T2 记忆」导出为本地 JSON。
 *
 * 用于 /export 命令与手动备份；只读导出，不修改数据库。
 * 隐私注意：导出文件包含对话原文，权限设为 600，仅存本地 data/ 目录。
 */
import fs from "node:fs";
import { dataFile, safeFileStem } from "./paths.js";
import { loadSession } from "./history.js";
import { loadPersonaState } from "./state-store.js";
import { getVectorDb } from "./vector.js";

export interface UserExportResult {
  path: string;
  counts: { messages: number; memories: number; relationshipEvents: number };
}

interface ExportedEpisode {
  id: number;
  persona_id: string;
  content: string;
  source: string;
  strength: number;
  half_life_days: number;
  emotional_weight: number;
  created_at: number;
  last_recalled_at: number | null;
}

export function exportUserData(personaId: string, personaName: string): UserExportResult {
  const session = loadSession(personaName);
  const personaState = loadPersonaState(personaName);

  let episodes: ExportedEpisode[] = [];
  try {
    const db = getVectorDb();
    episodes = db
      .prepare(
        `SELECT id, persona_id, content, source, strength, half_life_days,
                emotional_weight, created_at, last_recalled_at
         FROM t2_episodes WHERE persona_id IN (?, ?) ORDER BY id DESC`,
      )
      .all(personaId, personaName) as ExportedEpisode[];
  } catch {
    // 数据库不可读时仍导出会话/状态；不阻断
    episodes = [];
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    personaId,
    personaName,
    session,
    personaState,
    t2Episodes: episodes,
  };

  const filename = `export-${safeFileStem(personaName)}-${Date.now()}.json`;
  const path = dataFile(filename);
  fs.writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });

  return {
    path,
    counts: {
      messages: session.messages.length,
      memories: episodes.length,
      relationshipEvents: personaState?.relationship.events.length ?? 0,
    },
  };
}
