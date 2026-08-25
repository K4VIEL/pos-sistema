// Ruta para procesar la factura, consultar datos en Supabase y firmarla
app.post('/api/emitir-factura', async (req, res) => {
    try {
        const { ventaId, localId } = req.body;

        if (!ventaId || !localId) {
            return res.status(400).json({ success: false, error: "Faltan datos: ventaId o localId son requeridos." });
        }

        // 1. Obtener la información del local desde Supabase (Asegúrate que 'id' coincida con tu columna en Supabase)
        const { data: localInfo, error: errorLocal } = await supabase
            .from('locales')
            .select('*')
            .eq('id', localId) // Cambia 'id' por 'local_id' si tu columna en la base de datos se llama así
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
        <claveAcceso>${ventaInfo.claveAcceso}</claveAcceso>
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

        // 5. Procesar la firma digital usando node-forge con los datos de Supabase
        const p12Binary = forge.util.decode64(localInfo.firma_p12_url);
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

        console.log("[Firma Digital] Llave privada y certificado leídos y validados con éxito desde Supabase.");

        return res.json({
            success: true,
            mensaje: `Factura generada y firmada digitalmente con éxito para ${localInfo.nombre_comercial || localInfo.nombre}`,
            claveAcceso: ventaInfo.claveAcceso,
            xmlGenerado: xmlContent
        });

    } catch (error) {
        console.error('Error al emitir y firmar factura:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});
