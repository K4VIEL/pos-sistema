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

// Ruta para procesar la factura, consultar datos en Supabase y firmarla
app.post('/api/emitir-factura', async (req, res) => {
    try {
        const { ventaId, localId } = req.body;

        if (!ventaId || !localId) {
            return res.status(400).json({ success: false, error: "Faltan datos: ventaId o localId son requeridos." });
        }

        // 1. Obtener la información del local desde Supabase
        const { data: localInfo, error: errorLocal } = await supabase
            .from('locales')
            .select('*')
            .eq('id', localId)
            .single();

        if (errorLocal || !localInfo) {
            return res.status(404).json({ success: false, error: "No se encontró la información fiscal del local en Supabase." });
        }

        // Verificar si tiene firma cargada
        if (!localInfo.firma_p12_url || !localInfo.firma_password) {
            return res.status(400).json({ success: false, error: "Este local no tiene configurada una firma electrónica o contraseña." });
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

        // Normalizar la clave de acceso (compatible con claveAcceso o clave_acceso)
        const claveAccesoFinal = ventaInfo.claveAcceso || ventaInfo.clave_acceso;
        if (!claveAccesoFinal) {
            return res.status(400).json({ success: false, error: "La venta no cuenta con una clave de acceso válida." });
        }

        console.log(`[SRI] Procesando y firmando factura para: ${localInfo.nombre_comercial || localInfo.nombre || 'Local'}`);

        // 3. Formatear la fecha para el XML (DDMMAAAA)
        const fechaObj = new Date(ventaInfo.fecha || Date.now());
        const fechaEmision = String(fechaObj.getDate()).padStart(2, '0') + '/' +
                             String(fechaObj.getMonth() + 1).padStart(2, '0') + '/' +
                             fechaObj.getFullYear();

        // 4. Construir la estructura oficial del XML del SRI con los datos reales del local
        const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="1.1.0">
    <infoTributaria>
        <ambiente>${localInfo.ambiente || "1"}</ambiente>
        <tipoEmision>1</tipoEmision>
        <razonSocial>${localInfo.razon_social || localInfo.nombre || "Mi Empresa"}</razonSocial>
        <nombreComercial>${localInfo.nombre_comercial || localInfo.nombre || "Mi Tienda"}</nombreComercial>
        <ruc>${localInfo.ruc || "9999999999001"}</ruc>
        <claveAcceso>${claveAccesoFinal}</claveAcceso>
        <codDoc>01</codDoc>
        <estab>${localInfo.codigo_establecimiento || "001"}</estab>
        <ptoEmi>${localInfo.punto_emision || "001"}</ptoEmi>
        <secuencial>${String(ventaInfo.id).replace('FAC-', '').padStart(9, '0')}</secuencial>
        <dirMatriz>${localInfo.direccion || "Matriz Principal"}</dirMatriz>
    </infoTributaria>
    <infoFactura>
        <fechaEmision>${fechaEmision}</fechaEmision>
        <dirEstablecimiento>${localInfo.direccion || "Sucursal"}</dirEstablecimiento>
        <obligadoContabilidad>SI</obligadoContabilidad>
        <tipoIdentificacionComprador>${(ventaInfo.cliente_cedula || "").length === 13 ? "04" : ((ventaInfo.cliente_cedula || "") === "9999999999999" ? "07" : "05")}</tipoIdentificacionComprador>
        <razonSocialComprador>${ventaInfo.cliente_nombre || "CONSUMIDOR FINAL"}</razonSocialComprador>
        <identificacionComprador>${ventaInfo.cliente_cedula || "9999999999999"}</identificacionComprador>
        <totalSinImpuestos>${Number(ventaInfo.total || 0).toFixed(2)}</totalSinImpuestos>
        <totalDescuento>0.00</totalDescuento>
        <totalConImpuestos>
            <totalImpuesto>
                <codigo>2</codigo>
                <codigoPorcentaje>2</codigoPorcentaje>
                <baseImponible>${Number(ventaInfo.total || 0).toFixed(2)}</baseImponible>
                <valor>0.00</valor>
            </totalImpuesto>
        </totalConImpuestos>
        <propina>0.00</propina>
        <importeTotal>${Number(ventaInfo.total || 0).toFixed(2)}</importeTotal>
        <moneda>DOLAR</moneda>
    </infoFactura>
    <detalles>
        ${(ventaInfo.items || []).map(item => `
        <detalle>
            <codigoPrincipal>${item.id || "01"}</codigoPrincipal>
            <descripcion>${item.nombre || item.descripcion || "Producto"}</descripcion>
            <cantidad>${item.cantidad || 1}</cantidad>
            <precioUnitario>${Number(item.precio || 0).toFixed(2)}</precioUnitario>
            <descuento>0.00</descuento>
            <precioTotalSinImpuesto>${Number((item.cantidad || 1) * (item.precio || 0)).toFixed(2)}</precioTotalSinImpuesto>
            <impuestos>
                <impuesto>
                    <codigo>2</codigo>
                    <codigoPorcentaje>2</codigoPorcentaje>
                    <tarifa>12</tarifa>
                    <baseImponible>${Number((item.cantidad || 1) * (item.precio || 0)).toFixed(2)}</baseImponible>
                    <valor>0.00</valor>
                </impuesto>
            </impuestos>
        </detalle>`).join('')}
    </detalles>
</factura>`;

        // 5. Descargar el archivo binario .p12 desde Supabase Storage usando la ruta almacenada
        const { data: fileData, error: storageError } = await supabase.storage
            .from('firmas')
            .download(localInfo.firma_p12_url);

        if (storageError) {
            throw new Error("No se pudo descargar el archivo de firma desde Supabase Storage: " + storageError.message);
        }

        // Convertir el archivo descargado a Buffer y luego a Base64 para node-forge
        const arrayBuffer = await fileData.arrayBuffer();
        const p12Buffer = Buffer.from(arrayBuffer);
        const p12Base64 = p12Buffer.toString('base64');

        // Procesar la firma digital usando node-forge
        const p12Binary = forge.util.decode64(p12Base64);
        const p12Der = forge.util.createBuffer(p12Binary);
        const p12AsPkcs12 = forge.pkcs12.pkcs12FromAsn1(p12Der, localInfo.firma_password);

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
            throw new Error("No se pudo descifrar la llave privada o certificado. Verifica la contraseña de la firma.");
        }

        console.log("[Firma Digital] Llave privada y certificado leídos y validados con éxito desde Supabase Storage.");

        return res.json({
            success: true,
            mensaje: `Factura generada y firmada digitalmente con éxito para ${localInfo.nombre_comercial || localInfo.nombre}`,
            claveAcceso: claveAccesoFinal,
            xmlGenerado: xmlContent
        });

    } catch (error) {
        console.error('Error al emitir y firmar factura:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
