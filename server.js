const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Ta clé API ScrapingBot
const SCRAPINGBOT_API_KEY = 'sb_57b2732fae04e22bc4337c26e31dd242a50cd4935353ff11299f64cdb8ebe6f8';

// Autorise ton frontend (sur GitHub) à faire des requêtes vers ce backend (sur Render)
app.use(cors());

// Route API appelée par ton frontend
app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL manquante' });
    }

    try {
        console.log(`[SCRAPE] Demande reçue pour : ${targetUrl}`);
        console.log(`[SCRAPE] Interrogation de ScrapingBot...`);

        // Appel à l'API ScrapingBot (avec scraper=retail pour le e-commerce)
        const scrapeApiUrl = `https://api.scrapingbot.io/scrape?apiKey=${SCRAPINGBOT_API_KEY}&url=${encodeURIComponent(targetUrl)}&scraper=retail`;
        
        const response = await fetch(scrapeApiUrl);
        
        if (!response.ok) {
            throw new Error(`ScrapingBot a répondu avec le statut ${response.status}`);
        }

        const data = await response.json();

        // ScrapingBot peut renvoyer un tableau d'objets, on s'assure de prendre le premier élément
        const product = Array.isArray(data) ? data[0] : data;

        if (product) {
            // Mapping des données ScrapingBot vers ton format
            const result = {
                title: product.title || '',
                shop: product.brand || product.siteName || guessShopFromUrl(targetUrl),
                image: product.imageUrl || (product.images && product.images.length > 0 ? product.images[0] : null),
                price: product.price || null,
                availability: (product.availability === 'Out of stock' || product.availability === 'Rupture') ? 'Rupture' : 'En stock'
            };

            console.log(`[SCRAPE] Succès ! Renvoi des données au frontend.`);
            return res.json(result);
        } else {
            throw new Error('Données ScrapingBot invalides');
        }

    } catch (error) {
        console.error(`[SCRAPE] ERREUR :`, error.message);
        // On renvoie un objet vide avec la structure attendue pour ne pas faire planter le frontend
        return res.json({ title: '', shop: '', image: null, price: null, availability: 'Inconnue' });
    }
});

// Petite fonction de secours pour deviner la boutique si ScrapingBot ne trouve pas de marque
function guessShopFromUrl(urlString) {
    try {
        const u = new URL(urlString);
        let host = u.hostname.replace(/^www\./, '');
        const parts = host.split('.');
        let name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) {
        return '';
    }
}

app.listen(PORT, () => {
    console.log(`Serveur de scraping démarré sur le port ${PORT}`);
});
