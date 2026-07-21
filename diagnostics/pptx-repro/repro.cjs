// Faithful reproduction of DBOT Map Studio v4.9 PPTX export calls (pptxgenjs 3.12.0)
// Mirrors index.html lines ~3278-3417 with representative data + edge cases.
const PptxGenJS = require('pptxgenjs');

// ---- helpers copied from the app ----
const hex = c => String(c || '#888888').replace('#', '').toUpperCase();
const chan = h => { h = String(h).replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; };
const textOn = bg => { const [r,g,b]=chan(bg); return (r*299+g*587+b*114)/1000>150 ? '#17202B':'#FFFFFF'; };
const chipFont = 11.5;
const LOGO_AR = 0.4026;

// tiny 1x1 PNG (stands in for map capture + logo + image icon)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// SVG icon data URL, exactly as svgForKey path builds it
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L2 22 L22 22 Z" fill="#FF7A1A"/></svg>';
const SVGURL = 'data:image/svg+xml;base64,' + Buffer.from(svg,'utf8').toString('base64');

// ---- geometry (mirrors the app) ----
const SW = 13.333, SH = 7.5;
const wrapW = 1200, wrapH = 495;
const imgAspect = wrapW/wrapH, slideAspect = SW/SH;
let imgW,imgH,offX,offY;
if (imgAspect>=slideAspect){ imgW=SW; imgH=SW/imgAspect; offX=0; offY=(SH-imgH)/2; }
else { imgH=SH; imgW=SH*imgAspect; offY=0; offX=(SW-imgW)/2; }
const rr = imgW/wrapW;
const X = px => offX + px*rr;
const Y = px => offY + px*rr;
const PT = cssPx => Math.max(7.5, cssPx*rr*72);
// textWIn uses canvas measureText in browser; approximate with char count here
const textWIn = (text,pxSize) => String(text).length*pxSize*0.6*rr + PT(pxSize)*2.2/72*0.55 + 0.1;

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'DBOT · Property Map Studio';
const slide = pptx.addSlide();
slide.background = { color: '0A1E3C' };
slide.addImage({ data: PNG, x: offX, y: offY, w: imgW, h: imgH });

// ---- leaders: horizontal (h=0), vertical (w=0), diagonal ----
const leaders = [
  { a:{x:100,y:100}, b:{x:300,y:100}, color:'#FF7A1A' }, // horizontal -> h=0
  { a:{x:400,y:120}, b:{x:400,y:260}, color:'#2E6BE6' }, // vertical -> w=0
  { a:{x:500,y:120}, b:{x:640,y:250}, color:'#22A06B' }, // diagonal
];
leaders.forEach(L2 => {
  const x1=X(L2.a.x),y1=Y(L2.a.y),x2=X(L2.b.x),y2=Y(L2.b.y);
  const dx=x2-x1, dy=y2-y1;
  if (Math.abs(dx)<0.01 && Math.abs(dy)<0.01) return;
  slide.addShape('line', { x:Math.min(x1,x2), y:Math.min(y1,y2), w:Math.abs(dx), h:Math.abs(dy),
    flipH:(dx<0)!==(dy<0), line:{ color:hex(L2.color), width:0.75 } });
});

// ---- pins: frameless SVG, circle SVG, rounded SVG, image PNG ----
const pins = [
  { px:{x:150,y:200}, size:40, frame:'none',    bg:'#FFFFFF', border:1.5, borderColor:'#0A1E3C', iconData:SVGURL, isImage:false },
  { px:{x:250,y:200}, size:40, frame:'circle',  bg:'#FFFFFF', border:1.5, borderColor:'#0A1E3C', iconData:SVGURL, isImage:false },
  { px:{x:350,y:200}, size:40, frame:'rounded', bg:'#0A1E3C', border:1.5, borderColor:'#FF7A1A', iconData:SVGURL, isImage:false },
  { px:{x:450,y:200}, size:48, frame:'square',  bg:'#FFFFFF', border:1,   borderColor:'#E5EAF1', iconData:PNG,    isImage:true  },
];
pins.forEach(w => {
  const inSize=w.size*rr, cx=X(w.px.x), cy=Y(w.px.y), bx=cx-inSize/2, by=cy-inSize;
  if (w.frame==='none'){ slide.addImage({ data:w.iconData, x:bx, y:by, w:inSize, h:inSize }); }
  else {
    const shape = w.frame==='circle'?'ellipse':'roundRect';
    const radius = w.frame==='square'?0.02:(w.frame==='rounded'?0.16:0.5);
    slide.addShape(shape, { x:bx, y:by, w:inSize, h:inSize, rectRadius:radius,
      fill:{color:hex(w.bg)}, line:{color:hex(w.borderColor), width:Math.max(.5,w.border)} });
    const pad = inSize*(w.isImage?0.11:0.17);
    slide.addImage({ data:w.iconData, x:bx+pad, y:by+pad, w:inSize-pad*2, h:inSize-pad*2 });
  }
});

// ---- location labels (incl. special chars & < > ') ----
const locLabels = [
  { px:{x:170,y:230}, text:"Smith & Sons <Depot>", site:true,  bg:'#0A1E3C' },
  { px:{x:270,y:230}, text:"O'Hare Terminal",      site:false, bg:'#FFFFFF' },
];
locLabels.forEach(w => {
  const px = w.site?chipFont+1:chipFont, pt=PT(px);
  slide.addText(w.text, { x:X(w.px.x), y:Y(w.px.y), w:textWIn(w.text,px), h:pt*2.1/72,
    shape:'roundRect', rectRadius:0.5, fill:{color:hex(w.bg)}, line:{type:'none'},
    color:hex(textOn(w.bg)), fontSize:pt, bold:true, fontFace:'Arial', align:'center', valign:'middle', margin:0.02 });
});

// ---- route labels ----
const rtLabels = [ { px:{x:600,y:300}, text:"I-95 & Route 1", color:'#2E6BE6', bg:'#FFFFFF' } ];
rtLabels.forEach(w => {
  const px=chipFont-1, pt=PT(px);
  slide.addText(w.text, { x:X(w.px.x), y:Y(w.px.y), w:textWIn(w.text,px), h:pt*2.1/72,
    shape:'roundRect', rectRadius:0.5, fill:{color:hex(w.bg)}, line:{type:'none'},
    color:hex(textOn(w.bg)), fontSize:pt, bold:true, fontFace:'Arial', align:'center', valign:'middle', margin:0.02 });
});

// ---- badges ----
const badges = [ { px:{x:700,y:260}, text:"A", color:'#FF7A1A' } ];
badges.forEach(w => {
  const pt=PT(11), bw=textWIn(w.text,11), bh=pt*2.2/72;
  slide.addText(w.text, { x:X(w.px.x)-bw/2, y:Y(w.px.y)-bh/2, w:bw, h:bh,
    shape:'roundRect', rectRadius:0.05, fill:{color:hex(w.color)}, line:{color:'FFFFFF', width:1.5},
    color:'111111', fontSize:pt, bold:true, fontFace:'Arial', align:'center', valign:'middle', margin:0.02 });
});

// ---- rings ----
const rings = [ { px:{x:800,y:200}, text:"5 min", color:'#22A06B' } ];
rings.forEach(w => {
  const px=chipFont-2, pt=PT(px);
  slide.addText(w.text, { x:X(w.px.x), y:Y(w.px.y), w:textWIn(w.text,px), h:pt*2/72,
    shape:'roundRect', rectRadius:0.5, fill:{color:'FFFFFF'}, line:{color:hex(w.color), width:0.75},
    color:'17202B', fontSize:pt, fontFace:'Arial', align:'center', valign:'middle', margin:0.02 });
});

// ---- title ----
const titleText = 'PROPERTY LOCATION & ACCESS';
{ const tw=Math.max(3.4, textWIn(titleText,15)+0.5), th=0.44, tx=(SW-tw)/2, ty=offY+0.12;
  slide.addText(titleText, { x:tx, y:ty, w:tw, h:th, fill:{color:'0A1E3C'}, color:'FFFFFF', bold:true,
    fontSize:16, fontFace:'Arial', align:'center', valign:'middle', shape:'roundRect', rectRadius:0.05, charSpacing:1 });
  slide.addShape('rect', { x:tx+0.08, y:ty+th-0.045, w:tw-0.16, h:0.045, fill:{color:'FF7A1A'} });
}

// ---- legend table ----
const legendTitle = 'KEY DISTANCES';
const lgRows = [
  { color:'#FF7A1A', name:'Downtown', km:'4.2 km', min:'9 min' },
  { color:'#2E6BE6', name:'Airport',  km:'18 km',  min:'22 min' },
];
{ const lx=X(30), ly=Y(60), lw=Math.max(2.3, 240*rr);
  slide.addText(legendTitle, { x:lx, y:ly, w:lw, h:0.3, fill:{color:'0A1E3C'}, color:'FFFFFF',
    bold:true, fontSize:9.5, fontFace:'Arial', align:'left', valign:'middle', charSpacing:2, margin:0.06 });
  const rows = lgRows.map(r => [
    { text:'', options:{ fill:{color:hex(r.color)} } },
    { text:r.name, options:{ align:'left' } },
    { text:r.km, options:{ align:'right' } },
    { text:r.min, options:{ align:'right' } },
  ]);
  slide.addTable(rows, { x:lx, y:ly+0.3, w:lw, colW:[0.16, lw-0.16-0.62-0.55, 0.62, 0.55],
    fontFace:'Arial', fontSize:8.5, color:'17202B', fill:{color:'FFFFFF'}, border:{pt:0.5, color:'E5EAF1'},
    rowH:0.22, valign:'middle', margin:0.04 });
}

// ---- logo ----
{ const lw2=1.15, lh2=lw2*LOGO_AR, pad=0.09, bx=SW-lw2-pad*2-0.15, by=SH-lh2-pad*2-0.12;
  slide.addShape('roundRect', { x:bx, y:by, w:lw2+pad*2, h:lh2+pad*2, rectRadius:0.06, fill:{color:'FFFFFF'}, line:{color:'E5EAF1', width:0.5} });
  slide.addImage({ data:PNG, x:bx+pad, y:by+pad, w:lw2, h:lh2 });
}

pptx.writeFile({ fileName: 'repro-v49.pptx' }).then(f => console.log('WROTE', f));
