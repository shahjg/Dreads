const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const session = require('express-session');
const path = require('path');

const app = express();

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.use(session({ secret: 'dreads-key', resave: false, saveUninitialized: true }));

app.get('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.redirect('/');

    const base = new URL(targetUrl);
    req.session.baseDomain = base.origin;
    req.session.lastUrl = targetUrl;

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

    const $ = cheerio.load(data);

    // Remove base tag — it breaks our link rewriting
    $('base').remove();

    // Strip all junk
    const removeSelectors = [
      'script', 'iframe', 'noscript',
      '[class*="ad-"]', '[id*="ad"]', '[class*="-ad"]',
      '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
      '[class*="paywall"]', '[class*="subscribe"]', '[class*="subscription"]',
      '[class*="cookie"]', '[class*="gdpr"]', '[class*="consent"]',
      '[class*="newsletter"]', '[class*="signup"]',
      '[class*="sticky"]', '[class*="fixed-"]',
      '[id*="paywall"]', '[id*="subscribe"]', '[id*="popup"]',
      '.adsbygoogle', '[data-ad]', '[aria-label*="advertisement"]',
    ];
    $(removeSelectors.join(',')).remove();

    // Fix ALL image sources including lazy loaded ones
    $('img').each((_, el) => {
      // Try every possible image attribute
      const src = $(el).attr('data-src')
        || $(el).attr('data-lazy-src')
        || $(el).attr('data-original')
        || $(el).attr('data-img-src')
        || $(el).attr('src');

      if (src) {
        let absolute = src;
        if (src.startsWith('//')) absolute = `https:${src}`;
        else if (src.startsWith('/')) absolute = `${base.origin}${src}`;
        $(el).attr('src', absolute);
        $(el).removeAttr('data-src');
        $(el).removeAttr('data-lazy-src');
        $(el).removeAttr('loading'); // remove lazy loading
      }
    });

    // Fix srcset
    $('img[srcset], source[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const fixed = srcset.split(',').map(s => {
          const parts = s.trim().split(/\s+/);
          if (parts[0]) {
            if (parts[0].startsWith('//')) parts[0] = `https:${parts[0]}`;
            else if (parts[0].startsWith('/')) parts[0] = `${base.origin}${parts[0]}`;
          }
          return parts.join(' ');
        }).join(', ');
        $(el).attr('srcset', fixed);
      }
    });

    // Fix CSS background images in style attributes
    $('[style]').each((_, el) => {
      const style = $(el).attr('style') || '';
      const fixed = style.replace(/url\(['"]?(\/[^'")\s]+)['"]?\)/g, (match, p1) => {
        return `url('${base.origin}${p1}')`;
      });
      $(el).attr('style', fixed);
    });

    // Rewrite ALL links — handle relative, absolute, and protocol-relative
    $('a').each((_, el) => {
      let href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      // Convert to absolute
      if (href.startsWith('//')) href = `https:${href}`;
      else if (href.startsWith('/')) href = `${base.origin}${href}`;
      else if (!href.startsWith('http')) href = `${base.origin}/${href}`;

      // Route through proxy
      $(el).attr('href', `/proxy?url=${encodeURIComponent(href)}`);
      $(el).removeAttr('target'); // prevent opening in new tab
    });

    // Inject clean styles
    $('head').append(`
      <style>
        * { filter: none !important; -webkit-filter: none !important; }
        [class*="paywall"], [class*="blur"], [class*="gate"], [class*="overlay"],
        [class*="modal"], [class*="subscribe"], [class*="cookie"], [class*="consent"],
        [style*="blur"] {
          display: none !important;
          visibility: hidden !important;
        }
        body { overflow: auto !important; position: static !important; }
        html, body { max-width: 100% !important; }
        img { display: block !important; }
      </style>
    `);

    // Inject DReads toolbar
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

    res.send($.html());

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
