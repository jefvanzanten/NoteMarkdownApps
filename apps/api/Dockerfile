FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

FROM base AS development-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN corepack pnpm install --filter @note/api... --frozen-lockfile

FROM base AS production-dependencies
ENV NODE_ENV="production"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN corepack pnpm install --filter @note/api... --prod --frozen-lockfile

FROM development-dependencies AS build
COPY apps/api apps/api
COPY packages/api-contracts packages/api-contracts
RUN corepack pnpm --filter @note/api build

FROM base AS runtime
ENV NODE_ENV="production"
ENV PORT="3000"

COPY --from=production-dependencies /repo/node_modules /repo/node_modules
COPY --from=production-dependencies /repo/apps/api/node_modules /repo/apps/api/node_modules
COPY --from=build /repo/apps/api/package.json /repo/apps/api/package.json
COPY --from=build /repo/apps/api/dist /repo/apps/api/dist
COPY --from=build /repo/apps/api/drizzle /repo/apps/api/drizzle
COPY --from=build /repo/packages/api-contracts/package.json /repo/packages/api-contracts/package.json
COPY --from=build /repo/packages/api-contracts/dist /repo/packages/api-contracts/dist

WORKDIR /repo/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
