const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- TES IDENTIFIANTS SCRAPINGBOT ---
const SCRAPINGBOT_EMAIL = 'ton-email-dinscription@gmail.com'; // ⚠️ REMPLACE CECI PAR TON EMAIL !
const SCRAPINGBOT_API_KEY = 'sb_57b2732fae04e22bc4337c26e31dd242a50cd4935353ff11299f64cdb8ebe6f8';
// ------------------------------------

app.use(cors());

// Sert ton fichier index.html à la racine
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route API appelée par ton frontend
app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL manquante' });
    }

    try {
        console.log(`[SCRAPE] Demande reçue pour : ${targetUrl}`);
        console.log(`[SCRAPE] Envoi de la requête POST sécurisée à ScrapingBot...`);

        // L'authentification ScrapingBot demande d'encoder "Email:ApiKey" en Base64
        const authHeader = 'Basic ' + Buffer.from(SCRAPINGBOT_EMAIL + ':' + SCRAPINGBOT_API_KEY).toString('base64');

        // Appel sécurisé en POST vers l'API Retail
        const response = await fetch('https://api.scrapingbot.io/scrape/retail', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify({
                url: targetUrl
            })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`ScrapingBot a rejeté la demande (${response.status}) : ${errText}`);
        }

        const json = await response.json();
        
        // ScrapingBot place souvent le résultat dans un objet "data"
        const product = json.data ? (Array.isArray(json.data) ? json.data[0] : json.data) : json;

        if (product) {
            // Formatage des données pour ton frontend
            const result = {
                title: product.title || '',
                shop: product.brand || product.siteName || guessShopFromUrl(targetUrl),
                image: product.image || product.imageUrl || (product.images && product.images.length > 0 ? product.images[0] : null),
                price: product.price || null,
                availability: (product.availability === 'Out of stock' || product.availability === 'Rupture') ? 'Rupture' : 'En stock'
            };

            console.log(`[SCRAPE] Succès ! Renvoi des données au frontend.`);
            return res.json(result);
        } else {
            throw new Error('Les données renvoyées par ScrapingBot sont vides.');
        }

    } catch (error) {
        console.error(`[SCRAPE] ERREUR :`, error.message);
        // On renvoie des données vides pour ne pas faire planter ton site
        return res.json({ title: '', shop: '', image: null, price: null, availability: 'Inconnue' });
    }
});

// Fonction de secours si la marque n'est pas détectée
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
