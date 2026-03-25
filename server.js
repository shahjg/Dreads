const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const session = require('express-session');

const app = express();

app.use(session({ secret: 'dreads-key', resave: false, saveUninitialized: true }));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

function toAbsolute(url, origin) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${origin}${url}`;
  if (!url.startsWith('http')) return `${origin}/${url}`;
  return url;
}

function processHTML(data, targetUrl, base) {
  const $ = cheerio.load(data);

  $('base').remove();

  // Only strip ad/paywall/cookie junk — leave interactive scripts alone
  const removeSelectors = [
    '[class*="ad-"]', '[id*="ad"]', '[class*="-ad"]',
    '[class*="popup"]',
    '[class*="paywall"]', '[class*="subscribe"]', '[class*="subscription"]',
    '[class*="cookie"]', '[class*="gdpr"]', '[class*="consent"]',
    '[class*="newsletter"]',
    '[id*="paywall"]', '[id*="subscribe"]', '[id*="popup"]',
    '.adsbygoogle', '[data-ad]', '[aria-label*="advertisement"]',
    'iframe',
  ];
  $(removeSelectors.join(',')).remove();

  // Only remove ad/tracking scripts, keep functional ones
  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    const content = $(el).html() || '';
    const isAd = /googletag|doubleclick|amazon-adsystem|adsbygoogle|scorecardresearch|outbrain|taboola|chartbeat|quantserve|comscore|Nielsen|permutive|smartadserver|pubmatic|rubiconproject|openx|appnexus|criteo/.test(src + content);
    if (isAd) $(el).remove();
  });

  // Fix images
  $('img').each((_, el) => {
    const src = $(el).attr('data-src')
      || $(el).attr('data-lazy-src')
      || $(el).attr('data-original')
      || $(el).attr('data-img-src')
      || $(el).attr('src');
    if (src) {
      const absolute = toAbsolute(src, base.origin);
      if (absolute) $(el).attr('src', absolute);
      $(el).removeAttr('data-src');
      $(el).removeAttr('data-lazy-src');
      $(el).removeAttr('loading');
    }
  });

  // Fix srcset
  $('img[srcset], source[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const fixed = srcset.split(',').map(s => {
        const parts = s.trim().split(/\s+/);
        if (parts[0]) parts[0] = toAbsolute(parts[0], base.origin) || parts[0];
        return parts.join(' ');
      }).join(', ');
      $(el).attr('srcset', fixed);
    }
  });

  // Fix background images in style attrs
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const fixed = style.replace(/url\(['"]?(\/[^'")\s]+)['"]?\)/g, (_, p1) => {
      return `url('${base.origin}${p1}')`;
    });
    $(el).attr('style', fixed);
  });

  // Fix stylesheet links
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const absolute = toAbsolute(href, base.origin);
      if (absolute) $(el).attr('href', absolute);
    }
  });

  // Fix script src URLs so they load correctly
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      const absolute = toAbsolute(src, base.origin);
      if (absolute) $(el).attr('src', absolute);
    }
  });

  // Rewrite links
  $('a').each((_, el) => {
    let href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    const absolute = toAbsolute(href, base.origin);
    if (absolute) {
      $(el).attr('href', `/proxy?url=${encodeURIComponent(absolute)}`);
      $(el).removeAttr('target');
    }
  });

  // Fix forms — restore action to original site so search works natively
  $('form').each((_, el) => {
    let action = $(el).attr('action') || `${base.origin}/`;
    action = toAbsolute(action, base.origin) || action;
    $(el).attr('action', action);
  });

  // Inject styles
  $('head').append(`
    <style>
      * { filter: none !important; -webkit-filter: none !important; }
      [class*="paywall"], [class*="blur"], [class*="gate"],
      [class*="subscribe"], [class*="cookie"], [class*="consent"],
      [style*="blur"] { display: none !important; visibility: hidden !important; }
      body { overflow: auto !important; position: static !important; }
      img { max-width: 100% !important; }
    </style>
  `);

  // Inject a script to rewrite any navigation that happens via JS
  $('body').append(`
    <script>
      // Intercept all client-side navigations back through DReads
      const _pushState = history.pushState.bind(history);
      const _replaceState = history.replaceState.bind(history);
      function rewriteNav(url) {
        if (!url) return url;
        const str = url.toString();
        if (str.startsWith('http') && !str.startsWith(window.location.origin)) {
          return '/proxy?url=' + encodeURIComponent(str);
        }
        if (str.startsWith('/') && !str.startsWith('/proxy')) {
          return '/proxy?url=' + encodeURIComponent('${base.origin}' + str);
        }
        return url;
      }
      history.pushState = (state, title, url) => _pushState(state, title, rewriteNav(url));
      history.replaceState = (state, title, url) => _replaceState(state, title, rewriteNav(url));
      document.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('/proxy') || href.startsWith('mailto:')) return;
        e.preventDefault();
        let absolute = href;
        if (href.startsWith('/')) absolute = '${base.origin}' + href;
        window.location.href = '/proxy?url=' + encodeURIComponent(absolute);
      });
    </script>
  `);

  // Inject toolbar
  $('body').prepend(`
    <div id="dreads-toolbar" style="
      position: sticky; top: 0; z-index: 99999;
      background: #1c1108; color: #f0e6d0;
      padding: 10px 24px; display: flex; align-items: center;
      gap: 14px; font-family: 'Jost', -apple-system, sans-serif;
      font-size: 13px; border-bottom: 1px solid rgba(229,205,168,0.1);
      box-shadow: 0 2px 16px rgba(0,0,0,0.5);
    ">
      <a href="/" style="color: #d4a97a; text-decoration: none; font-weight: 500; letter-spacing: 0.08em; font-size: 12px; text-transform: uppercase; white-space: nowrap;">← DReads</a>
      <span style="flex:1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(240,230,208,0.28); font-size: 11px;">${targetUrl}</span>
      <a href="${targetUrl}" target="_blank" style="color: rgba(240,230,208,0.3); text-decoration: none; font-size: 11px; white-space: nowrap; letter-spacing: 0.04em;">original ↗</a>
    </div>
  `);

  return $.html();
}

app.get('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.redirect('/');

    const base = new URL(targetUrl);
    req.session.lastUrl = targetUrl;

    let html;

    try {
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      html = await page.content();
      await browser.close();
    } catch (e) {
      const { data } = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/',
        },
        timeout: 12000,
        maxRedirects: 5
      });
      html = data;
    }

    res.send(processHTML(html, targetUrl, base));

  } catch (err) {
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Error — DReads</title>
      <style>
        body { background: #1c1108; color: #f0e6d0; font-family: -apple-system, sans-serif;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { text-align: center; }
        h2 { font-size: 18px; font-weight: 500; margin-bottom: 8px; }
        p { color: rgba(240,230,208,0.4); font-size: 13px; margin-bottom: 24px; }
        a { color: #d4a97a; text-decoration: none; border: 1px solid rgba(229,205,168,0.2); padding: 10px 20px; border-radius: 8px; }
      </style>
      </head>
      <body>
        <div class="box">
          <h2>Couldn't fetch that page</h2>
          <p>${err.message}</p>
          <a href="/">← Try another URL</a>
        </div>
      </body>
      </html>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DReads running → http://localhost:${PORT}`));
