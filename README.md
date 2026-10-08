# Insurance Platform – Backend API

Node.js 22 + TypeScript + Express 5 + MongoDB + Redis. Serves `/api/v1` for the mobile app and the web admin panel.

## Run locally

```bash
copy .env.example .env        # Windows (macOS/Linux: cp). Then put long random values in the three *_SECRET lines
npm install
docker compose up -d          # MongoDB + Redis
npm run seed                  # platform admin + demo accounts
npm run dev                   # http://localhost:4000/api/v1  ·  docs: http://localhost:4000/api/docs
npm run worker:dev            # second terminal: background jobs (reminders, expiry, reconciliation)
```

Demo accounts (password `Demo@1234` = SEED_PASSWORD): `demo@test.com` (Advisor), `staff@test.com` (Office Staff), `admin@insurance.local` (Platform Admin).

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Tests use a real MongoDB (`insurance_test` database) and Redis DB 15; both are wiped before each test file.

## Structure

```
src/
  config/env.ts        environment variables, checked at startup
  lib/                 logger, errors, MongoDB, Redis, crypto, validators, route helper
  middleware/          authentication + permissions, rate limits, error handler
  modules/<module>/    *.model.ts (MongoDB), *.service.ts (business rules), *.routes.ts (HTTP)
  docs/openapi.ts      Swagger document generated from the routes
  jobs/                job schedule (definitions.ts) and the BullMQ queue
  app.ts / server.ts   Express app / process start + graceful shutdown
  worker.ts            background worker process (npm run worker)
tests/                 API tests (Vitest + Supertest)
```

## Providers (switch with environment variables, no code changes)

| What | Development / staging | Production |
|---|---|---|
| SMS (OTP, approvals, plan reminders) | `SMS_PROVIDER=console` | `msg91` + `MSG91_AUTH_KEY` + `MSG91_TEMPLATE_IDS` (DLT templates) |
| WhatsApp | `WHATSAPP_PROVIDER=console` | `meta` (WhatsApp Cloud API) + webhook `/api/v1/webhooks/whatsapp` |
| Email | `EMAIL_PROVIDER=console` | `smtp` + `SMTP_URL` |
| Documents | `STORAGE_DRIVER=local` | `s3` (AWS S3 Mumbai or Cloudflare R2, private bucket) |
| Payments | `PAYMENT_PROVIDER=mock` | `razorpay` + webhook `/api/v1/webhooks/razorpay` |

With `NODE_ENV=production` the server refuses to start while any of these is still on its development setting.

## Deploy

`render.yaml` creates the API, the worker and Redis on Render (Singapore). MongoDB Atlas (Mumbai) is created
separately and its connection string is entered as `MONGODB_URI`. The same Docker image runs anywhere
(`node dist/server.js` = API, `node dist/worker.js` = worker).

Error responses always look like `{ "code": "VALIDATION_ERROR", "message": "…", "details": […], "requestId": "…" }`.
