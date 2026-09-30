# 社团章程修订应用 —— 单容器镜像
# better-sqlite3 为原生模块，需在构建阶段编译
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 原生编译工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- 运行镜像 ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/charter.db
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# 数据库文件持久化目录（首次启动自动建表初始化）
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000

# 简易健康检查：API 概览可达即健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/overview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
