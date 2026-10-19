import { WechatyBuilder, types, log } from "wechaty";
import type { Message } from "wechaty";
import type { Persona } from "../persona/loader.js";
import type { AppConfig } from "../data/store.js";

// 简单的消息处理器（Phase 0/1 为纯文字回复）
async function handleMessage(
  msg: Message,
  persona: Persona,
  config: AppConfig
): Promise<void> {
  // 忽略自己发的消息
  if (msg.self()) return;

  const text = msg.text();
  const talker = msg.talker();
  const talkerName = talker.name();

  // 仅处理文字消息
  if (msg.type() !== types.Message.Text || !text) return;

  console.log(`[收到] ${talkerName}: ${text}`);

  // Phase 0 简单回声——验证消息管线可用
  // Phase 1 会在 context.ts 中实现完整的六层 System Prompt 注入
  const reply = `${text}`;
  // 模拟打字延迟
  const typingDelay = 500 + Math.random() * 2000;
  await new Promise((r) => setTimeout(r, typingDelay));

  await msg.say(`[echo] ${reply}`);
  console.log(`[回复] -> ${talkerName}: ${reply}`);
}

export function createBot(persona: Persona, config: AppConfig) {
  const bot = WechatyBuilder.build({
    name: `karen-persona-${persona.name}`,
    puppet: "wechaty-puppet-wechat4u", // 免费 puppet，Phase 0 验证用
  });

  bot
    .on("scan", (qrcode: string, status: number) => {
      const statusMap: Record<number, string> = {
        0: "等待扫码",
        1: "已扫码，等待确认",
        2: "已确认，正在登录",
        3: "登录成功",
      };
      console.log(
        `[扫码] 状态: ${statusMap[status] || status}\n` +
          `[扫码] 二维码: https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`
      );
    })
    .on("login", (user: { name: () => string }) => {
      console.log(`[登录] ${user.name()} 已上线`);
      console.log("[就绪] 开始接收消息...\n");
    })
    .on("logout", (user: { name: () => string }) => {
      console.log(`[登出] ${user.name()} 已下线`);
    })
    .on("error", (err: Error) => {
      console.error("[错误]", err.message);
    })
    .on("message", (msg: Message) => handleMessage(msg, persona, config));

  return bot;
}
