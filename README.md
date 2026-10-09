# Glossary

A personal glossary for coding terms: capture them as you hit them, look them up on your phone later.
Plain HTML, CSS and JavaScript, with no build step. Terms are stored in Supabase.

## One-time setup in Supabase

1. **Create the table.** Open your project → **SQL Editor** → **New query**, paste all of
   [`schema.sql`](schema.sql), and click **Run**.
2. **Create your account.** **Authentication** → **Users** → **Add user** → **Create new user**.
   Enter your email and a password, and tick **Auto Confirm User**.
3. **Turn off sign-ups.** **Authentication** → **Sign In / Providers** → turn off
   **Allow new users to sign up**. Without this, anyone who finds the app could make an account.
   They still couldn't see your terms, but they could use your database.

## Running it on your computer

The app is split into JavaScript modules, which browsers only load from a web server, so
double-clicking `index.html` won't work. From this folder, run:

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Putting it on your phone

An iPhone can only install the app from an `https://` address. This app is hosted with GitHub Pages:
push this folder to a public GitHub repository, then in the repository open **Settings** → **Pages**,
set **Source** to **Deploy from a branch**, pick `main` and `/ (root)`, and save. After a minute or two
it's live at `https://<your-username>.github.io/<repository-name>/`.

Open that address in Safari → **Share** → **Add to Home Screen**.

To update the live app later, commit your changes and `git push`. GitHub Pages republishes by itself.

## What's where

| File | What it does |
|---|---|
| `index.html` | The page layout: header, the area screens are drawn in, the bottom tab bar |
| `styles.css` | All the styling, including dark mode |
| `app.js` | The screens (list, detail, add/edit, search, sign in) and moving between them |
| `db.js` | Every call to Supabase, plus working out *why* something failed |
| `config.js` | Your Supabase URL and anon key |
| `sw.js` | Service worker: saves a copy of the app so it opens with no signal |
| `manifest.webmanifest` | Name, icon and full-screen setting for the home screen |
| `schema.sql` | The database table and its security rules |
| `icons/` | The app icon |
| `.nojekyll` | Empty on purpose: tells GitHub Pages to serve the files as they are |
| `.gitignore` | Files git should leave out of the repository |

## The database

One table, `public.terms`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key. Made by the app, so saving twice can't create a duplicate |
| `user_id` | uuid | Your account. Filled in automatically from whoever is signed in |
| `term` | text | Required, 1–200 characters |
| `definition` | text | Optional (empty by default), up to 20,000 characters |
| `created_at` | timestamptz | When you added it. The list is sorted by this |
| `updated_at` | timestamptz | Updated automatically by a trigger whenever you edit |

Row Level Security is on. Without signing in (just the public anon key) the table can't be touched
at all. Signed in, you only see and change your own rows.

## When something goes wrong

The app never shows an empty list just because something failed. Instead:

- **No connection, or Supabase not answering:** a full screen saying so, with **Try again**. Every
  request gives up after about 10 seconds rather than hanging.
- **Terms already on screen, but a refresh fails:** they stay visible, with a banner saying when
  they were loaded.
- **Saving fails:** the form keeps what you typed. Unsaved typing also survives the app being
  closed, because iOS often reloads home-screen apps when you switch away.
- **Free Supabase projects pause after a week without use.** If the app says it can't reach the
  database and your connection is fine, open supabase.com/dashboard and restore the project.
