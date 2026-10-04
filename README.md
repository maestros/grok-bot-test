# Colleagues

A signed-in user enters a person's name or a public LinkedIn profile URL. The server asks a Grok model, through the official xAI API, to plan public searches and extract employment facts. It then checks every fact against the page it fetched. Unsupported people, titles, dates, and companies are dropped. Colleagues are people who shared a team, or the closest published grouping, during an overlapping period.

LinkedIn is used only for OpenID Connect sign-in. The app does not open LinkedIn pages, does not call LinkedIn profile or connection APIs, and does not log in as the user to read a network.

No cloud credentials were available in this environment, so this repo ships a working local app, a Dockerfile, and a free [Render](https://render.com) deploy path. Do not create a paid instance.

## Local run

Requires Node.js 22 or newer.

```bash
cp .env.example .env
npm ci
npm start
```

Open http://localhost:3000. `GET /health` returns `200` and does not check LinkedIn or xAI.

```bash
npm test
```

If `SESSION_SECRET` is unset outside production, the process generates a temporary secret and sessions end when the process stops. Set a real secret before sharing the app.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `LINKEDIN_CLIENT_ID` | For sign-in | LinkedIn app client ID |
| `LINKEDIN_CLIENT_SECRET` | For sign-in | LinkedIn app primary client secret |
| `LINKEDIN_CALLBACK_URL` | For sign-in | Exact redirect URL registered on the LinkedIn app |
| `SESSION_SECRET` | Production | 32 or more characters. Signs the httpOnly session cookie |
| `XAI_API_KEY` | For research | Official key from https://console.x.ai/ |
| `XAI_MODEL` | No | Defaults to `grok-4.7` |
| `XAI_BASE_URL` | No | Defaults to `https://api.x.ai/v1` |
| `BRAVE_SEARCH_API_KEY` | No | Enables Brave Web Search. If missing or Brave fails, DuckDuckGo HTML and the Wikipedia API are still used |
| `PORT` | No | Defaults to `3000`. Render sets this |
| `NODE_ENV` | Production | Set to `production` on the host |

Never commit `.env`. `.env.example` lists the same names with empty secrets.

## LinkedIn app setup

1. Open https://www.linkedin.com/developers/apps and create an app. LinkedIn requires the app to be associated with a Company Page.
2. On the **Products** tab, add **Sign In with LinkedIn using OpenID Connect**. No other LinkedIn product is used.
3. On the **Auth** tab, copy the **Client ID** and **Primary Client Secret**.
4. Under **Authorized redirect URLs for your app**, add the exact URL you will put in `LINKEDIN_CALLBACK_URL`. Sign-in finishes on that URL: the app exchanges the code, checks state and nonce, and sets the session there. Either of these paths works, as long as the LinkedIn app and `LINKEDIN_CALLBACK_URL` are the same string:
   - `https://colleagues.onrender.com/auth/linkedin`
   - `http://localhost:3000/auth/linkedin/callback`
5. Set `LINKEDIN_CALLBACK_URL` to that same string. LinkedIn rejects a redirect that differs by scheme, host, path, or trailing slash. The live service is registered at `https://colleagues.onrender.com/auth/linkedin`.
6. The app requests the scopes `openid`, `profile`, and `email`. After the ID token is verified against LinkedIn's published JWKS (`https://www.linkedin.com/oauth/openid/jwks`, issuer `https://www.linkedin.com/oauth`), the access token is discarded. The session cookie stores only the member id, display name, and a CSRF token. It is httpOnly, SameSite=Lax, and Secure on HTTPS. It lasts 7 days.

## What a lookup does

1. A name is used as entered. A `linkedin.com/in/…` URL is parsed for its public vanity name and is not fetched. Other URLs are rejected.
2. Grok returns search queries and optional public URLs. `linkedin.com` results are removed.
3. The server searches Wikipedia and DuckDuckGo HTML with no API key, searches Brave when `BRAVE_SEARCH_API_KEY` is set, and opens `https://theorg.com/search?q=…` plus a few linked public org pages.
4. Pages are downloaded by the server. Private addresses, non-HTTP ports, and LinkedIn hosts are refused. Redirects are checked again.
5. Grok extracts people, roles, teams, and dates, each with a verbatim excerpt and the page URL.
6. The server keeps a fact only when the excerpt is contained in the fetched page, and the name and company appear in that excerpt. A title or team that is not in the excerpt is removed. A year that is not in the excerpt is removed. `current` is accepted only when the excerpt says the role is current, or when the page is a theorg.com org chart that lists the person.
7. Two people are colleagues only at the same company. They are on the same team when both pages name the same team. Otherwise the company is labeled as the closest public grouping. Different named teams are not treated as the same team.
8. Overlap is calculated from the published ranges. A year with no month covers that calendar year. If the ranges do not overlap, the person is omitted. If there is not enough date information, the person is listed under **Overlap not established** instead of being placed in current or past. A company page that lists more than 30 people without a shared team is not turned into a colleague list.

Empty results stay empty. The sources that were opened are shown either way.

## Deploy on Render's free plan

Render can host this UI and API as one free web service. Fly.io no longer has a standing free allowance for new accounts. Do not add a database, disk, or a paid instance type. This repository was not deployed from here because no Render credentials were present.

1. Push this repository to GitHub.
2. In the [Render dashboard](https://dashboard.render.com/), choose **New** → **Blueprint** and select the repo. Render reads `render.yaml`.
   - Or choose **New** → **Web Service**, connect the repo, and enter the settings below by hand.
3. Use the **Free** instance type only.
4. Settings, if you are not using the blueprint:

   | Setting | Value |
   | --- | --- |
   | Runtime | Node |
   | Build command | `npm ci --omit=dev` |
   | Start command | `npm start` |
   | Health check path | `/health` |

5. Environment variables:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | Generate a value, or let the blueprint's `generateValue` create one |
   | `LINKEDIN_CLIENT_ID` | From the LinkedIn app |
   | `LINKEDIN_CLIENT_SECRET` | From the LinkedIn app |
   | `LINKEDIN_CALLBACK_URL` | The redirect URL registered on the LinkedIn app, such as `https://colleagues.onrender.com/auth/linkedin` |
   | `XAI_API_KEY` | From https://console.x.ai/ |
   | `XAI_MODEL` | `grok-4.7` |
   | `BRAVE_SEARCH_API_KEY` | Leave empty unless you have a Brave key |

6. Add that exact callback URL on the LinkedIn app's Auth tab, then deploy again if the hostname was not known on the first deploy.
7. Open `https://<service-name>.onrender.com/health`. A healthy service returns JSON with `"ok": true`.
8. Sign in and run a lookup.

Free web services spin down after about 15 minutes without traffic. The next request can take about a minute while the instance wakes. Lookups keep their progress in memory on that one instance. If the instance sleeps or restarts, start the lookup again. A free service includes 750 instance hours per workspace per month.

### Docker on the same free service

The Dockerfile runs `node src/server.js` as the `node` user. To use it on Render instead of the Node runtime, set **Runtime** to Docker and leave the Docker command empty so Render uses the image `CMD`. Keep the **Free** plan, health check path `/health`, and the same environment variables. The process listens on `PORT`.

```bash
docker build -t colleagues .
docker run --rm -p 3000:3000 --env-file .env colleagues
```

Set `NODE_ENV=production` and `SESSION_SECRET` in that env file or the container exits.
