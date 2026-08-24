const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Configuración de CORS para permitir peticiones desde cualquier origen (GitHub Pages, celular, etc.)
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/api/sri/:identificacion', async (req, res) => {
    const { identificacion } = req.params;

    if (!identificacion) {
        return res.status(400).json({ error: 'Ingresa una cédula o RUC.' });
    }

    try {
        // Aseguramos formato de 13 dígitos para la consulta de RUC
        let ruc = identificacion.length === 10 ? identificacion + '001' : identificacion;

        const response = await axios.get(`https://aggregator.cipherbyte.ec/company/${ruc}`, { timeout: 6000 });

        if (response.data && response.data.razonSocial) {
            return res.json({
                exito: true,
                razonSocial: response.data.razonSocial
            });
        }

        return res.status(404).json({ error: 'RUC no encontrado.' });
    } catch (error) {
        return res.status(404).json({ error: 'Cédula o RUC no encontrado.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor SRI activo en puerto ${PORT}`);
});
