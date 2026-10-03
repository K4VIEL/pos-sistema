'use strict';
/**
 * Generación de la factura electrónica (XML v1.1.0) y de la clave de acceso.
 * El XML se arma SIN espacios entre etiquetas y SIN etiquetas auto-cerradas, de modo
 * que ya está en forma canónica (C14N) y la firma digital sea determinística.
 */

// ---------- utilidades ----------
const esc = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/\r?\n|\t/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const f2 = (n) => r2(n).toFixed(2);
const fN = (n, d = 6) => {
  // cantidad / precio unitario: hasta 6 decimales, mínimo 2
  let s = Number(n).toFixed(d).replace(/0+$/, '');
  const dec = (s.split('.')[1] || '').length;
  return dec < 2 ? Number(n).toFixed(2) : s;
};
const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;
const pad = (v, n) => String(v).replace(/\D/g, '').padStart(n, '0');

// ---------- clave de acceso (49 dígitos, módulo 11) ----------
function modulo11(cadena48) {
  let factor = 2, suma = 0;
  for (let i = cadena48.length - 1; i >= 0; i--) {
    suma += Number(cadena48[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const dv = 11 - (suma % 11);
  return dv === 11 ? 0 : dv === 10 ? 1 : dv;
}

function generarClaveAcceso({ fecha, codDoc = '01', ruc, ambiente, estab, ptoEmi, secuencial, codigoNumerico, tipoEmision = '1' }) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const ddmmaaaa = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
  const cod = codigoNumerico || String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const base = `${ddmmaaaa}${codDoc}${pad(ruc, 13)}${ambiente}${pad(estab, 3)}${pad(ptoEmi, 3)}${pad(secuencial, 9)}${cod}${tipoEmision}`;
  if (base.length !== 48) throw new Error(`Clave de acceso inválida (${base.length} dígitos, se esperaban 48)`);
  return base + modulo11(base);
}

// ---------- catálogos SRI ----------
const IVA_CODIGO = { 0: '0', 5: '5', 12: '2', 13: '10', 14: '3', 15: '4' };   // tarifa % -> codigoPorcentaje
const FORMA_PAGO = {
  efectivo: '01', 'tarjeta de debito': '16', 'tarjeta débito': '16', debito: '16', débito: '16',
  'tarjeta de credito': '19', 'tarjeta crédito': '19', credito: '19', crédito: '19', tarjeta: '19',
  transferencia: '20', deuna: '20', qr: '20', 'de una': '20', cheque: '20', otros: '20'
};
function formaPagoSri(metodo) {
  const k = String(metodo || 'efectivo').trim().toLowerCase();
  return FORMA_PAGO[k] || (k.includes('tarjeta') ? '19' : k.includes('transf') ? '20' : '01');
}

function tipoIdentificacion(id) {
  const x = String(id || '').trim();
  if (!x || /^9{10,13}$/.test(x) || /^9999999999/.test(x)) return { tipo: '07', id: '9999999999999', consumidorFinal: true };
  if (/^\d{13}$/.test(x)) return { tipo: '04', id: x };
  if (/^\d{10}$/.test(x)) return { tipo: '05', id: x };
  return { tipo: '06', id: x };                        // pasaporte / otros
}

// ---------- cálculo de líneas e impuestos ----------
/**
 * item: { id, nombre, precio, cantidad, iva (tarifa %, default 0), anulado }
 * El descuento global del POS se reparte proporcionalmente entre las líneas.
 */
function calcularDetalles(items, descuentoGlobal, preciosIncluyenIva) {
  const activos = (items || []).filter((i) => !i.anulado && Number(i.cantidad) > 0);
  if (!activos.length) throw new Error('La venta no tiene productos activos.');

  const lineas = activos.map((i) => {
    const iva = Number(i.iva ?? i.iva_porcentaje ?? 0);
    if (!(iva in IVA_CODIGO)) throw new Error(`Tarifa de IVA no soportada (${iva}%) en "${i.nombre}".`);
    const cantidad = Number(i.cantidad);
    let precioUnit = Number(i.precio);
    if (preciosIncluyenIva && iva > 0) precioUnit = precioUnit / (1 + iva / 100);
    return { codigo: String(i.codigo || i.id || 'S/C').split(',')[0].trim().slice(0, 25), nombre: i.nombre, cantidad, precioUnit, iva, bruto: r2(cantidad * precioUnit), descuento: 0 };
  });

  const brutoTotal = lineas.reduce((s, l) => s + l.bruto, 0);
  let desc = Math.min(r2(descuentoGlobal || 0), r2(brutoTotal));
  let restante = desc;
  lineas.forEach((l, idx) => {
    const d = idx === lineas.length - 1 ? restante : r2(desc * (l.bruto / brutoTotal));
    l.descuento = Math.min(d, l.bruto);
    restante = r2(restante - l.descuento);
    l.base = r2(l.bruto - l.descuento);
    l.valorIva = r2(l.base * l.iva / 100);
  });

  const impuestos = {};
  lineas.forEach((l) => {
    const k = l.iva;
    impuestos[k] = impuestos[k] || { tarifa: k, base: 0, valor: 0 };
    impuestos[k].base = r2(impuestos[k].base + l.base);
    impuestos[k].valor = r2(impuestos[k].valor + l.valorIva);
  });
  const totalSinImpuestos = r2(lineas.reduce((s, l) => s + l.base, 0));
  const totalDescuento = r2(lineas.reduce((s, l) => s + l.descuento, 0));
  const totalIva = r2(Object.values(impuestos).reduce((s, t) => s + t.valor, 0));
  return { lineas, impuestos: Object.values(impuestos), totalSinImpuestos, totalDescuento, totalIva };
}

// ---------- XML de la factura ----------
/**
 * @param emisor  { ruc, razonSocial, nombreComercial, dirMatriz, dirEstablecimiento, obligadoContabilidad, contribuyenteEspecial, rimpe, agenteRetencion }
 * @param venta   { fecha, items, descuento, propina, metodoPago, clienteNombre, clienteId, clienteDireccion, clienteEmail, clienteTelefono }
 * @param ctx     { ambiente, estab, ptoEmi, secuencial, claveAcceso, preciosIncluyenIva }
 */
function construirFacturaXml(emisor, venta, ctx) {
  const calc = calcularDetalles(venta.items, venta.descuento, ctx.preciosIncluyenIva);
  const propina = r2(venta.propina || 0);
  const importeTotal = r2(calc.totalSinImpuestos + calc.totalIva + propina);
  const comp = tipoIdentificacion(venta.clienteId);
  if (comp.consumidorFinal && importeTotal > 50) {
    throw new Error('El SRI no permite facturar a Consumidor Final por más de USD 50.00. Registra los datos del cliente.');
  }
  const d = new Date(venta.fecha || Date.now());
  const fechaEmision = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const razonComprador = comp.consumidorFinal ? 'CONSUMIDOR FINAL' : (venta.clienteNombre || 'CLIENTE').toUpperCase();

  let x = '<factura id="comprobante" version="1.1.0">';
  // infoTributaria
  x += '<infoTributaria>';
  x += tag('ambiente', ctx.ambiente) + tag('tipoEmision', '1') + tag('razonSocial', emisor.razonSocial);
  if (emisor.nombreComercial) x += tag('nombreComercial', emisor.nombreComercial);
  x += tag('ruc', emisor.ruc) + tag('claveAcceso', ctx.claveAcceso) + tag('codDoc', '01');
  x += tag('estab', ctx.estab) + tag('ptoEmi', ctx.ptoEmi) + tag('secuencial', ctx.secuencial);
  x += tag('dirMatriz', emisor.dirMatriz);
  if (emisor.agenteRetencion) x += tag('agenteRetencion', emisor.agenteRetencion);
  if (emisor.rimpe) x += tag('contribuyenteRimpe', 'CONTRIBUYENTE RÉGIMEN RIMPE');
  x += '</infoTributaria>';
  // infoFactura
  x += '<infoFactura>' + tag('fechaEmision', fechaEmision);
  x += tag('dirEstablecimiento', emisor.dirEstablecimiento || emisor.dirMatriz);
  if (emisor.contribuyenteEspecial) x += tag('contribuyenteEspecial', emisor.contribuyenteEspecial);
  x += tag('obligadoContabilidad', emisor.obligadoContabilidad === 'SI' ? 'SI' : 'NO');
  x += tag('tipoIdentificacionComprador', comp.tipo) + tag('razonSocialComprador', razonComprador) + tag('identificacionComprador', comp.id);
  if (venta.clienteDireccion) x += tag('direccionComprador', venta.clienteDireccion);
  x += tag('totalSinImpuestos', f2(calc.totalSinImpuestos)) + tag('totalDescuento', f2(calc.totalDescuento));
  x += '<totalConImpuestos>';
  calc.impuestos.forEach((t) => {
    x += '<totalImpuesto>' + tag('codigo', '2') + tag('codigoPorcentaje', IVA_CODIGO[t.tarifa]) +
         tag('baseImponible', f2(t.base)) + tag('tarifa', f2(t.tarifa)) + tag('valor', f2(t.valor)) + '</totalImpuesto>';
  });
  x += '</totalConImpuestos>' + tag('propina', f2(propina)) + tag('importeTotal', f2(importeTotal)) + tag('moneda', 'DOLAR');
  x += '<pagos><pago>' + tag('formaPago', formaPagoSri(venta.metodoPago)) + tag('total', f2(importeTotal)) + '</pago></pagos>';
  x += '</infoFactura>';
  // detalles
  x += '<detalles>';
  calc.lineas.forEach((l) => {
    x += '<detalle>' + tag('codigoPrincipal', l.codigo) + tag('descripcion', String(l.nombre).slice(0, 300)) +
         tag('cantidad', fN(l.cantidad)) + tag('precioUnitario', fN(l.precioUnit)) + tag('descuento', f2(l.descuento)) +
         tag('precioTotalSinImpuesto', f2(l.base)) +
         '<impuestos><impuesto>' + tag('codigo', '2') + tag('codigoPorcentaje', IVA_CODIGO[l.iva]) + tag('tarifa', f2(l.iva)) +
         tag('baseImponible', f2(l.base)) + tag('valor', f2(l.valorIva)) + '</impuesto></impuestos></detalle>';
  });
  x += '</detalles>';
  // infoAdicional (opcional)
  const adic = [];
  if (venta.clienteEmail && venta.clienteEmail !== 'S/C') adic.push(['Email', venta.clienteEmail]);
  if (venta.clienteTelefono) adic.push(['Telefono', venta.clienteTelefono]);
  if (venta.nota) adic.push(['Observacion', venta.nota]);
  if (adic.length) {
    x += '<infoAdicional>' + adic.map(([n, v]) => `<campoAdicional nombre="${esc(n).replace(/"/g, '&quot;')}">${esc(v)}</campoAdicional>`).join('') + '</infoAdicional>';
  }
  x += '</factura>';
  return { xml: x, calc, importeTotal, propina, comprador: { ...comp, razon: razonComprador }, fechaEmision };
}

module.exports = { esc, r2, f2, modulo11, generarClaveAcceso, construirFacturaXml, calcularDetalles, tipoIdentificacion, formaPagoSri, IVA_CODIGO };
