// Arma un zip (deflate, con índice central) sin dependencias. Lo usan las pruebas (xlsx de mentira)
// y el servicio para empaquetar el plugin «Oficina Hacienda» al vuelo.
import { deflateRawSync } from "node:zlib";

const crc = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return b => { let c = -1; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();

export function crearZip(archivos) {
  const locales = [], centrales = []; let off = 0;
  for (const [nombre, contenido] of Object.entries(archivos)) {
    const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, "utf8");
    const comp = deflateRawSync(datos), n = Buffer.from(nombre, "utf8");
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc(datos), 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(datos.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc(datos), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(datos.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locales.push(l, n, comp); centrales.push(c, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrales), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(archivos).length, 8); e.writeUInt16LE(Object.keys(archivos).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locales, cd, e]);
}

