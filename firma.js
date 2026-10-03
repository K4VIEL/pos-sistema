'use strict';
/**
 * Firma XAdES-BES (enveloped) para comprobantes del SRI.
 * Solo usa el módulo `crypto` de Node. Las credenciales llegan ya extraídas del .p12:
 *   { privateKeyPem, certDer (Buffer), issuerName (string RFC2253), serialDecimal (string) }
 * La canonicalización es C14N inclusiva 1.0; como el XML se genera ya canónico
 * (sin espacios, sin etiquetas auto-cerradas, atributos ordenados), cada bloque
 * se digiere con sus declaraciones de namespace explícitas.
 */
const crypto = require('crypto');

const NS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#"';
const sha1b64 = (buf) => crypto.createHash('sha1').update(buf).digest('base64');
const rnd = () => Math.floor(Math.random() * 900000) + 100000;
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function signingTimeEc() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);       // UTC-5 (Ecuador continental)
  return d.toISOString().replace(/\.\d{3}Z$/, '-05:00');
}

function firmarFactura(facturaXml, cred) {
  if (!facturaXml.startsWith('<factura id="comprobante"')) throw new Error('XML de factura inesperado');
  const sigId = `Signature${rnd()}`, siId = `Signature-SignedInfo${rnd()}`, svId = `SignatureValue${rnd()}`;
  const kiId = `Certificate${rnd()}`, spId = `${sigId}-SignedProperties${rnd()}`, objId = `${sigId}-Object${rnd()}`;
  const refSpId = `SignedPropertiesID${rnd()}`, refDocId = `Reference-ID-${rnd()}`;

  // módulo y exponente desde la llave privada (misma pareja que el certificado)
  const jwk = crypto.createPublicKey(crypto.createPrivateKey(cred.privateKeyPem)).export({ format: 'jwk' });
  const b64 = (u) => Buffer.from(u, 'base64url').toString('base64');
  const modulus = b64(jwk.n), exponent = b64(jwk.e);

  const certB64 = cred.certDer.toString('base64');

  // --- SignedProperties ---
  const spInner =
    '<etsi:SignedSignatureProperties>' +
      `<etsi:SigningTime>${signingTimeEc()}</etsi:SigningTime>` +
      '<etsi:SigningCertificate><etsi:Cert><etsi:CertDigest>' +
        '<ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></ds:DigestMethod>' +
        `<ds:DigestValue>${sha1b64(cred.certDer)}</ds:DigestValue></etsi:CertDigest>` +
        `<etsi:IssuerSerial><ds:X509IssuerName>${escText(cred.issuerName)}</ds:X509IssuerName>` +
        `<ds:X509SerialNumber>${cred.serialDecimal}</ds:X509SerialNumber></etsi:IssuerSerial>` +
      '</etsi:Cert></etsi:SigningCertificate>' +
    '</etsi:SignedSignatureProperties>' +
    '<etsi:SignedDataObjectProperties>' +
      `<etsi:DataObjectFormat ObjectReference="#${refDocId}">` +
        '<etsi:Description>contenido comprobante</etsi:Description><etsi:MimeType>text/xml</etsi:MimeType>' +
      '</etsi:DataObjectFormat></etsi:SignedDataObjectProperties>';
  const spForDoc = `<etsi:SignedProperties Id="${spId}">${spInner}</etsi:SignedProperties>`;
  const spForDigest = `<etsi:SignedProperties ${NS} Id="${spId}">${spInner}</etsi:SignedProperties>`;

  // --- KeyInfo ---
  const kiInner =
    `<ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data>` +
    `<ds:KeyValue><ds:RSAKeyValue><ds:Modulus>${modulus}</ds:Modulus><ds:Exponent>${exponent}</ds:Exponent></ds:RSAKeyValue></ds:KeyValue>`;
  const kiForDoc = `<ds:KeyInfo Id="${kiId}">${kiInner}</ds:KeyInfo>`;
  const kiForDigest = `<ds:KeyInfo ${NS} Id="${kiId}">${kiInner}</ds:KeyInfo>`;

  // --- SignedInfo ---
  const dm = '<ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></ds:DigestMethod>';
  const siInner =
    '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod>' +
    '<ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></ds:SignatureMethod>' +
    `<ds:Reference Id="${refSpId}" Type="http://uri.etsi.org/01903#SignedProperties" URI="#${spId}">${dm}<ds:DigestValue>${sha1b64(Buffer.from(spForDigest, 'utf8'))}</ds:DigestValue></ds:Reference>` +
    `<ds:Reference URI="#${kiId}">${dm}<ds:DigestValue>${sha1b64(Buffer.from(kiForDigest, 'utf8'))}</ds:DigestValue></ds:Reference>` +
    `<ds:Reference Id="${refDocId}" URI="#comprobante"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform></ds:Transforms>${dm}<ds:DigestValue>${sha1b64(Buffer.from(facturaXml, 'utf8'))}</ds:DigestValue></ds:Reference>`;
  const siForDoc = `<ds:SignedInfo Id="${siId}">${siInner}</ds:SignedInfo>`;
  const siForSign = `<ds:SignedInfo ${NS} Id="${siId}">${siInner}</ds:SignedInfo>`;

  const sigValue = crypto.sign('RSA-SHA1', Buffer.from(siForSign, 'utf8'), crypto.createPrivateKey(cred.privateKeyPem)).toString('base64');

  const signature =
    `<ds:Signature ${NS} Id="${sigId}">${siForDoc}` +
    `<ds:SignatureValue Id="${svId}">${sigValue}</ds:SignatureValue>${kiForDoc}` +
    `<ds:Object Id="${objId}"><etsi:QualifyingProperties Target="#${sigId}">${spForDoc}</etsi:QualifyingProperties></ds:Object>` +
    '</ds:Signature>';

  return '<?xml version="1.0" encoding="UTF-8"?>' + facturaXml.replace(/<\/factura>$/, signature + '</factura>');
}

module.exports = { firmarFactura };
