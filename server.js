const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'liste-vetements.html'));
});

// ---------- Utilitaires de nettoyage ----------
function cleanPrice(raw) {
  if (raw === null || raw === undefined) return null;
  let str = String(raw).trim();

  // 1. Remplace les espaces HTML invisibles
  str = str.replace(/&nbsp;/gi, ' ');
  
  // 2. Gère les formats où l'espace agit comme une virgule décimale (ex: "299 99 €")
  str = str.replace(/(\d+)[\s\u00A0\u202F\u200B]+(\d{2})(?:[\s€£$]*)$/i, '$1.$2');

  // 3. Nettoie tout le reste (garde uniquement les chiffres, points, virgules et tirets)
  str = str.replace(/[^\d,.\-]/g, '');
  if (!str) return null;

  // 4. Conversion propre selon si c'est un point ou une virgule
  if (str.includes(',') && str.includes('.')) {
    str = str.lastIndexOf(',') > str.lastIndexOf('.')
      ? str.replace(/\./g, '').replace(',', '.')
      : str.replace(/,/g, '');
  } else if (str.includes(',')) {
    str = str.replace(/,/g, '.');
  }
  
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
    const name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch (e) { return null; }
}

function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try { return new URL(maybeRelative, baseUrl).href; }
  catch (e) { return null; }
}

// ---------- Logique d'extraction (Cheerio) ----------
function parseHTML(html, targetUrl) {
  const $ = cheerio.load(html);
  let title = null, image = null, jsonPrice = null, metaPrice = null, htmlPrice = null, currency = null, availability = null;

  // 1. JSON-LD (Souvent en centimes sur certains sites, ex: 29999)
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
            if (!currency) currency = offers.priceCurrency || null;
            if (!availability) availability = offers.availability || null;
          }
        }
      });
    } catch (e) {}
  });

  // 2. Meta tags
  const meta = (name) => $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
  if (!title) title = meta('og:title') || $('title').first().text() || null;
  if (!image) image = meta('og:image') || meta('twitter:image') || null;
  const siteName = meta('og:site_name') || null;
  
  metaPrice = meta('og:price:amount') || meta('product:price:amount') || $('[itemprop="price"]').attr('content') || null;
  if (!currency) currency = meta('og:price:currency') || meta('product:price:currency') || null;
  if (!availability) availability = meta('og:availability') || meta('product:availability') || null;

  // 3. HTML visuel (Le prix réellement affiché à l'écran)
  const priceSelectors = [
    '.price', '.product-price', '.current-price', '.price-value',
    '[data-price]', '#price', '.price__current', '.price-sale',
    '[data-test="product-price"]', '.css-11s12ax', '.css-b9fpep'
  ];
  for (const sel of priceSelectors) {
    const el = $(sel).first();
    const val = el.attr('content') || el.attr('data-price') || el.text();
    const cleaned = cleanPrice(val);
    if (cleaned !== null) {
      htmlPrice = cleaned;
      break;
    }
  }

  // LOGIQUE DE SÉLECTION DU PRIX FINAL (Fix pour les centimes)
  let validPrices = [cleanPrice(jsonPrice), cleanPrice(metaPrice), htmlPrice].filter(p => p !== null && p > 0);
  let finalPrice = null;
  
  if (validPrices.length > 0) {
    let minP = Math.min(...validPrices);
    let maxP = Math.max(...validPrices);
    
    // Si un prix est exactement 100x plus grand, c'est l'anomalie des centimes. On garde le petit.
    if (maxP === minP * 100) {
      finalPrice = minP;
    } else {
      // Sinon, on priorise le prix vu par l'humain (HTML), puis Meta, puis JSON
      finalPrice = htmlPrice !== null ? htmlPrice : (cleanPrice(metaPrice) !== null ? cleanPrice(metaPrice) : cleanPrice(jsonPrice));
    }
  }

  return {
    shop: siteName || guessShopFromHost(targetUrl) || new URL(targetUrl).hostname,
    title: title,
    image: resolveUrl(image, targetUrl),
    price: finalPrice,
    currency: currency || 'EUR',
    availability: normalizeAvailability(availability),
    sourceUrl: targetUrl,
  };
}

// ---------- Stratégie 1 : FETCH SIMPLE ----------
async function scrapeWithFetch(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); 

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`Status ${response.status}`);
    const html = await response.text();
    return parseHTML(html, targetUrl);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- Stratégie 2 : PUPPETEER ----------
async function scrapeWithPuppeteer(targetUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: "new", 
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    
    const html = await page.content();
    return parseHTML(html, targetUrl);
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/api/scrape', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'Paramètre "url" manquant.' });
  try { new URL(url); } catch (e) { return res.status(400).json({ error: 'URL invalide.' }); }

  try {
    console.log(`[SCRAPE] Tentative FETCH sur : ${url}`);
    let data = await scrapeWithFetch(url);

    if (!data.price || !data.image) {
      console.log(`[SCRAPE] Données incomplètes via Fetch. Passage à PUPPETEER...`);
      data = await scrapeWithPuppeteer(url);
    }
    
    res.json(data);
  } catch (err) {
    console.log(`[SCRAPE] Échec FETCH (${err.message}). Passage à PUPPETEER...`);
    try {
      const data = await scrapeWithPuppeteer(url);
      res.json(data);
    } catch (puppeteerErr) {
      console.error(`[SCRAPE] Échec total pour ${url} :`, puppeteerErr.message);
      res.status(502).json({ error: "Impossible d'extraire les données du site." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur prêt : http://localhost:${PORT}`);
  console.log(`🔄 Scraping actif : Fetch rapide -> Repli automatique sur Puppeteer`);
});