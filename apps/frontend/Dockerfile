FROM node:20-slim AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY apps/frontend/package.json apps/frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY apps/frontend/ ./
RUN pnpm build

FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next

EXPOSE 3000

CMD ["npx", "next", "start", "-p", "3000"]
