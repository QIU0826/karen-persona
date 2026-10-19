/**
 * 纠正层（域四）。
 * 用户反馈 → 行为修正 → 持久化到 corrections.md。
 */

import fs from "node:fs";
import path from "node:path";

export interface Correction {
  id: number;
  /** 触发场景描述 */
  scenario: string;
  /** 人设不该说的话 */
  wrongResponse: string;
  /** 用户期望的回应 */
  expectedResponse: string;
  /** 时间戳 */
  timestamp: number;
  /** 同类纠正次数 */
  count: number;
}

const PERSONAS_DIR = path.resolve("personas");

/** 加载纠正记录 */
export function loadCorrections(personaId: string): Correction[] {
  const filePath = path.join(PERSONAS_DIR, personaId, "corrections.md");
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, "utf-8");
  // 解析 Markdown 中的纠正记录（简单格式）
  const corrections: Correction[] = [];
  const lines = raw.split("\n");
  let current: Partial<Correction> | null = null;

  for (const line of lines) {
    if (line.startsWith("### 纠正")) {
      if (current && current.scenario) {
        corrections.push(current as Correction);
      }
      current = { id: corrections.length + 1, timestamp: Date.now(), count: 1 };
    }
    if (line.startsWith("- **场景**:") && current) {
      current.scenario = line.replace("- **场景**:", "").trim();
    }
    if (line.startsWith("- **不应说**:") && current) {
      current.wrongResponse = line.replace("- **不应说**:", "").trim();
    }
    if (line.startsWith("- **应说**:") && current) {
      current.expectedResponse = line.replace("- **应说**:", "").trim();
    }
  }
  if (current && current.scenario) {
    corrections.push(current as Correction);
  }
  return corrections;
}

/** 添加或更新纠正记录 */
export function addCorrection(
  personaId: string,
  scenario: string,
  wrongResponse: string,
  expectedResponse: string
): void {
  const corrections = loadCorrections(personaId);

  // 检查是否已有相似纠正
  const existing = corrections.find(
    (c) => c.scenario === scenario || c.wrongResponse === wrongResponse
  );

  if (existing) {
    existing.count++;
    existing.timestamp = Date.now();
    existing.expectedResponse = expectedResponse;
  } else {
    corrections.push({
      id: corrections.length + 1,
      scenario,
      wrongResponse,
      expectedResponse,
      timestamp: Date.now(),
      count: 1,
    });
  }

  // 写回文件
  saveCorrections(personaId, corrections);

  // 达到阈值 → 提示用户
  const threshold = corrections.filter((c) => c.count >= 3);
  if (threshold.length > 0) {
    console.log(
      `[纠正] ${threshold.length} 条纠正已达到更新阈值，建议审核并更新人设文件`
    );
  }
}

function saveCorrections(personaId: string, corrections: Correction[]): void {
  const filePath = path.join(PERSONAS_DIR, personaId, "corrections.md");
  let content = `# ${personaId} — 纠正记录\n\n`;
  content += `> 用户纠正的累积记录。当同类纠正达到阈值时，自动更新人设文件。\n\n`;
  content += `## 纠正历史\n\n`;

  if (corrections.length === 0) {
    content += "_（暂无。）_\n";
  } else {
    for (const c of corrections) {
      content += `### 纠正 #${c.id}（累计 ${c.count} 次）\n`;
      content += `- **场景**: ${c.scenario}\n`;
      content += `- **不应说**: ${c.wrongResponse}\n`;
      content += `- **应说**: ${c.expectedResponse}\n`;
      content += `- **最后发生**: ${new Date(c.timestamp).toISOString()}\n\n`;
    }
  }

  fs.writeFileSync(filePath, content, "utf-8");
}

/** 检查当前消息是否应该应用纠正 */
export function applyCorrections(
  personaId: string,
  currentScenario: string
): { corrected: boolean; expectedResponse?: string } {
  const corrections = loadCorrections(personaId);
  const match = corrections.find(
    (c) =>
      c.count >= 2 && // 至少2次同类纠正才自动应用
      (currentScenario.includes(c.scenario) ||
        c.scenario.includes(currentScenario))
  );
  if (match) {
    return { corrected: true, expectedResponse: match.expectedResponse };
  }
  return { corrected: false };
}
