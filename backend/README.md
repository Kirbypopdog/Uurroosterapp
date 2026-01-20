# Backend

Deze map bevat de backend (auth, opslag, API).

## Stack
- Node/Express
- Postgres

## Setup (lokaal)
1) Maak een database aan en voer `backend/sql/schema.sql` uit.
2) Maak `.env` op basis van `backend/.env.example`.
3) Installeer dependencies:
   - `npm install`
4) Seed teams + admin:
   - `npm run seed`
5) Start server:
   - `npm run dev`

## Endpoints
- `POST /auth/register` (maakt medewerker account)
- `POST /auth/login`
- `GET /me` (auth)
- `PUT /me` (auth, profiel update)
- `GET /teams` (auth)
- `GET /users` (auth, rol‑gefilterd)
- `GET /admin/users` (admin)
- `PATCH /admin/users/:id` (admin)
- `POST /admin/users/:id/reset-password` (admin)
