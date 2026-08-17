/**
 * login.html has to explain an emailed auth link that Supabase rejected.
 *
 * Driven with the exact URL a real failed confirmation produced — query string
 * AND hash fragment, because Supabase writes the error into both. Before this,
 * the page rendered a blank sign-in form and the reason existed only in the
 * address bar.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/auth-link-error.cjs
 */
const { chromium } = require('playwright');
const fs=require('fs'), path=require('path');
const REPO=path.join(__dirname,'..');
const cfg=()=>fs.readFileSync(REPO+'/js/config.js','utf8')  // real Supabase config: authMode() === 'supabase'
const R=[]; const ck=(n,p,d)=>{R.push(p);console.log((p?'PASS ':'FAIL ')+n+(d?'  — '+d:''));};
(async()=>{
  const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
  const p=await (await b.newContext({viewport:{width:1364,height:760}})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  // Block only outbound network; the page itself is local.
  await p.route('**',r=>{const u=r.request().url();
    return (u.startsWith('http://127.0.0.1:8000')||u.startsWith('data:'))?r.continue():r.abort();});

  // The exact URL Supabase produced, minus the localhost:3000 origin.
  const bad = '/login.html?error=access_denied&error_code=otp_expired'
    + '&error_description=Email+link+is+invalid+or+has+expired'
    + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  await p.goto('http://127.0.0.1:8000'+bad, {waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2500);

  const st = await p.evaluate(()=>{
    const e=document.getElementById('authError');
    const cs=getComputedStyle(e); const r=e.getBoundingClientRect();
    return {hidden:e.hidden, text:e.textContent.trim().slice(0,80),
            opacity:cs.opacity, display:cs.display, h:Math.round(r.height), url:location.href};
  });
  ck('the failed link is explained on the page', st.hidden===false && st.text.length>30, JSON.stringify(st).slice(0,200));
  ck('the explanation is actually visible (not opacity:0 / 0-height)',
     st.opacity!=='0' && st.display!=='none' && st.h>0, 'opacity='+st.opacity+' h='+st.h);
  ck('it names the real cause, not just "expired"', /scanners|already been used/i.test(st.text||''), st.text);
  ck('the error is cleared from the address bar', !/error_code/.test(st.url), st.url);
  ck('no page errors', errs.length===0, errs.slice(0,2).join(' // ')||'none');
  await p.screenshot({path:__dirname+'/shot-login-err.png'});

  // A clean visit must NOT show the banner.
  await p.goto('http://127.0.0.1:8000/login.html',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2000);
  ck('a normal visit shows no error banner',
     await p.evaluate(()=>document.getElementById('authError').hidden===true));
  await b.close();
  console.log('\n'+R.filter(Boolean).length+'/'+R.length+' passed');
  process.exit(R.every(Boolean)?0:1);
})().catch(e=>{console.error('HARNESS',e);process.exit(2);});
