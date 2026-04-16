# SearchTides Internal Sponsored Fee Dashboard

HSS internal dashboard: LV pipeline by client, internal **LV quotas** from the same HSS base, and **automated sponsored-fee KPIs** (BOF + FINAL $) from central OM. Only **one** SeaTable API token is required.

## Setup

### 1. GitHub
Push this folder to a new GitHub repository (can be private).

### 2. Vercel
1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Select this repository
3. Click **Deploy** (Vercel runs `npm install` because `package.json` includes `@vercel/node` for the `/api/data` function)

### 3. Environment Variables
1. Vercel dashboard → your **project** → **Settings** → **Environment Variables**
2. **Add** a variable whose **name is exactly** `OM_API_TOKEN` (copy-paste — wrong name = API will return an error).
3. **Value** = SeaTable **API token** for the **HSS** base (the base that contains tables **OM** and **QUOTAS**).
4. Enable it for **Production** (and **Preview** if you use preview deployments).
5. **Deployments** → open the latest deployment → **⋯** → **Redeploy** (env vars are not applied to old builds until you redeploy).

If the page still shows an error, the red box should now show the **exact message** (e.g. missing env, or SeaTable `getAccess 401`). You can also open **Deployments → Functions → /api/data** logs in Vercel for the same text.

See also `.env.example` in this repo.

### 4. Done
Your dashboard is live at `your-project.vercel.app`

## Data sources (single HSS base)
- **Table OM** — view `Martina Dashboard View`: LV by status, `Prod Month`, `FINAL $` for sponsored-fee metrics
- **Table QUOTAS** — internal LV quota per client for the current calendar month

## Notes
- Data refreshes on page load, or via **Refresh**
- Vercel caches `/api/data` for 5 minutes (`s-maxage=300`) to reduce SeaTable rate limits
