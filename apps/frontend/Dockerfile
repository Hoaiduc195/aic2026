FROM node:22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json* ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci --workspace=@aic2026/frontend --ignore-scripts
COPY apps/frontend apps/frontend
RUN npm run build --workspace=@aic2026/frontend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/frontend/.next/standalone ./
COPY --from=build /workspace/apps/frontend/.next/static ./apps/frontend/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/frontend/server.js"]
