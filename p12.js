'use strict';
/** Extrae llave privada y certificado de un .p12 usando node-forge. */
const forge = require('node-forge');

function extraerCredenciales(p12Buffer, password) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (err) {
    const e = new Error('Contraseña de la firma incorrecta o archivo .p12 dañado.');
    e.codigo = 'P12_INVALIDO'; e.detalle = err.message; throw e;
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])
  ];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean);
  if (!keyBags.length || !certs.length) throw new Error('El .p12 no contiene llave privada y certificado.');
  const key = keyBags[0].key;

  // El .p12 del BCE / Security Data trae varios certificados (cadena). Se usa el que corresponde a la llave.
  const cert = certs.find((c) => c.publicKey.n && key.n && c.publicKey.n.compareTo(key.n) === 0) || certs[0];

  const ahora = new Date();
  if (ahora < cert.validity.notBefore || ahora > cert.validity.notAfter) {
    const e = new Error(`La firma electrónica está vencida o aún no es válida (vigencia: ${cert.validity.notBefore.toISOString().slice(0, 10)} a ${cert.validity.notAfter.toISOString().slice(0, 10)}).`);
    e.codigo = 'FIRMA_VENCIDA'; throw e;
  }
  const issuerName = cert.issuer.attributes.slice().reverse().map((a) => `${a.shortName || a.name}=${a.value}`).join(',');
  return {
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certDer: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'),
    issuerName,
    serialDecimal: BigInt('0x' + cert.serialNumber).toString(),
    vence: cert.validity.notAfter
  };
}
module.exports = { extraerCredenciales };
