'use strict';
/**
 * RIDE (Representación Impresa del Documento Electrónico) de la factura, en PDF A4.
 * Usa pdf-lib (JS puro). El código de barras Code128 de la clave de acceso se dibuja vectorialmente.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const PATTERNS = require('./code128-table');

// ---------- Code128 ----------
function code128Values(digits) {
  // Code C para pares de dígitos; si la longitud es impar, el último dígito va en Code B.
  const vals = [];
  const pares = Math.floor(digits.length / 2);
  vals.push(105);
  for (let i = 0; i < pares; i++) vals.push(Number(digits.substr(i * 2, 2)));
  if (digits.length % 2) { vals.push(100); vals.push(digits.charCodeAt(digits.length - 1) - 32); }
  let sum = vals[0];
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103);
  vals.push(106);
  return vals;
}
const code128Modules = (digits) => code128Values(digits).map((v) => PATTERNS[v]).join('');

function drawCode128(page, digits, x, y, w, h) {
  const widths = code128Modules(digits);
  const total = [...widths].reduce((s, c) => s + Number(c), 0);
  const mod = w / total;
  let cx = x, bar = true;
  for (const c of widths) {
    const bw = Number(c) * mod;
    if (bar) page.drawRectangle({ x: cx, y, width: bw, height: h, color: rgb(0, 0, 0) });
    cx += bw; bar = !bar;
  }
}

// ---------- utilidades de texto ----------
const safe = (s) => String(s ?? '').replace(/[^\u0020-\u007E\u00A0-\u00FF\u20AC\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u2026]/g, '?');
const money = (n) => Number(n).toFixed(2);

function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of safe(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxW) { line = test; continue; }
      if (line) out.push(line);
      // palabra más larga que la caja: partirla
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW) {
        let k = w.length; while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > maxW) k--;
        out.push(w.slice(0, k)); w = w.slice(k);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

async function generarRidePdf(d) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Factura ${d.numero}`); pdf.setProducer('POS Pro System');
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 30;
  const black = rgb(0, 0, 0), gray = rgb(0.45, 0.45, 0.45);
  let page = pdf.addPage([W, H]);

  const text = (t, x, y, size = 8, font = F, color = black) => page.drawText(safe(t), { x, y, size, font, color });
  const box = (x, y, w, h) => page.drawRectangle({ x, y, width: w, height: h, borderColor: black, borderWidth: 0.8, borderOpacity: 1 });
  const lines = (t, x, y, w, size = 8, font = F, lh = size + 2.5) => { const ls = wrap(t, font, size, w); ls.forEach((l, i) => text(l, x, y - i * lh, size, font)); return ls.length * lh; };

  // ---- columna derecha: datos del comprobante ----
  const rx = 312, rw = W - M - rx, topY = H - M;
  const rh = 222;
  box(rx, topY - rh, rw, rh);
  let y = topY - 16;
  text(`R.U.C.: ${d.emisor.ruc}`, rx + 8, y, 10, B); y -= 18;
  text('F A C T U R A', rx + 8, y, 12, B); y -= 15;
  text(`No. ${d.numero}`, rx + 8, y, 10, F); y -= 15;
  text('NÚMERO DE AUTORIZACIÓN', rx + 8, y, 7.5, B); y -= 10;
  if (d.numeroAutorizacion) { y -= lines(d.numeroAutorizacion, rx + 8, y, rw - 16, 7.5) - 2.5; }
  else { text('PENDIENTE DE AUTORIZACIÓN', rx + 8, y, 7.5, B, rgb(0.8, 0.1, 0.1)); y -= 10; }
  y -= 4;
  text('FECHA Y HORA DE AUTORIZACIÓN:', rx + 8, y, 7.5, B); y -= 10;
  text(d.fechaAutorizacion || '—', rx + 8, y, 8); y -= 13;
  text('AMBIENTE:', rx + 8, y, 7.5, B); text(d.ambiente, rx + 62, y, 8); y -= 12;
  text('EMISIÓN:', rx + 8, y, 7.5, B); text('NORMAL', rx + 48, y, 8); y -= 14;
  text('CLAVE DE ACCESO', rx + 8, y, 7.5, B); y -= 4;
  drawCode128(page, d.claveAcceso, rx + 8, y - 36, rw - 16, 34); y -= 46;
  text(d.claveAcceso, rx + 8, y, 7.6, F);

  // ---- columna izquierda: emisor ----
  const lx = M, lw = rx - M - 10;
  const eh = 150, ey = topY - eh;
  box(lx, ey, lw, eh);
  let ly = topY - 16;
  ly -= lines(d.emisor.razonSocial, lx + 8, ly, lw - 16, 10, B, 12) + 2;
  if (d.emisor.nombreComercial && d.emisor.nombreComercial !== d.emisor.razonSocial) ly -= lines(d.emisor.nombreComercial, lx + 8, ly, lw - 16, 8.5, F) + 2;
  ly -= lines(`Dirección Matriz: ${d.emisor.dirMatriz}`, lx + 8, ly, lw - 16, 8) + 2;
  ly -= lines(`Dirección Sucursal: ${d.emisor.dirEstablecimiento || d.emisor.dirMatriz}`, lx + 8, ly, lw - 16, 8) + 2;
  if (d.emisor.contribuyenteEspecial) ly -= lines(`Contribuyente Especial Nro: ${d.emisor.contribuyenteEspecial}`, lx + 8, ly, lw - 16, 8) + 2;
  ly -= lines(`OBLIGADO A LLEVAR CONTABILIDAD: ${d.emisor.obligadoContabilidad === 'SI' ? 'SI' : 'NO'}`, lx + 8, ly, lw - 16, 8, B) + 2;
  if (d.emisor.rimpe) lines('CONTRIBUYENTE RÉGIMEN RIMPE', lx + 8, ly, lw - 16, 8, B);

  // ---- comprador ----
  let cy = topY - rh - 12;
  const ch = 46;
  box(M, cy - ch, W - 2 * M, ch);
  text('Razón Social / Nombres y Apellidos:', M + 8, cy - 14, 8, B);
  text(d.comprador.razon, M + 185, cy - 14, 8);
  text('Identificación:', M + 8, cy - 27, 8, B); text(d.comprador.id, M + 70, cy - 27, 8);
  text('Fecha de Emisión:', M + 300, cy - 27, 8, B); text(d.fechaEmision, M + 380, cy - 27, 8);
  if (d.comprador.direccion) { text('Dirección:', M + 8, cy - 40, 8, B); text(d.comprador.direccion, M + 52, cy - 40, 8); }
  cy -= ch + 10;

  // ---- detalle ----
  const cols = [
    { t: 'Cód. Principal', w: 70, a: 'l' }, { t: 'Cant.', w: 45, a: 'r' }, { t: 'Descripción', w: 235, a: 'l' },
    { t: 'P. Unitario', w: 62, a: 'r' }, { t: 'Descuento', w: 55, a: 'r' }, { t: 'Total', w: 68, a: 'r' }
  ];
  const cell = (c, x, yy, val, font = F, size = 7.8) => {
    const s = safe(val);
    const tw = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: c.a === 'r' ? x + c.w - 4 - tw : x + 4, y: yy, size, font, color: black });
  };
  const header = () => {
    let x = M; page.drawRectangle({ x: M, y: cy - 16, width: W - 2 * M, height: 16, color: rgb(0.9, 0.9, 0.9), borderColor: black, borderWidth: 0.6 });
    cols.forEach((c) => { cell(c, x, cy - 11, c.t, B, 7.8); x += c.w; });
    cy -= 16;
  };
  header();
  for (const it of d.detalles) {
    const dl = wrap(it.descripcion, F, 7.8, cols[2].w - 8);
    const rh2 = Math.max(14, dl.length * 10 + 4);
    if (cy - rh2 < 175) { page = pdf.addPage([W, H]); cy = H - M; header(); }
    let x = M;
    cell(cols[0], x, cy - 10, it.codigo); x += cols[0].w;
    cell(cols[1], x, cy - 10, String(it.cantidad)); x += cols[1].w;
    dl.forEach((l, i) => page.drawText(safe(l), { x: x + 4, y: cy - 10 - i * 10, size: 7.8, font: F, color: black })); x += cols[2].w;
    cell(cols[3], x, cy - 10, money(it.precioUnit)); x += cols[3].w;
    cell(cols[4], x, cy - 10, money(it.descuento)); x += cols[4].w;
    cell(cols[5], x, cy - 10, money(it.total));
    page.drawLine({ start: { x: M, y: cy - rh2 }, end: { x: W - M, y: cy - rh2 }, thickness: 0.3, color: gray });
    cy -= rh2;
  }
  cy -= 14;
  if (cy < 175) { page = pdf.addPage([W, H]); cy = H - M; }

  // ---- totales (derecha) ----
  const tw0 = 215, tx = W - M - tw0;
  const filas = [];
  d.impuestos.forEach((t) => filas.push([`SUBTOTAL ${t.tarifa}%`, t.base]));
  filas.push(['SUBTOTAL SIN IMPUESTOS', d.totalSinImpuestos]);
  filas.push(['DESCUENTO', d.totalDescuento]);
  d.impuestos.filter((t) => t.tarifa > 0).forEach((t) => filas.push([`IVA ${t.tarifa}%`, t.valor]));
  if (d.propina > 0) filas.push(['PROPINA', d.propina]);
  filas.push(['VALOR TOTAL', d.importeTotal]);
  let ty = cy;
  filas.forEach(([k, v], i) => {
    const last = i === filas.length - 1;
    page.drawRectangle({ x: tx, y: ty - 14, width: tw0, height: 14, borderColor: black, borderWidth: 0.6, color: last ? rgb(0.9, 0.9, 0.9) : undefined });
    text(k, tx + 5, ty - 10, 7.8, last ? B : F);
    const s = money(v); text(s, tx + tw0 - 5 - (last ? B : F).widthOfTextAtSize(s, 8), ty - 10, 8, last ? B : F);
    ty -= 14;
  });

  // ---- forma de pago e información adicional (izquierda) ----
  let ay = cy;
  const aw = tx - M - 12;
  box(M, ay - 28, aw, 28);
  text('Forma de pago', M + 5, ay - 11, 7.8, B); text(d.formaPago, M + 5, ay - 22, 7.8);
  text('Valor', M + aw - 55, ay - 11, 7.8, B); text(money(d.importeTotal), M + aw - 55, ay - 22, 7.8);
  ay -= 38;
  if (d.infoAdicional?.length) {
    const h = 16 + d.infoAdicional.length * 11;
    box(M, ay - h, aw, h);
    text('Información Adicional', M + 5, ay - 11, 7.8, B);
    d.infoAdicional.forEach(([n, v], i) => text(`${n}: ${String(v).slice(0, 70)}`, M + 5, ay - 23 - i * 11, 7.5));
  }
  return Buffer.from(await pdf.save());
}

module.exports = { generarRidePdf, code128Values, code128Modules };
