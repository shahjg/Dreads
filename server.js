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
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${origin}${url}`;
  if (!url.startsWith('http')) return `${origin}/${url}`;
  return url;
}

// Known ad/tracker script patterns — ONLY these get removed
const AD_PATTERNS = [
  'googlesyndication', 'doubleclick', 'amazon-adsystem', 'adsbygoogle',
  'scorecardresearch', 'outbrain', 'taboola', 'chartbeat', 'quantserve',
  'comscore', 'permutive', 'pubmatic', 'rubiconproject', 'openx',
  'appnexus', 'criteo', 'moatads', 'adsrvr', 'adnxs', 'casalemedia',
  'aniview', 'sharethrough', 'sovrn', 'indexww', '33across',
  'googletagmanager', 'googletagservices', 'google-analytics',
  'hotjar', 'clarity.ms', 'facebook.net/en_US/fbevents'
];

function processHTML(html, targetUrl, origin) {
  const $ = cheerio.load(html);

  // Remove base tag
  $('base').remove();

  // Remove ONLY known ad/tracker scripts by src
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (AD_PATTERNS.some(p => src.includes(p))) $(el).remove();
  });

  // Remove inline scripts that are pure ad/tracking
  $('script:not([src])').each((_, el) => {
    const content = $(el).html() || '';
    if (AD_PATTERNS.some(p => content.includes(p)) && content.length < 2000) $(el).remove();
  });

  // Remove ad iframes only
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (AD_PATTERNS.some(p => src.includes(p)) || src === '' || src === 'about:blank') $(el).remove();
  });

  // Fix all stylesheet hrefs
  $('link[rel="stylesheet"], link[as="style"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', toAbsolute(href, origin));
  });

  // Fix all script srcs
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', toAbsolute(src, origin));
  });

  // Fix server-side images
  $('img').each((_, el) => {
    const src = $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original') || $(el).attr('src');
    if (src) {
      $(el).attr('src', toAbsolute(src, origin));
      $(el).removeAttr('data-src');
      $(el).removeAttr('data-lazy-src');
      $(el).removeAttr('loading');
    }
    // Fix srcset
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const fixed = srcset.split(',').map(s => {
        const parts = s.trim().split(/\s+/);
        if (parts[0]) parts[0] = toAbsolute(parts[0], origin);
        return parts.join(' ');
      }).join(', ');
      $(el).attr('srcset', fixed);
    }
  });

  // Fix server-side links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    $(el).attr('href', toAbsolute(href, origin));
    $(el).removeAttr('target');
  });

  // Fix video sources
  $('source[src], video[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', toAbsolute(src, origin));
  });

  // Fix meta og/twitter image tags
  $('meta[content]').each((_, el) => {
    const content = $(el).attr('content') || '';
    if (content.startsWith('/')) $(el).attr('content', `${origin}${content}`);
  });

  // Inject paywall remover + navigation interceptor + lazy image fixer
  $('head').append(`
    <style>
      /* Remove blur/filter paywalls */
      * { filter: none !important; -webkit-filter: none !important; }
      /* Hide known paywall overlay elements */
      [class*="paywall"], [class*="piano-"], [class*="tp-"], 
      [id*="piano"], [id*="paywall"],
      [class*="regwall"], [id*="regwall"],
      [class*="consent-"], [id*="consent-banner"],
      [class*="gdpr-"], [id*="gdpr"] {
        display: none !important;
      }
      /* Ensure body scrolls */
      body { overflow: auto !important; }
      html { overflow: auto !important; }
    </style>
  `);

  // Inject client-side script LAST in body
  $('body').append(`
    <script>
    (function() {
      var ORIGIN = ${JSON.stringify(origin)};
      var BASE = window.location.origin;

      // Route a URL through DReads proxy
      function proxyUrl(url) {
        if (!url) return url;
        var s = url.toString();
        if (s.startsWith('#') || s.startsWith('mailto:') || s.startsWith('tel:') || s.startsWith('javascript:')) return s;
        if (s.startsWith('//')) s = 'https:' + s;
        else if (s.startsWith('/')) s = ORIGIN + s;
        else if (!s.startsWith('http')) s = ORIGIN + '/' + s;
        return BASE + '/proxy?url=' + encodeURIComponent(s);
      }

      // Intercept all clicks on links
      document.addEventListener('click', function(e) {
        var a = e.target.closest('a');
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;
        if (href.startsWith('/proxy')) return; // already proxied
        e.preventDefault();
        e.stopPropagation();
        window.location.href = proxyUrl(href);
      }, true);

      // Intercept history navigation (JS-driven routing like React/Next.js)
      var _push = history.pushState.bind(history);
      var _replace = history.replaceState.bind(history);
      history.pushState = function(state, title, url) {
        if (url) {
          var s = url.toString();
          if (!s.startsWith('/proxy') && !s.includes(BASE)) {
            window.location.href = proxyUrl(url);
            return;
          }
        }
        _push(state, title, url);
      };
      history.replaceState = function(state, title, url) {
        if (url) {
          var s = url.toString();
          if (!s.startsWith('/proxy') && !s.includes(BASE)) {
            window.location.href = proxyUrl(url);
            return;
          }
        }
        _replace(state, title, url);
      };

      // Fix lazy loaded images as they appear in the DOM
      var imgObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
          m.addedNodes.forEach(function(node) {
            if (node.nodeType !== 1) return;
            var imgs = node.tagName === 'IMG' ? [node] : Array.from(node.querySelectorAll('img'));
            imgs.forEach(function(img) {
              var src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
              if (src) {
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) src = ORIGIN + src;
                img.src = src;
                img.removeAttribute('data-src');
                img.removeAttribute('data-lazy-src');
                img.removeAttribute('loading');
              }
            });
          });
        });
      });
      imgObserver.observe(document.body, { childList: true, subtree: true });

      // Fix any existing images with data-src that JS hasn't loaded yet
      document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach(function(img) {
        var src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (src) {
          if (src.startsWith('//')) src = 'https:' + src;
          else if (src.startsWith('/')) src = ORIGIN + src;
          img.src = src;
        }
      });

    })();
    </script>
  `);

  // Inject DReads toolbar
  $('body').prepend(`
    <div id="dreads-toolbar" style="
      position: sticky; top: 0; z-index: 2147483647;
      background: #1c1108; color: #f0e6d0;
      padding: 10px 24px; display: flex; align-items: center;
      gap: 14px; font-family: -apple-system, sans-serif;
      font-size: 13px; border-bottom: 1px solid rgba(229,205,168,0.1);
      box-shadow: 0 2px 16px rgba(0,0,0,0.5);
    ">
      <a href="/" style="color: #d4a97a; text-decoration: none; font-weight: 500; letter-spacing: 0.08em; font-size: 12px; text-transform: uppercase; white-space: nowrap;">← DReads</a>
      <span style="flex:1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(240,230,208,0.28); font-size: 11px;">${targetUrl}</span>
      <a href="${targetUrl}" target="_blank" rel="noopener" style="color: rgba(240,230,208,0.3); text-decoration: none; font-size: 11px; white-space: nowrap; letter-spacing: 0.04em;">original ↗</a>
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

    res.send(processHTML(html, targetUrl, base.origin));

  } catch (err) {
    res.status(500).send(`
      <!DOCTYPE html><html>
      <head><title>Error — DReads</title>
      <style>
        body { background: #1c1108; color: #f0e6d0; font-family: -apple-system, sans-serif;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { text-align: center; }
        h2 { font-size: 18px; font-weight: 500; margin-bottom: 8px; }
        p { color: rgba(240,230,208,0.4); font-size: 13px; margin-bottom: 24px; }
        a { color: #d4a97a; text-decoration: none; border: 1px solid rgba(229,205,168,0.2); padding: 10px 20px; border-radius: 8px; }
      </style></head>
      <body><div class="box">
        <h2>Couldn't fetch that page</h2>
        <p>${err.message}</p>
        <a href="/">← Try another URL</a>
      </div></body></html>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DReads running → http://localhost:${PORT}`));
