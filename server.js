const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const forge = require('node-forge');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = 'https://ycwuzqjwmzhynhjawnqd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inljd3V6cWp3bXpoeW5oamF3bnFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNzUyNjQsImV4cCI6MjEwMjc1MTI2NH0.AuU9Us6BdYDTy2np4iJY9ltCFicVbIUtQ4D7FNDgIfM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.post('/api/emitir-factura', async (req, res) => {
    try {
        const { ventaId, localId } = req.body;

        if (!ventaId || !localId) {
            return res.status(400).json({ success: false, message: "Faltan datos: ventaId o localId son requeridos." });
        }

        // 1. Obtener la información del local desde Supabase
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

        // 2. Obtener los detalles de la venta desde Supabase
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

        console.log(`[SRI] Procesando factura para: ${localInfo.nombre || 'Local'}`);

        // 3. Descargar el archivo .p12 desde Supabase Storage
        let rutaFirma = localInfo.firma_p12_url.trim();
        // Si por error guardaron la URL completa, extraemos solo la ruta interna del bucket
        if (rutaFirma.includes('/storage/v1/object/public/firmas/')) {
            rutaFirma = rutaFirma.split('/storage/v1/object/public/firmas/')[1];
        }

        const { data: fileData, error: storageError } = await supabase.storage
            .from('firmas')
            .download(rutaFirma);

        if (storageError || !fileData) {
            throw new Error("No se pudo descargar el archivo de firma desde Supabase Storage: " + (storageError?.message || 'Archivo vacio'));
        }

        // Convertir Blob a Buffer de Node.js de forma segura
        const arrayBuffer = await fileData.arrayBuffer();
        const p12Buffer = Buffer.from(arrayBuffer);

        // Validar que el archivo comience con la cabecera PKCS#12 binaria (30 82 o formato ASN.1)
        if (p12Buffer.length < 10) {
            throw new Error("El archivo de firma descargado está vacío o corrupto.");
        }

        const p12Base64 = p12Buffer.toString('base64');
        const p12Binary = forge.util.decode64(p12Base64);
        const p12Der = forge.util.createBuffer(p12Binary);

        let p12AsPkcs12;
        try {
            p12AsPkcs12 = forge.pkcs12.pkcs12FromAsn1(p12Der, localInfo.firma_password);
        } catch (err) {
            throw new Error("Contraseña de firma incorrecta o archivo .p12 inválido: " + err.message);
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
            throw new Error("No se pudo extraer la llave privada del certificado .p12.");
        }

        console.log("[Firma Digital] Certificado validado y listo.");

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
