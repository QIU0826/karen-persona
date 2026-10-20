import { describe, expect, it } from "vitest";
import {
  OWNER_CLI,
  ownerForQq,
  ownerSlug,
  resolveOwnerScope,
} from "./owner.js";

describe("owner 多用户隔离作用域", () => {
  it("qq owner 格式与 slug", () => {
    expect(ownerForQq(123456)).toBe("qq:123456");
    expect(ownerSlug("qq:123456")).toBe("qq-123456");
    expect(ownerSlug("cli:local")).toBe("cli-local");
  });

  it("主用户（白名单第一个 QQ）使用历史存储，保证旧数据不迁移即归属", () => {
    const scope = resolveOwnerScope("xiaoya", "qq:111", [111, 222]);
    expect(scope.legacy).toBe(true);
    expect(scope.storageKey).toBe("");
    expect(scope.storagePersona).toBe("xiaoya");
  });

  it("CLI 使用历史存储", () => {
    const scope = resolveOwnerScope("xiaoya", OWNER_CLI, [111]);
    expect(scope.legacy).toBe(true);
    expect(scope.storageKey).toBe("");
  });

  it("其他用户被隔离", () => {
    const scope = resolveOwnerScope("xiaoya", "qq:222", [111, 222]);
    expect(scope.legacy).toBe(false);
    expect(scope.storageKey).toBe("-qq-222");
    expect(scope.storagePersona).toBe("xiaoya@qq-222");
  });

  it("白名单为空时 QQ 用户也隔离（避免互看历史记忆）", () => {
    const scope = resolveOwnerScope("xiaoya", "qq:333", []);
    expect(scope.legacy).toBe(false);
    expect(scope.storagePersona).toBe("xiaoya@qq-333");
  });
});
