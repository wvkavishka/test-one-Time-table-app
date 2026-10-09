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
    w.HTMLCanvasElement.prototype.getContext=()=>null; w.scrollTo=()=>{}; w.HTMLElement.prototype.scrollIntoView=function(){};
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

  // 8) errors overall
  const uncaught=w.__err.filter(x=>/uncaught|TypeError|ReferenceError/.test(x));
  check("no uncaught JS errors during the whole run", uncaught.length===0, uncaught.slice(0,3).join(" | "));

  console.log(JSON.stringify({summary,results},null,1));
  const failed=results.filter(r=>!r.ok);
  console.log("PASSED",results.length-failed.length,"FAILED",failed.length);
  process.exit(failed.length?1:0);
})().catch(e=>{ console.error("HARNESS CRASH",e); process.exit(2); });
