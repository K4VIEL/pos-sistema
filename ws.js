'use strict';
/** Cliente SOAP de los web services offline del SRI (recepción y autorización). */
const HOSTS = { '1': 'https://celcer.sri.gob.ec', '2': 'https://cel.sri.gob.ec' };   // 1 = pruebas, 2 = producción
const BASE = '/comprobantes-electronicos-ws';

const urlRecepcion = (amb) => (process.env.SRI_URL_RECEPCION || `${HOSTS[amb]}${BASE}/RecepcionComprobantesOffline`);
const urlAutorizacion = (amb) => (process.env.SRI_URL_AUTORIZACION || `${HOSTS[amb]}${BASE}/AutorizacionComprobantesOffline`);

const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const pick = (xml, name) => { const m = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml); return m ? m[1].trim() : ''; };

function parseMensajes(xml) {
  const out = [];
  const re = /<(?:\w+:)?mensaje>\s*<(?:\w+:)?identificador>([\s\S]*?)<\/(?:\w+:)?identificador>\s*<(?:\w+:)?mensaje>([\s\S]*?)<\/(?:\w+:)?mensaje>(?:\s*<(?:\w+:)?informacionAdicional>([\s\S]*?)<\/(?:\w+:)?informacionAdicional>)?\s*(?:<(?:\w+:)?tipo>([\s\S]*?)<\/(?:\w+:)?tipo>)?\s*<\/(?:\w+:)?mensaje>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ identificador: decode(m[1]), mensaje: decode(m[2]), informacionAdicional: decode(m[3] || ''), tipo: decode(m[4] || '') });
  return out;
}

async function soap(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: '' },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok && !/<(?:\w+:)?Envelope/.test(text)) throw new Error(`SRI respondió HTTP ${res.status}`);
  return text;
}

/** Envía el XML firmado. Devuelve { estado: 'RECIBIDA' | 'DEVUELTA', mensajes } */
async function enviarRecepcion(xmlFirmado, ambiente, timeoutMs = 25000) {
  const b64 = Buffer.from(xmlFirmado, 'utf8').toString('base64');
  const body = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">' +
    `<soapenv:Header/><soapenv:Body><ec:validarComprobante><xml>${b64}</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>`;
  const xml = await soap(urlRecepcion(ambiente), body, timeoutMs);
  return { estado: pick(xml, 'estado') || 'DESCONOCIDO', mensajes: parseMensajes(xml), raw: xml };
}

/** Consulta la autorización. Devuelve { estado: 'AUTORIZADO'|'NO AUTORIZADO'|'EN PROCESO'|'SIN_RESPUESTA', ... } */
async function consultarAutorizacion(claveAcceso, ambiente, timeoutMs = 25000) {
  const body = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">' +
    `<soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;
  const xml = await soap(urlAutorizacion(ambiente), body, timeoutMs);
  const n = Number(pick(xml, 'numeroComprobantes') || 0);
  const bloque = /<(?:\w+:)?autorizacion>([\s\S]*?)<\/(?:\w+:)?autorizacion>/.exec(xml);
  if (!n || !bloque) return { estado: 'SIN_RESPUESTA', mensajes: [], raw: xml };
  const a = bloque[1];
  const cdata = /<(?:\w+:)?comprobante><!\[CDATA\[([\s\S]*?)\]\]><\/(?:\w+:)?comprobante>/.exec(a);
  return {
    estado: pick(a, 'estado'),
    numeroAutorizacion: pick(a, 'numeroAutorizacion'),
    fechaAutorizacion: pick(a, 'fechaAutorizacion'),
    ambiente: pick(a, 'ambiente'),
    comprobante: cdata ? cdata[1] : decode(pick(a, 'comprobante')),
    mensajes: parseMensajes(a),
    raw: xml
  };
}

/** XML de la respuesta de autorización tal como se entrega al cliente (<autorizacion>...). */
function xmlAutorizado(aut) {
  const e = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<?xml version="1.0" encoding="UTF-8"?><autorizacion>' +
    `<estado>${e(aut.estado)}</estado><numeroAutorizacion>${e(aut.numeroAutorizacion)}</numeroAutorizacion>` +
    `<fechaAutorizacion>${e(aut.fechaAutorizacion)}</fechaAutorizacion><ambiente>${e(aut.ambiente)}</ambiente>` +
    `<comprobante><![CDATA[${aut.comprobante}]]></comprobante></autorizacion>`;
}

module.exports = { enviarRecepcion, consultarAutorizacion, xmlAutorizado, parseMensajes };
