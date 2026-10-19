/**
 * PM2 进程守护配置。
 * 使用: pm2 start ecosystem.config.js
 * 文档: https://pm2.keymetrics.io/docs/usage/application-declaration/
 */
module.exports = {
  apps: [
    {
      name: "karen-qq",
      script: "src/bridge/qq.ts",
      interpreter: "node",
      // tsx 作为 TypeScript 运行时
      node_args: "--import tsx",
      // 崩溃自动重启（延迟 5s 避免抖动）
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // 内存超过 512MB 时重启（防止内存泄漏）
      max_memory_restart: "512M",
      // 日志
      log_date_format: "MM-DD HH:mm:ss",
      error_file: "data/logs/pm2-error.log",
      out_file: "data/logs/pm2-out.log",
      merge_logs: true,
      // 环境变量
      env: {
        NODE_ENV: "production",
      },
    },
    // NapCatQQ 需要单独在托盘启动，PM2 不管理它
  ],
};
