/** 域九：关系/负债/演化状态持久化 */
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = path.resolve("data", "runtime-state.json");

export interface RuntimeState {
  closeness: number;
  guilt: number;
  resentment: number;
  emotionBaseline: number;
  lastUpdated: string;
}

export function loadState(): RuntimeState {
  if (!fs.existsSync(STATE_FILE)) {
    return { closeness: 3, guilt: 0, resentment: 0, emotionBaseline: 0, lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export function saveState(state: RuntimeState): void {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
