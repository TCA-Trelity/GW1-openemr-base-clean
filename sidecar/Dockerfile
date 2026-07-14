# Sidecar image for Railway: build panel + TS, run the compiled server.
# Railway service root directory = sidecar/, so paths are relative to it.
FROM node:22-slim AS panel
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci
COPY panel/ ./
RUN npm run build

FROM node:22-slim AS build
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
# Runtime data resolved relative to dist/: SQL migrations, seed data, the guideline
# corpus (buildEvidenceDeps returns undefined without it — retriever_index reports
# not_configured and evidence turns silently fall back to Week 1), and the built panel.
COPY migrations ./migrations
COPY seed ./seed
COPY corpus ./corpus
COPY --from=panel /panel/dist ./panel/dist
EXPOSE 8080
CMD ["node", "dist/server.js"]
