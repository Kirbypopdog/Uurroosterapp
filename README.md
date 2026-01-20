# Het Vlot Roosterplanning

## Wat is dit?
Een lokale roosterplanning tool voor Het Vlot. De app draait volledig in de browser en gebruikt LocalStorage voor demo-data.

## Repo-structuur
```
/frontend
  index.html
  styles.css
  app.js
  data.js
  validation.js
  /config
    settings.js
/backend
  README.md
```

## Lokaal draaien
**Frontend**
- Open `frontend/index.html` in je browser.

**Backend**
- Nog niet geïmplementeerd. Zie `backend/README.md` voor planning.

## Belangrijke afspraken
- **Source of truth**: GitHub repo.
- **Werkplek voor code changes**: lokaal (VS Code).
- **Settings centraal**: wijzig defaults alleen in `frontend/config/settings.js`.

## Teamregels (samenvatting)
- Vlot 1, Vlot 2, Cargo, Overkoepelend, Jobstudenten.
- Bi-weekly rooster: week 1 = weekend gesloten, week 2 = weekend open.

## Deployment (later)
- Render Static Site: frontend
- Render Web Service: backend
- Render Postgres: database
