# Fiber Inventory Portal — Setup

This package contains everything needed to run the portal **except `node_modules`**
(install with `npm install`). Your seeded data is in `fiber_inventory_seeded.dump`.

## Prerequisites
- Node.js (18+) and npm
- PostgreSQL (17/18) running locally

## Steps

1. **Install dependencies**
   ```
   npm install
   ```
   (This also runs `prisma generate` via the postinstall hook.)

2. **Create the `.env` file** (copy from `.env.example`) and set your DB URL:
   ```
   DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/fiber_inventory?schema=public"
   APP_NAME="Fiber Inventory Portal"
   AUTH_SECRET="change-this-local-secret"
   SECRETS_ENCRYPTION_KEY="change-this-local-smtp-secret"
   FEATURE_DEMO_DATA=false
   ```

3. **Create the database**
   ```
   createdb -U postgres fiber_inventory
   ```

4. **Restore the seeded data** (this loads all tables + rows from the dump)
   ```
   pg_restore -U postgres -d fiber_inventory --clean --if-exists fiber_inventory_seeded.dump
   ```
   > The dump already contains the schema, so you do NOT need to run
   > `prisma migrate` for a restore. Only run migrations if you start from an
   > empty DB without restoring: `npx prisma migrate deploy`.

5. **Run**
   - Dev:  `npm run dev`   → http://localhost:3000
   - Prod: `npm run build && npm start`

## Notes
- `storage/attachments/` and `storage/reports/` are runtime upload folders (kept empty).
- Legacy SQLite `.db` files were intentionally excluded — the app uses PostgreSQL.
