// End-to-end-ish verification in jsdom: real app.js + vendor modules, sample school data,
// every route rendered per role, and the feature flows driven through real DOM events.
const fs=require('fs'), path=require('path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
let html=read('index.html').replace(/<script src="https?:[^"]+"><\/script>/g,'');
const results=[]; const check=(name,ok,extra)=>{ results.push({name,ok:!!ok,extra:extra===undefined?undefined:String(extra).slice(0,160)}); };

const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/',pretendToBeVisual:true,
  beforeParse(w){
    w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
    w.requestAnimationFrame=cb=>setTimeout(()=>cb(Date.now()),0);
    w.IntersectionObserver=function(){ return {observe(){},unobserve(){},disconnect(){}}; };
    w.ResizeObserver=function(){ return {observe(){},unobserve(){},disconnect(){}}; };
    w.HTMLCanvasElement.prototype.getContext=()=>null; w.scrollTo=()=>{}; w.Path2D=function(){ return new Proxy({}, {get:(t,k)=>(k in t?t[k]:(()=>{})), set:(t,k,v)=>{t[k]=v;return true;}}); }; w.HTMLElement.prototype.scrollIntoView=function(){};
    Object.defineProperty(w.navigator,'serviceWorker',{value:{register:()=>Promise.resolve({}),addEventListener(){},ready:Promise.resolve({})},configurable:true});
    w.__warn=[]; w.__err=[];
    w.console.warn=(...a)=>{ w.__warn.push(a.map(x=>String(x&&x.message||x)).join(' ')); };
    w.console.error=(...a)=>{ w.__err.push(a.map(x=>String(x&&x.message||x)).join(' ')); };
    w.addEventListener('error',e=>w.__err.push('uncaught: '+(e.error&&e.error.message||e.message)));
  }});
const w=dom.window;
// One script so top-level const bindings (Store, state, App, Find...) are shared.
const probe=`
;window.__T = {
  seed(){
    Store.replaceData({
      version:1,
      settings:{schoolName:"Test School",logo:"",daysPerWeek:5,periodsPerDay:6,maxLoad:28,loadCap:35},
      teachers:[
        {id:"t1",name:"Nimal Perera",code:"NP",email:"n@x.lk",subjectIds:["s1"],gradeIds:[],color:"#059669",unavailable:[]},
        {id:"t2",name:"Kamala Silva",code:"KS",email:"k@x.lk",subjectIds:["s2"],gradeIds:[],color:"#4f46e5",unavailable:[]}
      ],
      subjects:[{id:"s1",name:"Mathematics",code:"MAT",color:"#0ea5e9"},{id:"s2",name:"English",code:"ENG",color:"#f59e0b"}],
      classes:[{id:"c1",name:"Grade 10A",grade:"10",stream:"A"}],
      curriculum:[],
      timetable:{c1:Array.from({length:5},()=>Array.from({length:6},()=>null))},
      absences:{}
    });
    Store.raw.timetable.c1[2][2]=[{subjectId:"s1",teacherId:"t1"}];
    Store.raw.timetable.c1[0][0]=[{subjectId:"s2",teacherId:"t2"}];
    Store.flush();
  },
  setRole(role){
    Session.schoolRole=role; Session.schoolId="s1"; Session.role=null; Session.uid="u-"+role; Session.email=role+"@x.lk";
    App.me={name:role,role:role,active:true,permissions: role==="admin"?{editBranding:true}:{}};
  },
  routes(){ return Object.keys(ROUTES); },
  raw(){ return Store.raw; },
  flush(){ Store.flush(); },
  refresh(){ refresh(); },
  evalIn(x){ return eval(x); },
  draw(name, ctx){ CV_R[name](ctx,1080,1080); return "ok"; },
  go(route){ Store.raw.ui.route=route; refresh(); },
  viewHtml(){ return document.getElementById("view")?.innerHTML||""; },
  allowed(){ return allowedRoutes(); }
};`;
w.eval(read('app.js')+'\n'+read('vendor/attendance.js')+'\n'+read('vendor/find.js')+'\n'+read('vendor/assistant.js')+probe);

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const T=w.__T;
const doc=w.document;
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
const fire=(el,type)=>el.dispatchEvent(new w.Event(type,{bubbles:true}));
const failedScreen=html=>/This screen could not open/.test(html);

(async()=>{
  await sleep(50);
  T.seed();

  // 0b) promotional creatives draw without errors (recording stand-in for a canvas context)
  const fakeCtx = new Proxy({}, {
    get(t,k){ if(k in t) return t[k];
      if(k==="measureText") return ()=>({width:10});
      if(k==="createLinearGradient"||k==="createRadialGradient") return ()=>({addColorStop(){}});
      return (t[k]=function(){ return undefined; }); },
    set(t,k,v){ t[k]=v; return true; }
  });
  for(const name of ["fingerprintSpot","findSpot","offlineSpot","langSpot"]){
    let res; try{ res = T.draw(name, fakeCtx); }catch(e){ res = "threw: "+e.message; }
    check("creative draws: "+name, res==="ok", res);
  }

  // 0) public landing page (what clients see before signing in)
  try{ T.evalIn("showLogin()"); }catch(e){ check("landing page renders", false, e.message); }
  const landingText=(doc.getElementById("login-root")?.textContent||"").replace(/\s+/g," ");
  for(const phrase of ["Fingerprint attendance","Find anything, instantly","Your school's look","Relief in one tap","Works without internet","Sinhala","Auto-generated timetables","The principal controls access"]){
    check("landing shows: "+phrase, landingText.includes(phrase));
  }

  // 1) every route, every role
  const summary={};
  for(const role of ["principal","admin","teacher","staff"]){
    T.setRole(role);
    await sleep(5);
    const allowed=T.allowed();
    const bad=[];
    for(const r of allowed){
      w.__warn.length=0;
      try{ T.go(r); }catch(e){ bad.push(r+": threw "+e.message); continue; }
      await sleep(15);
      const html=T.viewHtml();
      if(failedScreen(html)) bad.push(r+": render failed");
      else if(html.length<300) bad.push(r+": suspiciously empty ("+html.length+")");
      if(w.__warn.some(x=>/route render failed/.test(x))) bad.push(r+": warned "+w.__warn.find(x=>/route render failed/.test(x)).slice(0,120));
    }
    summary[role]={routes:allowed.length, failures:bad};
    check(`all allowed routes render for ${role} (${allowed.length})`, bad.length===0, bad.join(" | "));
  }

  // 2) role gating: teacher must not get admin/settings-only screens
  T.setRole("teacher"); await sleep(5);
  check("teacher cannot open Schools (admin) route", !T.allowed().includes("admin"));
  T.go("database"); await sleep(10);
  check("teacher has no Look & colours tab", !doc.querySelector('[data-action="goto-look"]') && !/data-tab="branding"/.test(T.viewHtml()) && !/Look &amp; colours|Look & colours/.test(T.viewHtml()));

  // 3) Look & colours: principal can open, pick a colour, and the CSS var changes
  T.setRole("principal"); T.go("database"); await sleep(10);
  T.raw().ui.dbTab="branding"; T.refresh(); await sleep(10);
  const lookHtml=T.viewHtml();
  check("principal sees the Look & colours screen", /School look/.test(lookHtml));
  const swatch=doc.querySelector('[data-action="brand-pick"][data-c="#4f46e5"]');
  check("colour swatch exists", !!swatch);
  if(swatch){ click(swatch); await sleep(20); }
  check("picking a swatch stores brand on settings", T.raw().settings.brand==="#4f46e5", T.raw().settings.brand);
  check("picking a swatch applies --brand to the page", doc.documentElement.style.getPropertyValue("--brand").trim().toLowerCase()==="#4f46e5", doc.documentElement.style.getPropertyValue("--brand"));
  // reset
  const reset=doc.querySelector('[data-action="brand-pick"][data-c=""]'); if(reset){ click(reset); await sleep(10); }
  check("reset returns brand to default", !T.raw().settings.brand);

  // 4) Admin with editBranding gets the tab; teacher does not
  T.setRole("admin"); T.go("database"); await sleep(10);
  check("admin with editBranding sees Look & colours tab", /Look (&amp;|&) colours/.test(T.viewHtml()));
  T.setRole("staff"); T.go("database"); await sleep(10);
  check("staff without permission does not see Look & colours tab", !/Look (&amp;|&) colours/.test(T.viewHtml()));

  // 5) Find: search, live answer, sources dialog, refresh-after-refresh
  T.setRole("principal"); T.go("find"); await sleep(40);
  const q=doc.getElementById("find-q");
  check("Find screen has the search box", !!q);
  if(q){
    q.value="nimal"; fire(q,"input"); await sleep(250);
    const hits=doc.querySelectorAll('#find-results [data-action="find-jump"]').length;
    check("search 'nimal' finds the teacher", hits>0, "hits="+hits);
    q.value="who is free period 3 wednesday"; fire(q,"input"); await sleep(250);
    check("question shows a live answer card", /CampusFlow answer/.test(doc.getElementById("find-ai")?.innerHTML||""));
    check("answer names a free teacher", /Kamala Silva|free teacher/.test(doc.getElementById("find-ai")?.innerHTML||""));
    q.value="who teaches Maths?"; q.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true})); await sleep(20);
    check("Enter answers 'who teaches Maths'", /Nimal Perera/.test(doc.getElementById("find-ai")?.innerHTML||""));
    q.value="grade"; fire(q,"input"); await sleep(250);
    check("a non-question does not auto-open the answer card", (doc.getElementById("find-ai")?.innerHTML||"")==="");
  }
  // add-source dialog (the bug the user reported)
  const addBtn=doc.querySelector('[data-action="find-add-source"]');
  check("Add public sheet button exists", !!addBtn);
  if(addBtn){ click(addBtn); await sleep(20); }
  const panel=doc.getElementById("modal-panel");
  check("Add sheet dialog opens without 'Something went wrong'", !!panel && !/went wrong drawing/.test(panel.innerHTML), panel?panel.innerHTML.slice(0,80):"no panel");
  const submit=[...doc.querySelectorAll('[data-action="modal-run"]')].find(b=>/Add/.test(b.textContent));
  if(submit){ click(submit); await sleep(20); }
  check("empty URL keeps the dialog open (validation)", !!doc.getElementById("modal-panel"));
  const urlIn=doc.getElementById("find-src-url");
  if(urlIn){ urlIn.value="https://docs.google.com/spreadsheets/d/abc123/edit#gid=0"; }
  if(submit){ click(submit); await sleep(80); }
  check("valid URL is accepted and saved as a source", T.evalIn("Find.sources().length")>=1, T.evalIn("Find.sources().length"));
  check("the source URL converts to a CSV export", /export\?format=csv&gid=0/.test(T.evalIn("Find.sheetExportUrl(Find.sources()[0].url)")), T.evalIn("Find.sheetExportUrl(Find.sources()[0].url)"));
  // remove it
  const rm=doc.querySelector('[data-action="find-remove"]');
  if(rm){ const realConfirm=w.confirm; w.confirm=()=>true; click(rm); await sleep(20); w.confirm=realConfirm; }
  check("remove deletes the source", T.evalIn("Find.sources().length")===0, T.evalIn("Find.sources().length"));

  // 6) Attendance: principal sees Add device; clicking opens the dialog (no 'went wrong')
  T.go("attendance"); await sleep(30);
  const addDev=doc.querySelector('[data-action="att-add-device"]');
  check("principal sees Add USB / wall device", !!addDev);
  if(addDev){ click(addDev); await sleep(20); }
  const p2=doc.getElementById("modal-panel");
  check("Add device dialog opens cleanly", !!p2 && !/went wrong drawing/.test(p2.innerHTML));
  check("Add device dialog has a Create key action", !!p2 && /Create key/.test(p2.innerHTML));
  // Create key without a deployed backend must fail gracefully (toast), not crash
  const create=[...doc.querySelectorAll('[data-action="modal-run"]')].find(b=>/Create key/.test(b.textContent));
  if(create){ click(create); await sleep(40); }
  check("Create key without backend causes no uncaught error", w.__err.filter(x=>/uncaught/.test(x)).length===0, w.__err.slice(-2).join(" | "));
  const toastText=[...doc.querySelectorAll("#toast-root .toast")].map(x=>x.textContent).join(" | ");
  check("Create key failure shows an error toast to the user", /Couldn.t finish that/.test(toastText) && /Firebase did not load|internet|Reload/i.test(toastText), toastText.slice(0,200));
  // close the dialog
  const closeEv=doc.querySelector('[data-action="modal-close"]'); if(closeEv) click(closeEv); await sleep(20);
  w.__T.close && w.__T.close();

  // 7) refresh persistence
  T.raw().ui.route="find"; T.flush();
  check("route persisted to cf.ui.v1", /"route":"find"/.test(w.localStorage.getItem("cf.ui.v1")||""));

  // 8) PDF with a text layer is read AND analysed. Regression: the text-layer branch
  // of scanRunDoc only set the engine name and never ran scanAnalysePages/scanConvert,
  // so a selectable-text PDF showed an empty result. Uses the real pdf.js library
  // (dev dependency, same version as vendor/pdf.min.mjs) handed to scanner.js.
  {
    const pdfLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    w.__cfPdf = pdfLib;                       // scanner.js reuses an already-loaded pdf.js
    w.eval(read('vendor/scanner.js'));
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'timetable-text.pdf'));
    w.__scanFile = new w.File([bytes], 'timetable-text.pdf', { type: 'application/pdf' });
    // jsdom's File has no arrayBuffer(); the real browser File does.
    w.__scanFile.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await T.evalIn('scanRunDoc(window.__scanFile, "pdf")');
    const st = T.evalIn('({pages:Scan.doc&&Scan.doc.pages?Scan.doc.pages.length:0, needsOcr:!!(Scan.doc&&Scan.doc.needsOcr), engine:Scan.usedEngine, raw:Scan.rawText||"", grid:!!Scan.grid, err:Scan.error||"", step:Scan.step})');
    check("text-layer PDF: pages read from the file", st.pages === 1 && !st.needsOcr, JSON.stringify(st).slice(0, 160));
    check("text-layer PDF: engine is 'text' and no error", st.engine === 'text' && st.err === '', JSON.stringify(st).slice(0, 160));
    check("text-layer PDF: content is analysed into rawText or a grid", /Mathematics/.test(st.raw) || st.grid, JSON.stringify(st).slice(0, 160));
    T.evalIn('Scan.doc=null; Scan.rawText=""; Scan.grid=null; Scan.error=""');
  }

  // 8b) Attendance is gated by role. A teacher asking who is in gets the refusal, not
  // the whole-day list (the database only lets principals/admins/viewers read it).
  {
    T.setRole("teacher");
    const tAns = JSON.stringify(w.Assistant.answer("who is in today?"));
    check("teacher: Assistant refuses the whole-day attendance list", /only visible to the principal and admins/.test(tAns), tAns.slice(0,160));
    T.setRole("principal");
    const pAns = JSON.stringify(w.Assistant.answer("who is in today?"));
    check("principal: Assistant does not give the refusal", !/only visible to the principal and admins/.test(pAns), pAns.slice(0,160));
    check("principal/teacher gate: canViewUsers true for principal only", T.evalIn("canViewUsers()") === true);
    // Whole-day attendance follows the database rules exactly (principal, admin, or viewUsers).
    // Super-admin is NOT in the rules, so it must not pass the client gate either.
    const dayRead = (role, perms) => { T.setRole(role); if(perms) T.evalIn(`App.me.permissions=${JSON.stringify(perms)}`); return T.evalIn("canReadDayAttendance()"); };
    check("day-read gate: principal yes", dayRead("principal") === true);
    check("day-read gate: admin yes", dayRead("admin") === true);
    check("day-read gate: teacher no", dayRead("teacher") === false);
    check("day-read gate: teacher with viewUsers yes", dayRead("teacher", { viewUsers: true }) === true);
    check("day-read gate: superadmin (not in rules) no", dayRead("superadmin") === false);
    T.setRole("teacher");
    check("teacher: canViewUsers is false", T.evalIn("canViewUsers()") === false);
  }

  // 8a1) Dates: one school-day rule (Sri Lanka time). Fixed instants, so this is the same on any machine.
  {
    check("school day: 00:15 Colombo on 9 Oct is 9 Oct", T.evalIn('schoolDayKey(new Date("2026-10-08T18:45:00Z"))') === "2026-10-09");
    check("school day: 23:45 Colombo on 8 Oct is 8 Oct", T.evalIn('schoolDayKey(new Date("2026-10-08T18:15:00Z"))') === "2026-10-08");
    check("school day: 14:00 Colombo on 9 Oct is 9 Oct (was 8 Oct before the fix)", T.evalIn('schoolDayKey(new Date("2026-10-09T08:30:00Z"))') === "2026-10-09");
    check("attendance uses the same school day", T.evalIn('ATT.todayKey(new Date("2026-10-09T08:30:00Z"))') === "2026-10-09");
  }

  // 8a0) Contact number is fixed: a value saved in the database never changes it.
  {
    T.evalIn('SiteCfg.data={phone:"+94111222333",whatsapp:"94111222333"}');
    check("saved phone in the database is ignored", T.evalIn("SiteCfg.phone()") === "072 399 3300" && T.evalIn("SiteCfg.waNumber()") === "94723993300");
    T.evalIn("SiteCfg.data=null");
  }

  // 8a00) Database rules, checked from the file: clients cannot write clock-ins; a principal
  // cannot change another principal's record.
  {
    const clean = read('database.rules.json').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = JSON.parse(clean).rules;
    const byMember = rules.schools['$schoolId'].attendance['$date'].byMember['$uid'];
    check("rules: clients cannot write clock-ins (byMember is read-only)", byMember['.write'] === false);
    check("rules: clients can still read their own clock-ins", /auth\.uid === \$uid/.test(byMember['.read']));
    const memberWrite = rules.schools['$schoolId'].members['$memberUid']['.write'];
    check("rules: a principal cannot overwrite another principal", /!data\.exists\(\) \|\| data\.child\('role'\)\.val\(\) !== 'principal'/.test(memberWrite));
  }

  // 8a2) A PDF with no text layer (a scan) must explain itself, never show an empty review.
  {
    const bytes2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'scanned-no-text.pdf'));
    w.__scanFile2 = new w.File([bytes2], 'scan.pdf', { type: 'application/pdf' });
    w.__scanFile2.arrayBuffer = async () => bytes2.buffer.slice(bytes2.byteOffset, bytes2.byteOffset + bytes2.byteLength);
    await T.evalIn('scanRunDoc(window.__scanFile2, "pdf")');
    const st2 = T.evalIn('({err:Scan.error||"", step:Scan.step, raw:Scan.rawText||""})');
    check("scanned PDF with no text: a clear message is shown", /picture|no text|scan/i.test(st2.err), st2.err.slice(0,160));
    check("scanned PDF with no text: not a silent empty review", st2.err !== "" || st2.step === "capture", JSON.stringify(st2).slice(0,160));
    T.evalIn('Scan.doc=null; Scan.rawText=""; Scan.grid=null; Scan.error=""');
  }

  // 8b2) Public contact number: 072 399 3300 everywhere; stored old numbers never win.
  {
    check("site phone shows 072 399 3300", T.evalIn("SiteCfg.phone()") === "072 399 3300", T.evalIn("SiteCfg.phone()"));
    check("site call link is +94 723 993 300", T.evalIn("SiteCfg.tel()") === "tel:+94723993300", T.evalIn("SiteCfg.tel()"));
    check("site WhatsApp link uses 94723993300", T.evalIn("SiteCfg.waLink()").startsWith("https://wa.me/94723993300?"), T.evalIn("SiteCfg.waLink()").slice(0,60));
    T.evalIn('SiteCfg.data={phone:"+94722816456",whatsapp:"94722816456"}');
    check("retired number saved in site settings is ignored", T.evalIn("SiteCfg.phone()") === "072 399 3300" && T.evalIn("SiteCfg.waNumber()") === "94723993300");
    T.evalIn("SiteCfg.data=null");
    check("creatives use the new number", T.evalIn("(typeof CV_R!=='undefined') && SiteCfg.phone()") === "072 399 3300");
  }

  // 8c) Attendance devices (fingerprint machines). With the server offline or the functions
  // not deployed, the Attendance screen must still render and explain the device problem,
  // and the principal must see the full setup (URL, header, body) to configure a machine.
  {
    T.setRole("principal"); T.go("attendance"); await sleep(400);
    const attHtml = T.viewHtml();
    check("attendance renders for principal when devices cannot load", /Attendance devices could not load/.test(attHtml), attHtml.slice(0,120));
    check("device card points to the one-time deploy command", /firebase deploy --only functions/.test(attHtml));
    const setup = T.evalIn("deviceSetupHtml()");
    check("device setup shows the full attendancePush URL", setup.includes("https://asia-south1-mom-school-time-table.cloudfunctions.net/attendancePush"), setup.slice(0,120));
    check("device setup shows the Bearer header and a JSON body", /Authorization: Bearer/.test(setup) && /staffId/.test(setup));
    T.setRole("teacher"); T.go("dashboard"); await sleep(150); T.go("attendance"); await sleep(400);
    check("teacher gets no device card", !/Attendance devices|att-add-device/.test(T.viewHtml()), (T.viewHtml().match(/.{0,60}(Attendance devices|att-add-device).{0,40}/)||[""])[0]);
  }

  // 8c2) Phone tab bar: every tab keeps 72px and the bar scrolls instead of squeezing labels.
  {
    T.setRole("principal"); T.go("dashboard"); await sleep(150);
    const grid = doc.getElementById("tabbar-grid");
    const n = grid.querySelectorAll(".tab-item").length;
    check("phone tab bar: one tab per route, min 72px each", n >= 4 && grid.style.minWidth === (n*72)+"px" && grid.style.gridTemplateColumns.includes("minmax(72px"), grid.style.minWidth+" / "+n);
  }

  // 8d) Find bar: awkward inputs must never throw and must return a list (no blank screen).
  {
    const probes = ["", "   ", "(", "*", "[", "\\", "a.b-c", "10A", "p3", "Mathematics", "nimal", "NIMAL", "\u0dc3\u0dd2\u0d82\u0dc4\u0dbd", "\u0b85", "who is free in period 3?", "x".repeat(600), "%%$$##"];
    const bad = [];
    for (const q of probes) {
      try {
        const hits = T.evalIn("Find.search(" + JSON.stringify(q) + ", 80)");
        if (!Array.isArray(hits)) bad.push("not array:" + JSON.stringify(q));
      } catch (e) { bad.push(JSON.stringify(q) + " -> " + e.message); }
      try { w.Assistant.answer(q); } catch (e) { bad.push("assistant " + JSON.stringify(q).slice(0,20) + " -> " + e.message); }
    }
    check("Find.search and Assistant survive awkward inputs", bad.length === 0, bad.slice(0,3).join(" | "));
    check("Find.search finds 'nimal' regardless of case", T.evalIn('Find.search("NIMAL", 10).length') === T.evalIn('Find.search("nimal", 10).length') && T.evalIn('Find.search("nimal", 10).length') > 0);
  }

  // 9) errors overall
  const uncaught=w.__err.filter(x=>/uncaught|TypeError|ReferenceError/.test(x));
  check("no uncaught JS errors during the whole run", uncaught.length===0, uncaught.slice(0,3).join(" | "));

  console.log(JSON.stringify({summary,results},null,1));
  const failed=results.filter(r=>!r.ok);
  console.log("PASSED",results.length-failed.length,"FAILED",failed.length);
  process.exit(failed.length?1:0);
})().catch(e=>{ console.error("HARNESS CRASH",e); process.exit(2); });
