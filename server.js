const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPINGBOT_API_KEY = 'sb_57b2732fae04e22bc4337c26e31dd242a50cd4935353ff11299f64cdb8ebe6f8';

app.use(cors());

app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL manquante' });
    }

    try {
        console.log(`[SCRAPE] Demande reçue pour : ${targetUrl}`);

        // Utilisation de ScrapingBot avec le mode 'retail' pour le shopping
        const scrapeApiUrl = `https://api.scrapingbot.io/scrape?apiKey=${SCRAPINGBOT_API_KEY}&url=${encodeURIComponent(targetUrl)}&scraper=retail`;
        
        const response = await fetch(scrapeApiUrl);
        const data = await response.json();

        // ScrapingBot renvoie un tableau d'objets, on prend le premier
        const product = Array.isArray(data) ? data[0] : data;

        // On mappe les données de ScrapingBot vers ton format
        const result = {
            title: product.title || '',
            shop: product.brand || guessShopFromUrl(targetUrl),
            image: product.imageUrl || product.images?.[0] || null,
            price: product.price || null,
            availability: product.availability || 'Inconnue'
        };

        console.log(`[SCRAPE] Succès via ScrapingBot.`);
        return res.json(result);

    } catch (error) {
        console.error(`[SCRAPE] ERREUR :`, error.message);
        return res.json({ title: '', shop: '', image: null, price: null, availability: 'Inconnue' });
    }
});

function guessShopFromUrl(urlString) {
    try {
        const u = new URL(urlString);
        let host = u.hostname.replace(/^www\./, '');
        const parts = host.split('.');
        let name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) { return ''; }
}

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});
