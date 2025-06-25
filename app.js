const express = require('express');
const axios = require('axios');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const tough = require('tough-cookie');
const CookieJar = tough.CookieJar;

const app = express();
const PORT = 3000;
const AD_SERVER_URL = 'https://raw.githubusercontent.com/Jigsaw88/Spotify-Ad-List/refs/heads/main/Spotify%20Adblock.txt';
const COOKIE_FILE = 'cookies.txt';

let adServers = new Set();
let lastUpdated = null;
let cookieJar = new CookieJar();

// Enhanced ad patterns including API endpoints
const adPatterns = {
  domains: new Set(),
  paths: new Set([
    '/ads/',
    '/ad-logic/',
    '/ad_',
    '/adserver',
    '/advert',
    '/banner',
    '/sponsor',
    '/tracking',
    '/analytics'
  ]),
  keywords: [
    'ad', 'ads', 'advert', 'advertising', 
    'tracking', 'analytics', 'sponsor', 
    'promo', 'banner', 'doubleclick'
  ]
};

// Load cookies from file
function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = fs.readFileSync(COOKIE_FILE, 'utf8');
      const lines = data.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'));
      
      lines.forEach(line => {
        const cookie = tough.Cookie.parse(line);
        if (cookie) {
          cookieJar.setCookie(cookie, 'https://open.spotify.com', (err) => {
            if (err) console.error('Error setting cookie:', err);
          });
        }
      });
      console.log(`Loaded ${lines.length} cookies from ${COOKIE_FILE}`);
    } else {
      console.log(`No cookie file found at ${COOKIE_FILE}`);
    }
  } catch (err) {
    console.error('Error loading cookies:', err);
  }
}

// Function to fetch and update ad servers list
async function updateAdServers() {
  try {
    console.log('Fetching updated ad server list...');
    const response = await axios.get(AD_SERVER_URL);
    const servers = response.data.split('\n')
      .map(server => server.trim())
      .filter(server => server && !server.startsWith('#') && server !== '');
    
    adPatterns.domains = new Set(servers);
    lastUpdated = new Date();
    console.log(`Ad patterns updated at ${lastUpdated}. Domains: ${adPatterns.domains.size}, Paths: ${adPatterns.paths.size}`);
  } catch (error) {
    console.error('Failed to update ad servers:', error.message);
  }
}

// HTML content modifier to remove ad placeholders
function modifyHTMLContent(html) {
  return html
    .replace(/<div[^>]*class="[^"]*ad-[^"]*"[^>]*>.*?<\/div>/gis, '')
    .replace(/<script[^>]*src="[^"]*ads[^"]*"[^>]*>.*?<\/script>/gis, '')
    .replace(/<iframe[^>]*src="[^"]*ads[^"]*"[^>]*>.*?<\/iframe>/gis, '');
}

// Stream processor for response modification
function createResponseModifier(proxyRes, req, res) {
  const contentType = proxyRes.headers['content-type'];
  if (!contentType || !contentType.includes('text/html')) {
    return proxyRes.pipe(res);
  }

  const transformStream = new PassThrough();
  let chunks = [];
  
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const modified = modifyHTMLContent(body);
      transformStream.end(modified);
    } catch (err) {
      console.error('Error modifying content:', err);
      transformStream.end(Buffer.concat(chunks));
    }
  });
  
  return transformStream.pipe(res);
}

// Middleware to inject cookies into requests
app.use((req, res, next) => {
  // Get cookies for this domain
  cookieJar.getCookies('https://open.spotify.com', (err, cookies) => {
    if (err) {
      console.error('Error getting cookies:', err);
      return next();
    }
    
    if (cookies && cookies.length > 0) {
      req.headers.cookie = cookies.map(c => c.cookieString()).join('; ');
    }
    next();
  });
});

// Enhanced ad blocking middleware
app.use((req, res, next) => {
  const host = req.headers.host;
  const url = req.url.toLowerCase();
  
  // Check against known ad domains
  if (host && adPatterns.domains.has(host)) {
    console.log(`[Domain Block] ${host}${url}`);
    return res.status(403).send('Ad domain blocked');
  }
  
  // Check against known ad paths
  for (const path of adPatterns.paths) {
    if (url.includes(path)) {
      console.log(`[Path Block] ${host}${url}`);
      return res.status(403).send('Ad path blocked');
    }
  }
  
  // Check for ad keywords
  if (adPatterns.keywords.some(keyword => url.includes(keyword))) {
    console.log(`[Keyword Block] ${host}${url}`);
    return res.status(403).send('Ad keyword detected');
  }
  
  // Check for common ad API patterns
  if (url.includes('/api/') && (
    url.includes('/ad/') || 
    url.includes('/promo/') ||
    url.includes('/sponsored/')
  )) {
    console.log(`[API Block] ${host}${url}`);
    return res.status(403).send('Ad API blocked');
  }
  
  next();
});

// Proxy configuration with enhanced ad blocking and cookie support
const spotifyProxy = createProxyMiddleware({
  target: 'https://open.spotify.com',
  changeOrigin: true,
  selfHandleResponse: true,
  onProxyReq: (proxyReq, req, res) => {
    fixRequestBody(proxyReq, req);
    
    // Store cookies from response
    proxyReq.on('response', (proxyRes) => {
      const setCookieHeaders = proxyRes.headers['set-cookie'];
      if (setCookieHeaders) {
        setCookieHeaders.forEach(cookieStr => {
          const cookie = tough.Cookie.parse(cookieStr);
          if (cookie) {
            cookieJar.setCookie(cookie, 'https://open.spotify.com', (err) => {
              if (err) console.error('Error storing cookie:', err);
            });
          }
        });
      }
    });
  },
  onProxyRes: (proxyRes, req, res) => {
    // Skip modification for non-HTML or API responses
    if (!proxyRes.headers['content-type'] || 
        !proxyRes.headers['content-type'].includes('text/html')) {
      proxyRes.pipe(res);
      return;
    }
    
    createResponseModifier(proxyRes, req, res);
  },
  secure: false,
  logLevel: 'debug'
});

// Route all requests through our proxy
app.use('/', spotifyProxy);

// Add endpoint to check blocked patterns
app.get('/blocked-patterns', (req, res) => {
  res.json({
    domains: Array.from(adPatterns.domains),
    paths: Array.from(adPatterns.paths),
    keywords: adPatterns.keywords,
    lastUpdated: lastUpdated
  });
});

// Add endpoint to view current cookies
app.get('/cookies', (req, res) => {
  cookieJar.getCookies('https://open.spotify.com', (err, cookies) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get cookies' });
    }
    res.json(cookies.map(c => ({
      key: c.key,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      secure: c.secure,
      httpOnly: c.httpOnly
    })));
  });
});

// Start server with initial setup
loadCookies();
updateAdServers().then(() => {
  setInterval(updateAdServers, 6 * 60 * 60 * 1000);
  
  app.listen(PORT, () => {
    console.log(`\nSpotify Ad-Free Proxy running on http://localhost:${PORT}`);
    console.log(`Ad patterns will be refreshed every 6 hours`);
    console.log(`Access /blocked-patterns to view current blocking rules`);
    console.log(`Access /cookies to view current authentication cookies\n`);
  });
});