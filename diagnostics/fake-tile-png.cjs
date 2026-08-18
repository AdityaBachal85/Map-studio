const zlib = require('zlib');
function crc32(buf){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}
  let x=0xffffffff;for(const b of buf)x=t[(x^b)&0xff]^(x>>>8);return (x^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);
  const td=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len,td,crc]);}
/** Solid or noisy 256x256 RGB PNG. */
function png(r,g,b,noise){const S=256;const raw=Buffer.alloc(S*(S*3+1));let p=0;
  for(let y=0;y<S;y++){raw[p++]=0;for(let x=0;x<S;x++){const n=noise?((Math.random()*noise)-noise/2):0;
    raw[p++]=Math.max(0,Math.min(255,r+n));raw[p++]=Math.max(0,Math.min(255,g+n));raw[p++]=Math.max(0,Math.min(255,b+n));}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(S,0);ihdr.writeUInt32BE(S,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
    chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}

/**
 * A 256x256 terrarium-encoded elevation tile.
 *
 * Terrarium packs metres into colour: `elev = R*256 + G + B/256 - 32768`. The
 * decoder in services/elevation.js reads exactly that, so a fixture written the
 * other way round exercises the real arithmetic rather than a stub of it.
 *
 * `fn(i, j)` is called per tile-local pixel and returns metres. Callers close
 * over z/x/y and convert to a real position, which is what keeps a surface
 * continuous across tile seams — a discontinuity there would look exactly like
 * a mosaicking bug.
 */
function elevPng(fn){const S=256;const raw=Buffer.alloc(S*(S*3+1));let p=0;
  for(let j=0;j<S;j++){raw[p++]=0;for(let i=0;i<S;i++){
    let v=fn(i,j)+32768;if(!(v>0))v=0;if(v>65535)v=65535;
    const r=Math.floor(v/256),g=Math.floor(v)%256,b=Math.round((v-Math.floor(v))*256)%256;
    raw[p++]=r;raw[p++]=g;raw[p++]=b;}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(S,0);ihdr.writeUInt32BE(S,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
    chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
module.exports={png,elevPng};
