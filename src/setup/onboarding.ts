/**
 * 首次引导 2.0：把「第一段对话」写进她的记忆。
 *
 * 引导完成时对以下 owner 各写一份：
 * - `cli:local`（CLI 试聊）；
 * - 白名单第一个 QQ（若 setup 时填了），即主用户 `qq:<id>`。
 *
 * 写入内容：
 * 1. 会话消息（她记得「怎么认识的 / 你叫什么 / 你在哪」）；
 * 2. user_facts（名字/城市/认识方式）；
 * 3. user_consent（AI 披露 + 18+ 确认）——这样 QQ/CLI 首次聊天
 *    不会重复发披露、也不会再被年龄门拦住；
 * 4. `data/onboarding.json` 标记（只存最小元信息，不存对话正文）。
 */
import fs from "node:fs";
import { dataFile, ensureDataDir } from "../data/paths.js";
import { addMessage, loadSession } from "../data/history.js";
import { ownerForQq, resolveOwnerScope } from "../data/owner.js";
import { upsertUserFacts } from "../data/user-facts.js";
import { ackDisclosure, confirmAge } from "../data/consent.js";
import { loadPersona } from "../persona/loader.js";
import {
  buildOnboardingDialogue,
  buildOnboardingFacts,
  type OnboardingFact,
} from "./flow.js";

export const ONBOARDING_VERSION = 1;
const ONBOARDING_FILE = "onboarding.json";

export interface OnboardingRecord {
  version: number;
  personaId: string;
  herName: string;
  /** 已写入记忆/同意的 owner 列表 */
  owners: string[];
  completedAt: string;
}

export interface CompleteOnboardingInput {
  personaId: string;
  herName: string;
  howWeMet: string;
  yourName: string;
  location: string;
  /** 白名单第一个 QQ（没有则只写 cli:local） */
  allowedUsers: number[];
  /** 用户是否确认已满 18 岁（未确认不写 consent，也不写会话） */
  ageConfirmed: boolean;
  /** 是否确认已阅读 AI 披露 */
  disclosureAcked: boolean;
}

/** 读取引导标记；文件不存在/损坏返回 null（引导状态永远不应阻塞启动）。 */
export function readOnboardingRecord(): OnboardingRecord | null {
  const file = dataFile(ONBOARDING_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<OnboardingRecord>;
    if (parsed.version !== ONBOARDING_VERSION) return null;
    if (!Array.isArray(parsed.owners) || typeof parsed.personaId !== "string") return null;
    return {
      version: ONBOARDING_VERSION,
      personaId: parsed.personaId,
      herName: typeof parsed.herName === "string" ? parsed.herName : "",
      owners: parsed.owners.filter((owner): owner is string => typeof owner === "string"),
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : "",
    };
  } catch {
    return null;
  }
}

/** 某个 owner 是否已完成引导（用于测试/诊断；bridge 主要通过会话/consent 自然跳过）。 */
export function hasCompletedOnboarding(owner: string): boolean {
  const record = readOnboardingRecord();
  return record?.owners.includes(owner) === true;
}

function writeOnboardingRecord(record: OnboardingRecord): void {
  ensureDataDir();
  const file = dataFile(ONBOARDING_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 完成引导：写会话/事实/同意 + 标记文件。返回记录。
 * 失败时抛错（调用方负责提示用户），不会写一半标记。
 */
export async function completeOnboarding(input: CompleteOnboardingInput): Promise<OnboardingRecord> {
  if (!input.ageConfirmed) {
    throw new Error("未确认已满 18 岁，不能完成引导");
  }
  const persona = await loadPersona(input.personaId);
  const herCity =
    (persona as { identity?: { lifeStory?: { hometown?: string } } }).identity?.lifeStory
      ?.hometown ?? "";
  const dialogue = buildOnboardingDialogue(input.herName, {
    howWeMet: input.howWeMet,
    yourName: input.yourName,
    location: input.location,
    herCity,
  });
  const facts: OnboardingFact[] = buildOnboardingFacts({
    howWeMet: input.howWeMet,
    yourName: input.yourName,
    location: input.location,
  });

  const owners: string[] = ["cli:local"];
  const primaryQq = input.allowedUsers[0];
  if (primaryQq !== undefined) owners.push(ownerForQq(primaryQq));

  // 主用户（白名单第一个 QQ）与 CLI 共用 legacy 存储（storageKey=""），
  // 同一个人不需要把同一段对话写两遍：会话按 storageKey 去重，事实/同意按 owner 写。
  const writtenScopes = new Set<string>();
  for (const owner of owners) {
    const scope = resolveOwnerScope(input.personaId, owner, input.allowedUsers);
    if (!writtenScopes.has(scope.storageKey)) {
      writtenScopes.add(scope.storageKey);
      const session = loadSession(persona.name, scope.storageKey);
      for (const line of dialogue) {
        addMessage(session, line.role, line.content);
      }
    }
    if (facts.length > 0) {
      upsertUserFacts(owner, facts);
    }
    if (input.disclosureAcked) ackDisclosure(owner);
    confirmAge(owner);
  }

  const record: OnboardingRecord = {
    version: ONBOARDING_VERSION,
    personaId: input.personaId,
    herName: input.herName,
    owners,
    completedAt: new Date().toISOString(),
  };
  writeOnboardingRecord(record);
  return record;
}
