# NoteMarkdown metadata API

Hono/PostgreSQL API for Google identity, revocable sessions, encrypted refresh tokens, Drive folder references, and global preferences. It intentionally has no document, image, render, search, filename, or path endpoint.

## Local prerequisites

- Node.js 24 and pnpm 10
- Docker Engine with Docker Compose v2

On Ubuntu 24.04:

```sh
sudo apt update
sudo apt install docker.io docker-compose-v2
sudo usermod -aG docker "$USER"
```

Log out and back in after changing group membership, then verify with `docker version` and `docker compose version`.

## Local setup

An ignored `apps/api/.env` is used by `dotenv`. Create it from `.env.example` if it does not exist and generate a real 32-byte development encryption key:

```sh
cp apps/api/.env.example apps/api/.env
key="$(openssl rand -base64 32 | tr -d '\n')"
sed -i "s|1:REPLACE_WITH_BASE64_32_BYTE_KEY|1:${key}|" apps/api/.env
```

Start PostgreSQL and apply the Drizzle migration:

```sh
pnpm --filter @note/api setup:local
```

This uses [`compose.yaml`](./compose.yaml), waits for the database health check, and retains data in the `notemarkdown-postgres` Docker volume. Useful commands:

```sh
pnpm --filter @note/api db:up
pnpm --filter @note/api db:migrate
pnpm --filter @note/api db:down
pnpm --filter @note/api db:reset  # destructive: removes the local database volume
```

After setup, start the user-managed API development server:

```sh
pnpm --filter @note/api dev
```

The Vite web app proxies `/api` to `http://localhost:8787`. Therefore no API base URL is needed in `apps/web-app/.env` for local development.

- `GET http://localhost:8787/health` checks the HTTP process.
- `GET http://localhost:8787/ready` checks PostgreSQL connectivity.
- `GET http://localhost:8787/openapi.json` serves the generated contract.

## Google development configuration

The API can boot and its health/database behavior can be tested with the placeholder Google values in the generated local `.env`, but Google sign-in only works after replacing them with a real OAuth web client:

- callback URL: `http://localhost:5173/api/v1/auth/google/callback`;
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `apps/api/.env`;
- `VITE_GOOGLE_PICKER_API_KEY` and `VITE_GOOGLE_APP_ID` in `apps/web-app/.env`.

The OAuth grant uses `openid email profile` and the non-sensitive `drive.file` scope. Browser content traffic goes directly to Google Drive.

## Verification

Unit, API security, and contract tests:

```sh
pnpm --filter @note/api test
pnpm --filter @note/api typecheck
```

Real PostgreSQL repository and isolation tests, after `setup:local`:

```sh
pnpm --filter @note/api test:integration
```

Keep old token-encryption key versions configured while rotating; new credentials use the highest version.
