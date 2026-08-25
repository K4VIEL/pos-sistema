const forge = require('node-forge');
const express = require('express');
const cors = require('cors');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// Conexión a Supabase usando las variables de entorno
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 1. Ruta para buscar contribuyentes en el SRI (RUC / Cédula)
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

// 2. Ruta para procesar la factura y consultar datos en Supabase
app.post('/api/emitir-factura', async (req, res) => {
    try {
        const { ventaId, localId } = req.body;

        if (!ventaId || !localId) {
            return res.status(400).json({ success: false, error: "Faltan datos: ventaId o localId son requeridos." });
        }

        // 1. Obtener la información del local desde Supabase
        const { data: localInfo, error: errorLocal } = await supabase
            .from('locales')
            .select('nombre_comercial, codigo_establecimiento, punto_emision, firma_p12_url, firma_password')
            .eq('id', localId)
            .single();

        if (errorLocal || !localInfo) {
            return res.status(404).json({ success: false, error: "No se encontró la información fiscal del local." });
        }

        // 2. Obtener los detalles de la venta desde Supabase
        const { data: ventaInfo, error: errorVenta } = await supabase
            .from('ventas')
            .select('*')
            .eq('id', ventaId)
            .single();

        if (errorVenta || !ventaInfo) {
            return res.status(404).json({ success: false, error: "No se encontró la venta especificada." });
        }

        console.log(`[SRI] Procesando factura para el local: ${localInfo.nombre_comercial} (Punto: ${localInfo.punto_emision})`);

        return res.json({
            success: true,
            mensaje: `Factura procesada con éxito para el local ${localInfo.nombre_comercial}`,
            establecimiento: localInfo.codigo_establecimiento || '001',
            puntoEmision: localInfo.punto_emision || '100',
            estadoSri: "AUTORIZADO_PRUEBA"
        });

    } catch (error) {
        console.error('Error al emitir factura:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});
