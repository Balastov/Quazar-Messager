# Build React SPA
# Номер версии меняется каждый выпуск, а пакеты — редко. Ставим заглушку вместо версии в
# package.json и package-lock.json: тогда слой с npm ci берётся из кэша, и на обычном выпуске
# npm не ходит в интернет (сбой реестра npm 21.11.2026 ронял деплой ровно на этом шаге).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e "const fs = require('fs'); for (const f of ['package.json', 'package-lock.json']) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.version = '0.0.0'; if (j.packages && j.packages['']) j.packages[''].version = '0.0.0'; fs.writeFileSync(f, JSON.stringify(j)); }"

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/package.json /app/package-lock.json ./
# Пакеты поменялись — кэш npm между сборками (докачиваются только новые) и до трёх попыток:
# «Exit handler never called!» и обрывы связи с реестром не роняют деплой.
RUN --mount=type=cache,target=/root/.npm \
    n=0; \
    until npm ci --prefer-offline --no-audit --no-fund \
        --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000; do \
      n=$((n + 1)); \
      if [ "$n" -ge 3 ]; then echo "npm ci failed 3 times" >&2; exit 1; fi; \
      echo "npm ci failed — retry $n of 2 in 15 s" >&2; rm -rf node_modules; sleep 15; \
    done
# Настоящие package.json и версия — вместе с исходниками.
COPY . .
RUN npm run build

# Serve static files
FROM nginx:1.27-alpine
COPY nginx.spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
