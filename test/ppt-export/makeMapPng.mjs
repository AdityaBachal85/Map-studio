/**
 * makeMapPng.mjs — dependency-free PNG generator used only by the visible demo
 * deck. Draws a simple "map-like" raster (streets grid, a highway, water and a
 * park block) so a human can see the composed slide render correctly. Not part
 * of the export engine; the real app supplies the captured Leaflet map instead.
 */
import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Generate a map-like PNG as a base64 data URL.
 * @param {number} [W] width px @param {number} [H] height px
 * @returns {string} `data:image/png;base64,...`
 */
export function makeMapPngDataUrl(W = 1200, H = 495) {
  const px = Buffer.alloc(W * H * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const rect = (x0, y0, x1, y1, r, g, b) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, r, g, b); };
  const hline = (y, w, r, g, b) => { for (let dy = -w; dy <= w; dy++) for (let x = 0; x < W; x++) set(x, y + dy, r, g, b); };
  const vline = (x, w, r, g, b) => { for (let dx = -w; dx <= w; dx++) for (let y = 0; y < H; y++) set(x + dx, y, r, g, b); };

  rect(0, 0, W, H, 0xEC, 0xEF, 0xE6);                 // land base
  rect(0, 0, 210, H, 0xCF, 0xE6, 0xF2);               // water on the left
  rect(760, 300, 1040, 470, 0xCF, 0xE7, 0xC9);        // park block
  for (let x = 90; x < W; x += 120) vline(x, 5, 0xFF, 0xFF, 0xFF); // street casing
  for (let y = 70; y < H; y += 110) hline(y, 5, 0xFF, 0xFF, 0xFF);
  for (let x = 90; x < W; x += 120) vline(x, 2, 0xD7, 0xDD, 0xD2);
  for (let y = 70; y < H; y += 110) hline(y, 2, 0xD7, 0xDD, 0xD2);
  for (let t = 0; t < 1600; t++) {                    // diagonal highway
    const x = Math.round(240 + t * 0.55), y = Math.round(40 + t * 0.28);
    for (let dw = -6; dw <= 6; dw++) { set(x + dw, y, 0xF6, 0xB0, 0x5E); set(x, y + dw, 0xF6, 0xB0, 0x5E); }
  }

  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}
