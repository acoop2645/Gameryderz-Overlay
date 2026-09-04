# Gameryderz Mavericks UNO RSS Feed

This Vercel-ready project generates an RSS 2.0 feed for UNO Overlays from the public OTTO EVENT tournament page for **Lady Mavericks Fr** at the **2026 Tri-County High School Championships**.

After deployment, use:

- `https://YOUR-VERCEL-DOMAIN/feed.xml` in UNO's **Use Custom RSS URL** field.
- `https://YOUR-VERCEL-DOMAIN/status.json` to check the current source and parsed matches.

The app is preconfigured for the OTTO EVENT page supplied by the user. If OTTO serves the match data through a separate public JSON request, set the Vercel environment variable `OTTO_JSON_URL` to that request URL for the most reliable automatic updates.

Optional environment variables:

- `TEAM_NAME` — defaults to `Lady Mavericks Fr`
- `EVENT_NAME` — defaults to `2026 Tri-County High School Championships`
- `OTTO_PUBLIC_URL` — defaults to the supplied OTTO event page
- `OTTO_JSON_URL` — optional public JSON/XHR endpoint used by OTTO
