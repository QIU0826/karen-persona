/**
 * 微信桥接占位（无依赖）。
 *
 * 历史：Phase 0 曾用 wechaty 做 echo 桩，但 wechaty 1.x 依赖树庞大
 * （会拉入 canvas 等原生模块，拖慢 npm install 并影响 Windows/macOS 可安装性），
 * 且本项目已明确以 QQ（NapCat / OneBot 11）为主路径，微信不在近期路线图。
 *
 * 因此移除 wechaty 依赖，保留「未实现」占位：`npm run wechat` 会明确提示走 QQ。
 */
import type { Persona } from "../persona/loader.js";
import type { AppConfig } from "../data/store.js";

export interface WechatBot {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createBot(_persona: Persona, _config: AppConfig): WechatBot {
  return {
    async start(): Promise<void> {
      console.log("[微信] 微信桥接暂未实现（占位）。");
      console.log("[微信] 当前主路径是 QQ：请使用 npm run qq（NapCat + OneBot 11）。");
      console.log("[微信] 微信官方/合规接入不在近期路线图内。");
      process.exitCode = 1;
    },
    async stop(): Promise<void> {
      // 无连接，无需清理
    },
  };
}
