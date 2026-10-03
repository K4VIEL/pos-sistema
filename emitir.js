'use strict';
/**
 * Orquestador: venta (Supabase) -> secuencial -> clave de acceso -> XML -> firma -> recepción -> autorización.
 * Es idempotente: reintentar una venta nunca consume un secuencial nuevo, salvo que el SRI la haya NO AUTORIZADO.
 */
const { generarClaveAcceso, construirFacturaXml } = require('./xml');
const { firmarFactura } = require('./firma');
const { extraerCredenciales } = require('./p12');
const { enviarRecepcion, consultarAutorizacion, xmlAutorizado } = require('./ws');
const { generarRidePdf } = require('./ride');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enProceso = new Set();
const AMBIENTES = { '1': 'PRUEBAS', '2': 'PRODUCCIÓN' };

const txtMensajes = (ms) => (ms || []).map((m) => `${m.identificador}: ${m.mensaje}${m.informacionAdicional ? ' – ' + m.informacionAdicional : ''}`);
function fechaRide(iso) {
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : (iso || '');
}

async function descargarP12(supabase, local) {
  let ruta = String(local.firma_p12_url).trim();
  if (ruta.includes('/storage/v1/object/public/firmas/')) ruta = ruta.split('/storage/v1/object/public/firmas/')[1];
  ruta = ruta.replace(/^\/+/, '');
  const { data, error } = await supabase.storage.from('firmas').download(ruta);
  if (error || !data) throw new Error('No se pudo descargar la firma de Supabase: ' + (error?.message || 'archivo no encontrado'));
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.toString('utf8', 0, 50).includes('<!DOCTYPE') || buf.toString('utf8', 0, 50).includes('"statusCode"')) {
    throw new Error(`La firma ('${ruta}') no existe en el bucket 'firmas' o la ruta es incorrecta.`);
  }
  return buf;
}

async function actualizarVenta(supabase, ventaId, campos) {
  const { error } = await supabase.from('ventas').update(campos).eq('id', ventaId);
  if (error) console.error(`[SRI] No se pudo actualizar la venta ${ventaId}:`, error.message, '(¿ejecutaste migracion.sql?)');
}

async function emitirFactura(supabase, { ventaId, localId }) {
  if (enProceso.has(ventaId)) return { success: false, estado: 'EN_PROCESO', retryable: true, message: 'Esta factura ya se está procesando, espera unos segundos.' };
  enProceso.add(ventaId);
  try { return await _emitir(supabase, { ventaId, localId }); }
  finally { enProceso.delete(ventaId); }
}

async function _emitir(supabase, { ventaId, localId }) {
  // 1) datos de la venta y del local
  const { data: venta } = await supabase.from('ventas').select('*').eq('id', ventaId).single();
  if (!venta) return { success: false, message: 'No se encontró la venta especificada.' };
  if (String(venta.local_id) !== String(localId)) return { success: false, message: 'La venta no pertenece a este local.' };
  if (['PEDIDO_WEB_DOMICILIO', 'PEDIDO_RECHAZADO', 'PEDIDO_APROBADO', 'NOTA_VENTA_LOCAL'].includes(venta.tipo_comprobante)) {
    return { success: false, message: 'Este documento no es una factura electrónica.' };
  }
  const { data: local } = await supabase.from('locales').select('*').eq('id', localId).single();
  if (!local) return { success: false, message: 'No se encontró la información fiscal del local.' };
  if (!local.firma_p12_url || !local.firma_password) return { success: false, message: 'Este local no tiene configurada una firma electrónica o contraseña.' };
  if (!/^\d{13}$/.test(String(local.ruc || '').trim())) return { success: false, message: 'El RUC del local debe tener 13 dígitos.' };

  const ambiente = String(local.sri_ambiente || process.env.SRI_AMBIENTE || '1');
  if (!AMBIENTES[ambiente]) return { success: false, message: 'Ambiente SRI inválido (1 = pruebas, 2 = producción).' };

  // 2) ¿ya existe un comprobante para esta venta?
  let { data: comp } = await supabase.from('comprobantes_sri').select('*').eq('venta_id', ventaId).maybeSingle();
  if (comp?.estado === 'AUTORIZADO') return respuestaAutorizada(venta, comp);
  if (comp?.estado === 'NO_AUTORIZADO') {   // clave "quemada": se archiva y se emite con secuencial nuevo
    await supabase.from('comprobantes_sri').update({ venta_id: `${ventaId}#ANT#${comp.clave_acceso}` }).eq('id', comp.id);
    comp = null;
  }

  const [estab, ptoEmi] = String(venta.punto_emision || '001-100').split('-').map((s) => s.padStart(3, '0'));
  const emisor = {
    ruc: String(local.ruc).trim(),
    razonSocial: local.razon_social || local.propietario || local.nombre,
    nombreComercial: local.nombre,
    dirMatriz: local.dir_matriz || local.direccion || 'S/N',
    dirEstablecimiento: local.direccion || local.dir_matriz || 'S/N',
    obligadoContabilidad: local.obligado_contabilidad === 'SI' ? 'SI' : 'NO',
    contribuyenteEspecial: local.contribuyente_especial || '',
    rimpe: local.rimpe === true,
    agenteRetencion: local.agente_retencion || ''
  };

  // 3) cliente (correo / teléfono para infoAdicional)
  let cli = null;
  if (venta.cliente_cedula) {
    const r = await supabase.from('clientes').select('*').eq('cedula', venta.cliente_cedula).eq('local_id', String(localId)).limit(1);
    cli = r.data && r.data[0];
  }
  const ivaDef = Number(local.iva_defecto ?? 0);
  const ventaDatos = {
    fecha: venta.fecha, items: (venta.items || []).map((i) => ({ ...i, iva: i.iva ?? ivaDef })),
    descuento: venta.descuento, propina: venta.propina, metodoPago: venta.metodo_pago, nota: venta.nota,
    clienteNombre: venta.cliente_nombre, clienteId: venta.cliente_cedula,
    clienteEmail: cli?.correo, clienteTelefono: cli?.telefono, clienteDireccion: cli?.direccion
  };

  // 4) secuencial + clave (solo si es la primera vez)
  let ctx;
  if (comp) {
    ctx = { ambiente: comp.ambiente, estab: comp.estab, ptoEmi: comp.pto_emi, secuencial: comp.secuencial, claveAcceso: comp.clave_acceso };
  } else {
    const { data: sec, error: errSec } = await supabase.rpc('siguiente_secuencial', { p_local_id: String(localId), p_estab: estab, p_pto_emi: ptoEmi, p_ambiente: ambiente, p_cod_doc: '01' });
    if (errSec || !sec) return { success: false, message: 'No se pudo obtener el secuencial (¿ejecutaste migracion.sql?): ' + (errSec?.message || '') };
    const secuencial = String(sec).padStart(9, '0');
    ctx = { ambiente, estab, ptoEmi, secuencial, claveAcceso: generarClaveAcceso({ fecha: venta.fecha, ruc: emisor.ruc, ambiente, estab, ptoEmi, secuencial }) };
  }
  ctx.preciosIncluyenIva = local.precios_incluyen_iva !== false;

  // 5) XML + firma. Si ya se envió antes (PENDIENTE/EN_PROCESO) se reutiliza el XML firmado tal cual.
  let xmlFirmado = comp && ['PENDIENTE', 'EN_PROCESO'].includes(comp.estado) ? comp.xml_firmado : null;
  let ride = comp?.ride_json || null;
  if (!xmlFirmado) {
    let gen;
    try { gen = construirFacturaXml(emisor, ventaDatos, ctx); } catch (e) { return { success: false, estado: 'ERROR_DATOS', message: e.message }; }
    let cred;
    try { cred = extraerCredenciales(await descargarP12(supabase, local), local.firma_password); } catch (e) { return { success: false, estado: 'ERROR_FIRMA', message: e.message }; }
    xmlFirmado = firmarFactura(gen.xml, cred);
    ride = {
      emisor, numero: `${ctx.estab}-${ctx.ptoEmi}-${ctx.secuencial}`, numeroAutorizacion: '', fechaAutorizacion: '', ambiente: AMBIENTES[ambiente],
      claveAcceso: ctx.claveAcceso, fechaEmision: gen.fechaEmision,
      comprador: { razon: gen.comprador.razon, id: gen.comprador.id, direccion: ventaDatos.clienteDireccion || '' },
      detalles: gen.calc.lineas.map((l) => ({ codigo: l.codigo, descripcion: l.nombre, cantidad: l.cantidad, precioUnit: l.precioUnit, descuento: l.descuento, total: l.base })),
      impuestos: gen.calc.impuestos, totalSinImpuestos: gen.calc.totalSinImpuestos, totalDescuento: gen.calc.totalDescuento,
      propina: gen.propina, importeTotal: gen.importeTotal,
      formaPago: ({ '01': 'SIN UTILIZACIÓN DEL SISTEMA FINANCIERO', '16': 'TARJETA DE DÉBITO', '19': 'TARJETA DE CRÉDITO', '20': 'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO' })[require('./xml').formaPagoSri(ventaDatos.metodoPago)],
      infoAdicional: [ventaDatos.clienteEmail && ventaDatos.clienteEmail !== 'S/C' ? ['Email', ventaDatos.clienteEmail] : null, ventaDatos.nota ? ['Observacion', ventaDatos.nota] : null].filter(Boolean)
    };
    const fila = { venta_id: ventaId, local_id: String(localId), clave_acceso: ctx.claveAcceso, ambiente, estab: ctx.estab, pto_emi: ctx.ptoEmi, secuencial: ctx.secuencial, estado: 'PENDIENTE', xml_firmado: xmlFirmado, ride_json: ride };
    if (comp) { await supabase.from('comprobantes_sri').update({ xml_firmado: xmlFirmado, ride_json: ride, estado: 'PENDIENTE' }).eq('id', comp.id); }
    else {
      const ins = await supabase.from('comprobantes_sri').insert([fila]).select().single();
      if (ins.error) return { success: false, message: 'No se pudo guardar el comprobante: ' + ins.error.message };
      comp = ins.data;
    }
    await actualizarVenta(supabase, ventaId, { clave_acceso: ctx.claveAcceso, numero_comprobante: ride.numero, estado_sri: 'PENDIENTE', tipo_comprobante: 'FACTURA_PENDIENTE_SRI' });
  }
  const guardar = (campos) => supabase.from('comprobantes_sri').update(campos).eq('clave_acceso', ctx.claveAcceso);

  // 6) recepción
  let mensajes = [];
  try {
    const rec = await enviarRecepcion(xmlFirmado, ctx.ambiente);
    mensajes = rec.mensajes;
    const yaRegistrada = rec.mensajes.some((m) => ['43', '70'].includes(String(m.identificador)));
    if (rec.estado === 'DEVUELTA' && !yaRegistrada) {
      await guardar({ estado: 'DEVUELTA', mensajes });
      await actualizarVenta(supabase, ventaId, { estado_sri: 'DEVUELTA' });
      return { success: false, estado: 'DEVUELTA', claveAcceso: ctx.claveAcceso, numeroComprobante: ride.numero, message: 'El SRI devolvió el comprobante: ' + txtMensajes(mensajes).join(' | '), mensajes: txtMensajes(mensajes) };
    }
  } catch (e) {
    await guardar({ estado: 'PENDIENTE', mensajes: [{ mensaje: e.message }] });
    return { success: false, estado: 'PENDIENTE', retryable: true, claveAcceso: ctx.claveAcceso, numeroComprobante: ride.numero, message: 'No se pudo contactar al SRI (' + e.message + '). Reintenta en unos minutos.' };
  }

  // 7) autorización (el SRI puede tardar unos segundos)
  let aut = { estado: 'SIN_RESPUESTA', mensajes: [] };
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 1000 : 2500);
    try { aut = await consultarAutorizacion(ctx.claveAcceso, ctx.ambiente); } catch (e) { aut = { estado: 'SIN_RESPUESTA', mensajes: [{ identificador: '', mensaje: e.message }] }; }
    if (aut.estado === 'AUTORIZADO' || aut.estado === 'NO AUTORIZADO') break;
  }

  if (aut.estado === 'AUTORIZADO') {
    const fecha = fechaRide(aut.fechaAutorizacion);
    ride = { ...ride, numeroAutorizacion: aut.numeroAutorizacion, fechaAutorizacion: fecha };
    await guardar({ estado: 'AUTORIZADO', numero_autorizacion: aut.numeroAutorizacion, fecha_autorizacion: aut.fechaAutorizacion, xml_autorizado: xmlAutorizado(aut), ride_json: ride, mensajes: aut.mensajes });
    await actualizarVenta(supabase, ventaId, { estado_sri: 'AUTORIZADO', tipo_comprobante: 'FACTURA', numero_autorizacion: aut.numeroAutorizacion, fecha_autorizacion: aut.fechaAutorizacion, numero_comprobante: ride.numero, clave_acceso: ctx.claveAcceso });
    return { success: true, estado: 'AUTORIZADO', mensaje: 'Factura autorizada por el SRI', claveAcceso: ctx.claveAcceso, numeroComprobante: ride.numero, numeroAutorizacion: aut.numeroAutorizacion, fechaAutorizacion: aut.fechaAutorizacion, ambiente: AMBIENTES[ctx.ambiente], mensajes: txtMensajes(aut.mensajes) };
  }
  if (aut.estado === 'NO AUTORIZADO') {
    await guardar({ estado: 'NO_AUTORIZADO', mensajes: aut.mensajes });
    await actualizarVenta(supabase, ventaId, { estado_sri: 'RECHAZADO' });
    return { success: false, estado: 'RECHAZADO', claveAcceso: ctx.claveAcceso, numeroComprobante: ride.numero, message: 'El SRI NO autorizó la factura: ' + txtMensajes(aut.mensajes).join(' | '), mensajes: txtMensajes(aut.mensajes) };
  }
  await guardar({ estado: 'EN_PROCESO' });
  await actualizarVenta(supabase, ventaId, { estado_sri: 'EN_PROCESO' });
  return { success: false, estado: 'EN_PROCESO', retryable: true, claveAcceso: ctx.claveAcceso, numeroComprobante: ride.numero, message: 'El SRI aún está procesando el comprobante. Vuelve a intentarlo en un momento.' };
}

function respuestaAutorizada(venta, comp) {
  return { success: true, estado: 'AUTORIZADO', mensaje: 'Factura ya autorizada', claveAcceso: comp.clave_acceso, numeroComprobante: `${comp.estab}-${comp.pto_emi}-${comp.secuencial}`, numeroAutorizacion: comp.numero_autorizacion, fechaAutorizacion: comp.fecha_autorizacion, ambiente: AMBIENTES[comp.ambiente] };
}

/** Descarga por clave de acceso. tipo: 'xml' | 'ride' */
async function obtenerArchivo(supabase, claveAcceso, tipo) {
  if (!/^\d{49}$/.test(claveAcceso)) return null;
  const { data: comp } = await supabase.from('comprobantes_sri').select('*').eq('clave_acceso', claveAcceso).maybeSingle();
  if (!comp) return null;
  if (tipo === 'xml') return { contentType: 'application/xml; charset=utf-8', filename: `${claveAcceso}.xml`, body: Buffer.from(comp.xml_autorizado || comp.xml_firmado, 'utf8') };
  return { contentType: 'application/pdf', filename: `RIDE-${comp.estab}-${comp.pto_emi}-${comp.secuencial}.pdf`, body: await generarRidePdf(comp.ride_json) };
}

module.exports = { emitirFactura, obtenerArchivo };
