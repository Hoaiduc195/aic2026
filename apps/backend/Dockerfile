FROM node:20-slim AS builder

WORKDIR /app

COPY apps/backend/package*.json ./
RUN npm ci

COPY apps/backend/ ./
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY apps/backend/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY apps/backend/sql ./sql

EXPOSE 4000

CMD ["node", "dist/main.js"]
