# Clean Reader

A personal proxy-based article reader. Fetches pages server-side, strips ads and paywalls, rewrites links so you never have to copy/paste again.

## Setup

```bash
npm install
npm start
```

Then open http://localhost:3000

## Dev mode (auto-restart on save)

```bash
npm run dev
```

## How it works

1. You paste a URL once
2. Server fetches the page (bypasses client-side paywalls)
3. Strips ads, overlays, popups, cookie banners
4. Rewrites all links to route back through the proxy
5. Injects clean typography CSS
6. Every link you click stays inside Clean Reader

## Deploy (optional)

Works on any Node.js host — Railway, Render, Fly.io, etc.
Just set the PORT environment variable if needed.
