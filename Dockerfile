# === Karen Persona — Dockerfile（开发者 / Linux 用户可选）===
#
# 定位：容器里只跑 Karen 的 QQ 桥接进程；NapCatQQ 仍要跑在宿主机上扫码登录，
# 再通过「反向 WebSocket」连到容器。
#
# 构建：
#   docker build -t karen .
#
# 运行（Linux 推荐 host 网络；NapCat 在宿主机连 127.0.0.1:18080 即可）：
#   docker run --rm --network host --env-file .env \
#     -v "$PWD/data:/app/data" \
#     -v "$PWD/config.yaml:/app/config.yaml:ro" \
#     karen
#
# 说明：
# - 镜像内不含 .env / config.yaml / data（见 .dockerignore），运行时挂载或 --env-file 提供。
# - 为安全默认只监听 127.0.0.1（M0 加固）。用 host 网络时 NapCat 直接连宿主机回环地址；
#   若改用 -p 端口映射，需要显式设置 ONE_BOT_HOST=0.0.0.0（暴露风险自负）。
# - 应用没有 HTTP /health 端点（M1-9 规划中），下面 HEALTHCHECK 用 WS 端口探活。

# ---------- 构建阶段：安装依赖 + 编译 TypeScript ----------
FROM node:22-slim AS build

ENV TZ=Asia/Shanghai
WORKDIR /app

# better-sqlite3 通常有 Node 22 预编译包；保留编译工具链以应对无预编译的平台。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 只保留运行时依赖（tsx / vitest / typescript 等 devDependencies 不进镜像）
RUN npm prune --omit=dev

# ---------- 运行阶段：非 root 用户 ----------
FROM node:22-slim AS runtime

ENV TZ=Asia/Shanghai \
    NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 karen

COPY --from=build --chown=karen:karen /app/node_modules ./node_modules
COPY --from=build --chown=karen:karen /app/dist ./dist
COPY --from=build --chown=karen:karen /app/package.json ./package.json
COPY --chown=karen:karen personas ./personas

# 挂载卷时宿主机目录需对 uid 1000 可写；容器内先建好默认数据目录
RUN mkdir -p /app/data && chown karen:karen /app/data

USER karen

# 仅作说明：默认监听 127.0.0.1，端口映射场景需改 ONE_BOT_HOST
EXPOSE 18080

# 探活目标端口/地址与程序一致：优先环境变量，其次 config.yaml，最后默认 18080/127.0.0.1
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "const fs=require('node:fs'),net=require('node:net');let cfg={};try{cfg=require('yaml').parse(fs.readFileSync('config.yaml','utf8'))||{}}catch{};const port=Number(process.env.ONE_BOT_WS_PORT)||Number(cfg.one_bot_ws_port)||18080;const host=String(process.env.ONE_BOT_HOST||cfg.one_bot_ws_host||'127.0.0.1');const target=host==='0.0.0.0'?'127.0.0.1':host;const s=net.connect(port,target,()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)"

CMD ["node", "dist/bridge/qq.js"]
