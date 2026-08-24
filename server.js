const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Habilitar CORS para cualquier origen (GitHub Pages, móvil, etc.)
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/api/sri/:identificacion', async (req, res) => {
    const { identificacion } = req.params;

    if (!identificacion) {
        return res.status(400).json({ error: 'Ingresa una cédula o RUC.' });
    }

    try {
        // Ajustar a formato RUC de 13 dígitos
        let ruc = identificacion.trim();
        if (ruc.length === 10) {
            ruc = ruc + '001';
        }

        // Consulta oficial al catastro público del SRI
        const urlSRI = `https://srierlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/existePorNumeroRuc?numeroRuc=${ruc}`;
        
        const response = await axios.get(urlSRI, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 8000
        });

        if (response.data && response.data.razonSocial) {
            return res.json({
                exito: true,
                razonSocial: response.data.razonSocial
            });
        }

        return res.status(404).json({ error: 'No se encontraron datos en el SRI.' });

    } catch (error) {
        console.error('Error al consultar SRI:', error.message);
        return res.status(500).json({ error: 'Cédula o RUC no encontrado en el SRI.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor SRI activo en puerto ${PORT}`);
});
