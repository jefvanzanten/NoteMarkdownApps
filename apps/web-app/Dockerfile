FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

FROM base AS development-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web-app/package.json apps/web-app/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
COPY packages/editor/package.json packages/editor/package.json
COPY packages/markdown-wasm/package.json packages/markdown-wasm/package.json
COPY packages/workspace-core/package.json packages/workspace-core/package.json
COPY packages/workspace-drive/package.json packages/workspace-drive/package.json
COPY packages/workspace-local/package.json packages/workspace-local/package.json
RUN corepack pnpm install --filter @note/web-app... --frozen-lockfile

FROM development-dependencies AS build
ENV PATH="/root/.cargo/bin:$PATH"
RUN apk add --no-cache build-base curl \
    && curl --proto '=https' --tlsv1.2 --silent --show-error --fail https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --target wasm32-unknown-unknown

ARG VITE_GOOGLE_PICKER_API_KEY=""
ARG VITE_GOOGLE_APP_ID=""
ARG VITE_BASE_PATH="/notes/"
ENV VITE_GOOGLE_PICKER_API_KEY="$VITE_GOOGLE_PICKER_API_KEY"
ENV VITE_GOOGLE_APP_ID="$VITE_GOOGLE_APP_ID"
ENV VITE_BASE_PATH="$VITE_BASE_PATH"

COPY apps/web-app apps/web-app
COPY packages/api-contracts packages/api-contracts
COPY packages/browser-storage packages/browser-storage
COPY packages/sync-core packages/sync-core
COPY packages/editor packages/editor
COPY packages/markdown-wasm packages/markdown-wasm
COPY packages/workspace-core packages/workspace-core
COPY packages/workspace-drive packages/workspace-drive
COPY packages/workspace-local packages/workspace-local
RUN corepack pnpm --filter @note/web-app build

FROM nginx:1.27-alpine AS runtime
ENV API_UPSTREAM="http://notes-api:3000"
COPY apps/web-app/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web-app/dist /usr/share/nginx/html
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1
