import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 统计全部源码；测试文件/入口脚本不计入
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "text", "json-summary"],
      // 基线守护：低于这些值 CI 视为失败。
      // 2026-10-20 首次基线：Stmts 50.9% / Branch 47.25% / Funcs 57.76% / Lines 51.91%
      thresholds: {
        statements: 50,
        branches: 45,
        functions: 55,
        lines: 51,
      },
    },
  },
});
