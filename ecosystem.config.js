/**
 * PM2 进程守护配置（仅 Windows/Linux 的 QQ 桥接进程）。
 *
 * 用法:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 logs karen-qq
 *
 * 启动方式二选一（默认走 B）：
 *   A. 编译产物（推荐生产）：
 *      先在项目根目录执行 `npm run build`，然后把下面 script 改成
 *      "dist/bridge/qq.js"、删掉 node_args，用 node 直接跑编译后的 JS。
 *      优点：启动快、不依赖 devDependencies（tsx/typescript）；改代码后需重新 build。
 *   B. tsx 直跑 TypeScript 源码（默认，开发方便）：
 *      `node --import tsx src/bridge/qq.ts`，免构建；但要求 devDependencies 已安装，
 *      启动时多一次编译、内存占用略高，不适合长期生产守护。
 *
 * 健康检查说明:
 *   项目暂时没有 HTTP /health 端点（M1-9 规划中），因此这里不配置 PM2 健康检查。
 *   请用 `pm2 status` / `pm2 logs` / 应用日志观察存活与重连；内存超过 512MB 会自动重启。
 *
 * 前置条件：先启动 NapCatQQ（scripts/start-napcat.bat），扫码登录并配置好反向 WS。
 * 文档: https://pm2.keymetrics.io/docs/usage/application-declaration/
 */
module.exports = {
  apps: [
    {
      name: "karen-qq",
      // 固定工作目录，避免从其他目录 pm2 start 时找不到 config.yaml / personas/
      cwd: __dirname,

      // === 方式 B（默认）：tsx 直跑 TypeScript 源码 ===
      script: "src/bridge/qq.ts",
      interpreter: "node",
      node_args: "--import tsx",

      // === 方式 A（生产推荐）：改为下面两行 ===
      // script: "dist/bridge/qq.js",
      // interpreter: "node",

      // 崩溃自动重启（延迟 5s 避免抖动；连续重启超过 10 次后停止，暴露真实问题）
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // 内存超过 512MB 时重启（防止内存泄漏拖垮整机）
      max_memory_restart: "512M",
      // 优雅退出等待时间：给会话 JSON / SQLite 落盘留时间
      kill_timeout: 5000,

      // 日志（首次启动前先确保目录存在：mkdir -p data/logs）
      log_date_format: "MM-DD HH:mm:ss",
      error_file: "data/logs/pm2-error.log",
      out_file: "data/logs/pm2-out.log",
      merge_logs: true,

      env: {
        NODE_ENV: "production",
      },
    },
    // NapCatQQ 需要单独在托盘启动，PM2 不管理它。
  ],
};
