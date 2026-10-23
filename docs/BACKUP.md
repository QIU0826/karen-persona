# 备份与恢复

> 状态：2026-10-23 新增（P0-1）。数据只有一份时，磁盘故障/误删/迁移出错都会让关系与记忆归零；
> 本页是唯一的备份/恢复操作说明。

## 备份什么

| 内容 | 路径 | 说明 |
|---|---|---|
| SQLite 主库 | `data/memory.sqlite` | 记忆、锚点、日记忆、事实、T1 快照、成本等 |
| 会话与人格状态 | `data/*.json` | session、persona-state、archive、Qzone 状态等 |
| 生成图 | `data/generated/` | 她发送过的生成图片（保留 30 天，但备份里保留） |
| 参考音 | `data/voice-ref/` | TTS 零样本克隆参考音（不入 git） |

**不在备份里**：`config.yaml` / `.env`（含 token 与 Key）、`assets/`（随仓库分发）、
`data/voice-samples/`（试听样本，可再现）。恢复后需要自己保留 `config.yaml`/`.env`。

## 命令

```bash
npm run backup                      # 热备到 <仓库同级>/karen-backups/YYYY-MM-DD/
npm run backup -- --dest /path      # 指定备份根目录（建议另一块盘/外接盘）
npm run backup -- --keep-days 30    # 保留 30 天（含当天）
npm run backup -- --no-images       # 不备份 data/generated
npm run backup:verify -- <日期目录>  # 恢复前校验（清单/文件/integrity_check/行数）
npm run backup:list                 # 列出已有备份

npm run backup:install              # 安装 macOS launchd 每日 03:30 备份
npm run backup:uninstall            # 卸载定时任务（保留备份文件）
```

底层入口是 `scripts/backup.sh`，定时任务也调用它；日志在
`<仓库同级>/karen-backups/launchd.log`。非 macOS 可用 cron/systemd 调用
`scripts/backup.sh`。

## 为什么不是 `cp data/memory.sqlite`

主库在 WAL 模式下运行时，最新对话可能还在 `memory.sqlite-wal` 里。脚本使用
SQLite 官方 Online Backup API（`better-sqlite3` 的 `db.backup()`），会把已提交的
WAL 数据一起写进副本，不需要停桥接；备份完成后再对副本做
`PRAGMA integrity_check` 并统计关键表行数。

## 恢复步骤

1. 停止桥接（终端里 Ctrl-C；若用 PM2：`pm2 stop karen-qq`）。
2. 校验备份：`npm run backup:verify -- /…/karen-backups/2026-10-23`，必须输出
   “校验通过”且行数与你记忆中的量级一致。
3. 备份当前 `data/`（防止恢复错版本）：
   `mv data data.before-restore-$(date +%Y%m%d-%H%M%S)`
4. 从备份目录拷回：`mkdir data && cp -a /…/2026-10-23/memory.sqlite /…/2026-10-23/*.json data/`；
   如备份里有 `memory.sqlite-wal` 且非空，也要一起拷回；`generated/`、`voice-ref/`
   按需拷回。
5. 重新启动桥接，检查 `/health`、`/stats`、`/fact`、`/relations`。
6. 确认无误后再删除 `data.before-restore-*`。

## 保留与安全

- 默认保留 14 天（含当天），按 `YYYY-MM-DD` 目录名清理；同一天重跑会覆盖当天备份。
- 备份根目录权限 `0700`，主库/会话/清单权限 `0600`，不写入仓库、不进 git。
- 备份是**明文**的：如果放到异地/网盘，建议先放在加密盘或加密压缩包里
  （例如 `tar -czf - 2026-10-23 | openssl enc -aes-256-cbc -pbkdf2 -out 2026-10-23.tar.gz.enc`）。
- 目前默认只备到本机同级目录：能防误删/写坏/迁移，**不能防整块磁盘损坏**；异地备份
  （`rsync` 到服务器/外接盘）仍需按你的隐私边界决定。
