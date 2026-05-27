# NORATH Web

Lightweight multi-page website for a Minecraft server with:

- Home page
- Information page with live status
- Rules page
- `/map` redirect route
- Twitch button
- Editable background and blur in UI (stored in browser local storage)

## Quick start

```bash
cd /home/debian/xeinoria/norath-web
cp .env.example .env
npm install
npm start
```

Then open `http://localhost:8080`.

## Configuration

Edit `.env`:

- `MC_HOST` and `MC_PORT`: server endpoint to query (`proxy`/Velocity recommended)
- `MAP_REDIRECT_URL`: where `/map` should redirect
- `MAINTENANCE_KEYWORDS`: comma-separated keywords searched in MOTD
- `ASSUME_MAINTENANCE_WHEN_OFFLINE`: `true` or `false`
- `TWITCH_URL`: Twitch channel URL

## Notes

Status endpoint keeps a short in-memory cache to avoid excessive polling.
If the Minecraft server is offline, the website still loads and shows offline state.
