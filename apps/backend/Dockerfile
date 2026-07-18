FROM node:22-alpine AS build
WORKDIR /app
COPY apps/backend/package.json apps/backend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/backend/nest-cli.json apps/backend/tsconfig.json apps/backend/tsconfig.build.json ./
COPY apps/backend/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY apps/backend/package.json apps/backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
