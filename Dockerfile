# === 仅限开发者和 Linux 用户 ===
# NapCatQQ 仍需在宿主机运行，Docker 只包 Karen bridge。
#
# 用法:
#   docker build -t karen .
#   docker run -v ./data:/app/data -v ./.env:/app/.env -v ./config.yaml:/app/config.yaml --network host karen
#
# --network host 让容器能访问宿主机上 NapCat 的 WebSocket (127.0.0.1:18080)

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npx", "tsx", "src/bridge/qq.ts"]
