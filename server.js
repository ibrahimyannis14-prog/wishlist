const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/', (req, res) => {
  res.send('✅ Le moteur de Scraping est en ligne et prêt à recevoir des liens !');
});

// Nettoyage de prix ultra-robuste
function cleanPrice(raw) {
  if (!raw) return null;
  let str = String(raw).trim();
  
  // Enlever les espaces insécables et monnaies
  str = str.replace(/&nbsp;/gi, ' ').replace(/[€$£a-zA-Z]/g, '').trim();
  
  // Transformation du format "299 99" en "299.99"
  str = str.replace(/(\d+)\s+(\d{2})$/, '$1.$2');
  
  // Format classique européen vers américain
  str = str.replace(',', '.');
  
  // Tout ce qui n'est pas chiffre ou point dégage
  str = str.replace(/[^\d.]/g, '');
  
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

function normalizeAvailability(raw) {
  if (!raw) return null;
  const a = String(raw).toLowerCase();
  if (a.includes('outofstock') || a.includes('out_of_stock') || a.includes('soldout') || a.includes('rupture')) return 'Rupture';
  return 'En stock'; 
}

function guessShopFromHost(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length > 2 ? parts[parts.length - 2].charAt(0).toUpperCase() + parts[parts.length - 2].slice(1) : parts[0];
  } catch (e) { return null; }
}

function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try { return new URL(maybeRelative, baseUrl).href; } catch (e) { return null; }
}

function parseHTML(html, targetUrl) {
  const $ = cheerio.load(html);
  let title = null, image = null, jsonPrice = null, metaPrice = null, htmlPrice = null, availability = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(parsed) ? parsed : Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
      nodes.forEach(node => {
        if (!node || typeof node !== 'object') return;
        const type = node['@type'];
        if (type !== 'Product' && (!Array.isArray(type) || !type.includes('Product'))) return;

        if (!title && node.name) title = node.name;
        if (!image && node.image) {
          const img = Array.isArray(node.image) ? node.image[0] : node.image;
          image = typeof img === 'object' ? img.url : img;
        }

        let offers = node.offers;
        if (offers) {
          if (Array.isArray(offers)) offers = offers[0];
          if (typeof offers === 'object') {
            if (jsonPrice === null) jsonPrice = offers.price ?? offers.lowPrice ?? null;
            if (!availability) availability = offers.availability || null;
          }
        }
      });
    } catch (e) {}
  });

  const meta = (name) => $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
  if (!title) title = meta('og:title') || $('title').first().text() || null;
  if (!image) image = meta('og:image') || meta('twitter:image') || null;
  
  metaPrice = meta('og:price:amount') || meta('product:price:amount') || $('[itemprop="price"]').attr('content') || null;
  if (!availability) availability = meta('og:availability') || meta('product:availability') || null;

  const priceSelectors = ['.price', '.product-price', '.current-price', '.price-value', '[data-price]', '#price', '.price__current', '.price-sale'];
  for (const sel of priceSelectors) {
    const el = $(sel).first();
    const val = el.attr('content') || el.attr('data-price') || el.text();
    const cleaned = cleanPrice(val);
    if (cleaned !== null) { htmlPrice = cleaned; break; }
  }

  let validPrices = [cleanPrice(jsonPrice), cleanPrice(metaPrice), htmlPrice].filter(p => p !== null && p > 0);
  let finalPrice = validPrices.length > 0 ? Math.min(...validPrices) : null;

  return {
    shop: meta('og:site_name') || guessShopFromHost(targetUrl),
    title: title,
    image: resolveUrl(image, targetUrl),
    price: finalPrice,
    availability: normalizeAvailability(availability)
  };
}

async function scrapeWithFetch(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); 

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (!response.ok) throw new Error(`Status ${response.status}`);
    const html = await response.text();
    return parseHTML(html, targetUrl);
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeWithPuppeteer(targetUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: "new", 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    const html = await page.content();
    return parseHTML(html, targetUrl);
  } catch (error) {
    console.error(`Erreur Puppeteer détaillée: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/api/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL manquante.' });

  try {
    let data = await scrapeWithFetch(url);
    if (!data.price || !data.image) data = await scrapeWithPuppeteer(url);
    res.json(data);
  } catch (err) {
    try {
      const data = await scrapeWithPuppeteer(url);
      res.json(data);
    } catch (puppeteerErr) {
      res.status(502).json({ error: "Impossible d'extraire les données." });
    }
  }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
