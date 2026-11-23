# 多阶段构建：离线静态 SPA（构建产物由 nginx 托管，运行期无需后端）
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# 如需离线构建，可将 npm 仓库指向内网镜像；默认使用 npmmirror
RUN npm config set registry https://registry.npmmirror.com && npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
