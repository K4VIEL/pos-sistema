const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/api/sri/:identificacion', (req, res) => {
    const { identificacion } = req.params;

    if (!identificacion) {
        return res.status(400).json({ error: 'Ingresa una cédula o RUC.' });
    }

    const id = identificacion.trim();
    const ruc = id.length === 10 ? id + '001' : id;

    const options = {
        hostname: 'srienlinea.sri.gob.ec',
        path: `/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNumerosRuc?ruc=${ruc}`,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json, text/plain, */*'
        },
        rejectUnauthorized: false
    };

    const request = https.request(options, (response) => {
        let data = '';

        response.on('data', (chunk) => { data += chunk; });

        response.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].razonSocial) {
                    return res.json({
                        exito: true,
                        razonSocial: parsed[0].razonSocial
                    });
                } else {
                    return res.status(404).json({ error: 'No se encontraron datos en el SRI para esta identificación.' });
                }
            } catch (err) {
                return res.status(404).json({ error: 'Número no encontrado en los registros del SRI.' });
            }
        });
    });

    request.on('error', () => {
        return res.status(500).json({ error: 'Error al conectar con el SRI.' });
    });

    request.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});
