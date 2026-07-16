# Deploy Club

## 1. GitHub

Repo: [https://github.com/sidmsmith/club](https://github.com/sidmsmith/club)

- `main` — production
- `dev` — collaboration

```powershell
cd "C:\Users\ssmith\OneDrive - Manhattan Associates\Documents\Solutions Consulting\Scripts\Web\club"
git checkout dev
# ... work ...
git push -u origin HEAD
```

## 2. Vercel

1. Import the GitHub repo at [vercel.com/new](https://vercel.com/new).
2. Framework preset: **Other**.
3. Environment variables (same values as Wordle / Flip):
   - `NEON_DATABASE_URL`
   - `ABLY_API_KEY`
4. Production branch: `main`. Enable previews for `dev` if desired.

## 3. After first deploy

Update `API_ORIGIN` in `club.html` to your Vercel URL, commit, and push.

## Local dev

```powershell
cd club
npm install
npx vercel dev
```

Uses `.env.local` with `NEON_DATABASE_URL` and `ABLY_API_KEY` if present.
