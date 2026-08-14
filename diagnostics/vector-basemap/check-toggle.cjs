/**
 * The Preferences toggle that exposes the vector ground, driven by clicking it
 * rather than by calling setPref() — a pref that writes correctly but leaves the
 * basemap registry stale would pass every state assertion and still not put the
 * basemap in the picker. Starts from NO seeded prefs: a first-time user.
 */
const { chromium } = require('playwright');
const fs=require('fs'), path=require('path');
const REPO=path.join(__dirname,'..','..');
const STYLE=fs.readFileSync(__dirname+'/style-fixture.json','utf8');
const cfg=()=>fs.readFileSync(REPO+'/js/config.js','utf8')
  .replace(/const SUPABASE_URL = '[^']*';/,"const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/,"const SUPABASE_ANON_KEY = '';");
const R=[]; const ck=(n,p,d)=>{R.push(p);console.log((p?'PASS ':'FAIL ')+n+(d?'  — '+d:''));};
(async()=>{
  const b=await chromium.launch({executablePath:process.env.CHROME||undefined,
    args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const p=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.route('**',r=>{const u=r.request().url();
    return (u.startsWith('http://127.0.0.1:8000')||u.startsWith('data:')||u.startsWith('blob:'))?r.continue():r.abort();});
  await p.route('**/tiles.openfreemap.org/**',r=>r.fulfill({status:200,contentType:'application/json',body:STYLE}));
  await p.route('**/js/config.js*',r=>r.fulfill({status:200,contentType:'application/javascript',body:cfg()}));
  // NOTE: no prefs seeded at all — this is a first-time user with defaults.
  await p.goto('http://127.0.0.1:8000/index.html',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2500);

  // Satellite layout, so the basemap picker is not pinned.
  await p.evaluate(()=>setMapLayout('satellite',{silent:true}));
  await p.waitForTimeout(800);

  ck('vector basemap is absent by default',
    await p.evaluate(()=>!availableBasemaps().some(s=>s.id==='openfreemap')));

  // Open Preferences the way a user does: click the gear.
  await p.click('#prefsBtn');
  await p.waitForTimeout(500);
  const vis = await p.evaluate(()=>{
    const el=document.getElementById('prefVectorBasemap');
    if(!el) return {err:'checkbox missing'};
    const lab=el.closest('label'); const cs=getComputedStyle(lab); const r=lab.getBoundingClientRect();
    return {found:true, opacity:cs.opacity, display:cs.display, w:Math.round(r.width), h:Math.round(r.height),
            onScreen: r.top>=0 && r.bottom<=1000 && r.width>0};
  });
  ck('the checkbox exists and is really visible',
    vis.found && vis.opacity!=='0' && vis.display!=='none' && vis.w>0 && vis.h>0, JSON.stringify(vis));
  await p.screenshot({path:__dirname+'/shot-prefs.png'});

  // Click it for real.
  await p.click('#prefVectorBasemap');
  await p.waitForTimeout(900);
  ck('clicking it writes the pref', await p.evaluate(()=>getPref('vectorBasemap')===true));
  ck('the basemap becomes available',
    await p.evaluate(()=>availableBasemaps().some(s=>s.id==='openfreemap')));
  const inGrid = await p.evaluate(()=>{
    const g=document.getElementById('bmGrid')||document.getElementById('bmPanel');
    return g ? /Streets — vector/.test(g.textContent) : 'no grid';
  });
  ck('it appears in the basemap picker grid', inGrid===true, 'grid says: '+inGrid);

  // Close the dialog, then choose the basemap the way a user does.
  await p.click('#prefsClose'); await p.waitForTimeout(400);
  await p.evaluate(()=>chooseBasemap('openfreemap'));
  await p.waitForTimeout(4000);
  ck('choosing it mounts the ground',
    await p.evaluate(()=>vectorGroundActive() && activeKey==='openfreemap'));

  // Now turn the pref back off while it is the LIVE ground.
  await p.click('#prefsBtn'); await p.waitForTimeout(600);
  await p.click('#prefVectorBasemap');
  await p.waitForTimeout(1500);
  const off = await p.evaluate(()=>({key:activeKey, active:vectorGroundActive(),
    hosts:document.querySelectorAll('.vector-basemap-host').length,
    listed:availableBasemaps().some(s=>s.id==='openfreemap')}));
  ck('turning it off while live falls back to a real ground',
    off.key!=='openfreemap' && off.active===false && off.hosts===0 && off.listed===false,
    JSON.stringify(off));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' // ')||'none');
  await b.close();
  console.log('\n'+R.filter(Boolean).length+'/'+R.length+' passed');
  process.exit(R.every(Boolean)?0:1);
})().catch(e=>{console.error('HARNESS',e);process.exit(2);});
