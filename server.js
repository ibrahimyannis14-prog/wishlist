const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Autorise ton frontend à faire des requêtes vers ce backend
app.use(cors());

// Route principale appelée par ton frontend
app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL manquante' });
    }

    try {
        console.log(`[SCRAPE] Demande reçue pour : ${targetUrl}`);
        console.log(`[SCRAPE] Interrogation de Microlink...`);

        // Appel à l'API gratuite de Microlink
        const microlinkUrl = `https://api.microlink.io?url=${encodeURIComponent(targetUrl)}`;
        
        // Utilisation du fetch natif de Node.js (nécessite Node 18+)
        const response = await fetch(microlinkUrl);
        
        if (!response.ok) {
            throw new Error(`Microlink a répondu avec le statut ${response.status}`);
        }

        const json = await response.json();

        if (json.status === 'success' && json.data) {
            const data = json.data;
            
            // Formatage des données exactement comme ton frontend les attend
            const result = {
                title: data.title || '',
                shop: data.publisher || guessShopFromUrl(targetUrl),
                image: data.image ? data.image.url : null,
                price: null, // Microlink ne garantit pas le prix
                availability: 'Inconnue'
            };

            console.log(`[SCRAPE] Succès ! Renvoi des données au frontend.`);
            return res.json(result);
        } else {
            throw new Error('Données Microlink invalides ou inexploitables');
        }

    } catch (error) {
        console.error(`[SCRAPE] ERREUR :`, error.message);
        // On renvoie un objet vide pour ne pas faire planter le frontend
        return res.json({ title: '', shop: '', image: null, price: null });
    }
});

// Petite fonction de secours pour deviner la boutique si Microlink ne la trouve pas
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
