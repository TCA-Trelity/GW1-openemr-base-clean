# Sidecar image for Railway: build panel + TS, run the compiled server.
# Railway service root directory = sidecar/, so paths are relative to it.
FROM node:22-slim AS panel
# CACHEBUST: bump this to force a fully fresh, no-reuse build. Railway's layer cache
# has intermittently served stale/poisoned layers (phantom TS2307, cancelled builds);
# changing this invalidates every layer below it in the stage.
ARG CACHEBUST=2
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci
COPY panel/ ./
RUN npm run build

FROM node:22-slim AS build
ARG CACHEBUST=2
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Runtime data resolved relative to dist/: SQL migrations, seed corpus, built panel.
COPY migrations ./migrations
COPY seed ./seed
COPY --from=panel /panel/dist ./panel/dist
EXPOSE 8080
CMD ["node", "dist/server.js"]
