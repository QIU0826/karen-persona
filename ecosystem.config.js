/**
 * PM2 进程守护配置（仅 Windows/Linux 的 QQ 桥接进程）。
 *
 * 用法（生产推荐，跑编译产物）:
 *   npm run build              # 先编译到 dist/（tsc）
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 logs karen-qq
 *
 * 开发调试不建议走 PM2，直接 `npm run qq`（tsx 直跑 TS 源码）。
 *
 * 为什么跑 dist/：
 *   - 生产环境不依赖 devDependencies（tsx/typescript），启动更快、内存更低；
 *   - 与 CI 的 `tsc` 产物一致；改代码后需要重新 `npm run build` 再 `pm2 restart karen-qq`。
 *
 * 健康检查（M1-9 可观测性）：
 *   /health 默认监听 127.0.0.1:18081（config.yaml 的 health_port，0=关闭）。
 *   自检：curl -s http://127.0.0.1:18081/health
 *   成本：curl -s http://127.0.0.1:18081/cost
 *   PM2 健康检查需要付费版/第三方插件，这里仍以 `pm2 status` + /health 手动/脚本探活。
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

      // 跑编译产物（先 npm run build；开发用 tsx 时请直接 `npm run qq`）
      script: "dist/bridge/qq.js",
      interpreter: "node",

      // 崩溃自动重启（延迟 5s 避免抖动；连续重启超过 10 次后停止，暴露真实问题）
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // 内存超过 512MB 时重启（防止内存泄漏拖垮整机）
      max_memory_restart: "512M",
      // 优雅退出等待时间：给会话 JSON / SQLite / health server 关闭留时间
      kill_timeout: 5000,

      // 日志（首次启动前先确保目录存在：mkdir -p data/logs）
      // 非 TTY 下应用日志为 JSON lines（可用 jq 过滤 event/level）。
      // 不设置 log_date_format：避免 PM2 给每行加时间前缀破坏 JSON 解析；
      // 时间已在 JSON 的 time 字段里（TTY 模式下也有时间）。
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
