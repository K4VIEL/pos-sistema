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
            .select('*')
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

        console.log(`[SRI] Procesando factura para el local: ${localInfo.nombre_comercial || localInfo.nombre} (Punto: ${localInfo.punto_emision})`);

        // 3. Formatear la fecha para el XML (DDMMAAAA)
        const fechaObj = new Date(ventaInfo.fecha);
        const fechaEmision = String(fechaObj.getDate()).padStart(2, '0') + '/' +
                             String(fechaObj.getMonth() + 1).padStart(2, '0') + '/' +
                             fechaObj.getFullYear();

        // 4. Construir la estructura oficial del XML del SRI
        const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="1.1.0">
    <infoTributaria>
        <ambiente>${localInfo.ambiente || "1"}</ambiente>
        <tipoEmision>1</tipoEmision>
        <razonSocial>${localInfo.razon_social || localInfo.nombre || "Mi Empresa"}</razonSocial>
        <nombreComercial>${localInfo.nombre_comercial || localInfo.nombre || "Mi Tienda"}</nombreComercial>
        <ruc>${localInfo.ruc || "1792123456001"}</ruc>
        <claveAcceso>${ventaInfo.claveAcceso}</claveAcceso>
        <codDoc>01</codDoc>
        <estab>${localInfo.codigo_establecimiento || "001"}</estab>
        <ptoEmi>${localInfo.punto_emision || "002"}</ptoEmi>
        <secuencial>${String(ventaInfo.id).replace('FAC-', '').padStart(9, '0')}</secuencial>
        <dirMatriz>${localInfo.direccion || "Matriz Principal"}</dirMatriz>
    </infoTributaria>
    <infoFactura>
        <fechaEmision>${fechaEmision}</fechaEmision>
        <dirEstablecimiento>${localInfo.direccion || "Sucursal"}</dirEstablecimiento>
        <obligadoContabilidad>SI</obligadoContabilidad>
        <tipoIdentificacionComprador>${ventaInfo.cliente_cedula.length === 13 ? "04" : (ventaInfo.cliente_cedula === "9999999999999" ? "07" : "05")}</tipoIdentificacionComprador>
        <razonSocialComprador>${ventaInfo.cliente_nombre}</razonSocialComprador>
        <identificacionComprador>${ventaInfo.cliente_cedula}</identificacionComprador>
        <totalSinImpuestos>${ventaInfo.total.toFixed(2)}</totalSinImpuestos>
        <totalDescuento>0.00</totalDescuento>
        <totalConImpuestos>
            <totalImpuesto>
                <codigo>2</codigo>
                <codigoPorcentaje>2</codigoPorcentaje>
                <baseImponible>${ventaInfo.total.toFixed(2)}</baseImponible>
                <valor>0.00</valor>
            </totalImpuesto>
        </totalConImpuestos>
        <propina>0.00</propina>
        <importeTotal>${ventaInfo.total.toFixed(2)}</importeTotal>
        <moneda>DOLAR</moneda>
    </infoFactura>
    <detalles>
        ${(ventaInfo.items || []).map(item => `
        <detalle>
            <codigoPrincipal>${item.id}</codigoPrincipal>
            <descripcion>${item.nombre || item.descripcion || "Producto"}</descripcion>
            <cantidad>${item.cantidad}</cantidad>
            <precioUnitario>${item.precio.toFixed(2)}</precioUnitario>
            <descuento>0.00</descuento>
            <precioTotalSinImpuesto>${(item.cantidad * item.precio).toFixed(2)}</precioTotalSinImpuesto>
            <impuestos>
                <impuesto>
                    <codigo>2</codigo>
                    <codigoPorcentaje>2</codigoPorcentaje>
                    <tarifa>12</tarifa>
                    <baseImponible>${(item.cantidad * item.precio).toFixed(2)}</baseImponible>
                    <valor>0.00</valor>
                </impuesto>
            </impuestos>
        </detalle>`).join('')}
    </detalles>
</factura>`;

        return res.json({
            success: true,
            mensaje: `XML generado con éxito para el local ${localInfo.nombre_comercial || localInfo.nombre}`,
            claveAcceso: ventaInfo.claveAcceso,
            xmlGenerado: xmlContent
        });

    } catch (error) {
        console.error('Error al emitir factura y generar XML:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});
