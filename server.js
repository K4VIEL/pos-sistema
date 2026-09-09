const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const forge = require('node-forge');

const app = express();

// Seguridad de Cabeceras HTTP
app.use(helmet({
    contentSecurityPolicy: false, // Permite la carga de scripts externos necesarios (Supabase, librerías de QR, etc.)
}));

// Limitador de peticiones para prevenir ataques de fuerza bruta / saturación
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // Límite de peticiones por IP
    message: "Demasiadas peticiones desde esta IP, intenta más tarde."
});
app.use('/api/', limiter);

// CORS restrictivo para tus subdominios oficiales y entorno de Render
const allowedOrigins = ['https://app.multi-servicios.net', 'https://pedidos.multi-servicios.net'];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.includes('onrender.com')) {
            callback(null, true);
        } else {
            callback(new Error('Bloqueado por política CORS de seguridad'));
        }
    }
}));

app.use(express.json());

// Servir archivos estáticos del Frontend (index.html, assets, etc.)
app.use(express.static(path.join(__dirname)));

// Ruta raíz para solucionar el error "Cannot GET /" y cargar la app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/emitir-factura', async (req, res) => {
    try {
        const { ventaId, localId } = req.body;

        if (!ventaId || !localId) {
            return res.status(400).json({ success: false, message: "Faltan datos: ventaId o localId son requeridos." });
        }

        const { data: localInfo, error: errorLocal } = await supabase
            .from('locales')
            .select('*')
            .eq('id', localId)
            .single();

        if (errorLocal || !localInfo) {
            return res.json({ success: false, message: "No se encontró la información fiscal del local en Supabase." });
        }

        if (!localInfo.firma_p12_url || !localInfo.firma_password) {
            return res.json({ success: false, message: "Este local no tiene configurada una firma electrónica o contraseña." });
        }

        const { data: ventaInfo, error: errorVenta } = await supabase
            .from('ventas')
            .select('*')
            .eq('id', ventaId)
            .single();

        if (errorVenta || !ventaInfo) {
            return res.json({ success: false, message: "No se encontró la venta especificada." });
        }

        const claveAccesoFinal = ventaInfo.claveAcceso || ventaInfo.clave_acceso;
        if (!claveAccesoFinal) {
            return res.json({ success: false, message: "La venta no cuenta con una clave de acceso válida." });
        }

        let rutaFirma = localInfo.firma_p12_url.trim();
        if (rutaFirma.includes('/storage/v1/object/public/firmas/')) {
            rutaFirma = rutaFirma.split('/storage/v1/object/public/firmas/')[1];
        }
        rutaFirma = rutaFirma.replace(/^\/+/, '');

        const { data: fileData, error: storageError } = await supabase.storage
            .from('firmas')
            .download(rutaFirma);

        if (storageError || !fileData) {
            return res.json({ success: false, message: "Error al descargar la firma de Supabase: " + (storageError?.message || 'Archivo no encontrado') });
        }

        const arrayBuffer = await fileData.arrayBuffer();
        const p12Buffer = Buffer.from(arrayBuffer);

        const contenidoTexto = p12Buffer.toString('utf8', 0, 50);
        if (contenidoTexto.includes('<!DOCTYPE html>') || contenidoTexto.includes('{"statusCode":404')) {
            return res.json({ success: false, message: `El archivo en Supabase Storage ('${rutaFirma}') no existe o la ruta es incorrecta.` });
        }

        const p12Base64 = p12Buffer.toString('base64');
        const p12Binary = forge.util.decode64(p12Base64);
        const p12Der = forge.util.createBuffer(p12Binary);

        let p12AsPkcs12;
        try {
            p12AsPkcs12 = forge.pkcs12.pkcs12FromAsn1(p12Der, localInfo.firma_password);
        } catch (err) {
            return res.json({ success: false, message: "Contraseña de la firma incorrecta o archivo .p12 dañado: " + err.message });
        }

        let privateKey = null;
        let certificate = null;

        for (const safeBag of p12AsPkcs12.safeBags) {
            if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
                privateKey = safeBag.key || forge.pki.privateKeyToAsn1(safeBag.pkcs8);
            } else if (safeBag.type === forge.pki.oids.certBag) {
                certificate = safeBag.cert;
            }
        }

        if (!privateKey || !certificate) {
            return res.json({ success: false, message: "No se pudo extraer la llave privada del certificado .p12." });
        }

        return res.json({
            success: true,
            mensaje: "Factura firmada con éxito",
            claveAcceso: claveAccesoFinal
        });

    } catch (error) {
        console.error('Error al emitir y firmar factura:', error);
        return res.json({ success: false, message: error.message });
    }
});

const SUPABASE_URL = 'https://ycwuzqjwmzhynhjawnqd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inljd3V6cWp3bXpoeW5oamF3bnFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNzUyNjQsImV4cCI6MjEwMjc1MTI2NH0.AuU9Us6BdYDTy2np4iJY9ltCFicVbIUtQ4D7FNDgIfM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor seguro corriendo en el puerto ${PORT}`);
});
