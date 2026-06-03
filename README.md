# Duns Creek Invitational Leaderboard

Static motocross leaderboard for best laps, three-lap race times, bike records, rider-bike PRs, and track records.

## Local Preview

```powershell
python -m http.server 5173 --bind 127.0.0.1
```

Open `http://127.0.0.1:5173`.

## Public Database

The app works without a database by using browser `localStorage`. For a real public leaderboard shared by every phone, create a Supabase project and run `supabase-schema.sql` in the SQL editor.

Then copy `config.example.js` to `config.js` and fill in:

```js
window.DUNSCREEK_CONFIG = {
  supabaseAnonKey: "YOUR_SUPABASE_ANON_PUBLIC_KEY",
  supabaseTable: "runs",
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
};
```

The anon key is intended to be public when Row Level Security policies are set correctly. The included schema allows public reads, public inserts, and same-device deletes for logs created after the `device_id` column is installed.

If you already created the table, run the latest `supabase-schema.sql` again in the Supabase SQL editor. Existing rows without `device_id` will stay on the leaderboard, but they will not show the site delete button. New logs saved from a phone or browser can be deleted from that same device.

## Deploy Static Site

### Netlify

1. Push this folder to a GitHub repository.
2. In Netlify, create a new site from that repository.
3. Build command: leave blank.
4. Publish directory: `.`
5. Deploy.

### Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, import the repository.
3. Framework preset: Other.
4. Build command: leave blank.
5. Output directory: `.`
6. Deploy.

## Domain

`dunscreek.invitational` is not a normal public domain unless `.invitational` becomes a delegated top-level domain. Use a domain such as `dunscreekinvitational.com`, `dunscreek-invitational.com`, or a subdomain you already own.
