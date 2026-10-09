/* Find: universal search + optional AI answers over school data + public sheets.
   - Local fuzzy search is always available, fully offline.
   - AI answers only when the user adds a Google AI Studio key (same key the
     Scanner already uses) AND they click "Ask AI" — no background calls.
   - Public Google Sheets are imported ONCE by a server function (browsers cannot
     read Google Sheets directly). The CSV is stored in the school's Firebase data
     and cached on each device, so searches are instant and work offline. */

const Find = (()=>{
  const L = (...a)=>console.log("[Find]",...a);
  // --- tokenisation / fuzzy scoring ---
  const STOP = new Set(["a","an","the","and","or","of","to","for","in","on","at","is","are","was","be","by","with","from","that","this","these","those","i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","its","our","their","ඒ","මම","අපි","ඔබ","ඔහු","ඇය","මේ","අර","එක","සහ","හා","පාඩම","පෙළ","ඇති"]);
  function norm(s){
    return String(s||"").toLowerCase()
      .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
      .replace(/[^a-z0-9\u0D80-\u0DFF\u0B80-\u0BFF\s.\-]/g," ")
      .replace(/\s+/g," ").trim();
  }
  function tokens(s){
    return norm(s).split(/[\s.\-]+/).filter(w=>w && w.length>1 && !STOP.has(w));
  }
  function score(hay, qnorm){
    if(!hay||!qnorm) return 0;
    const h = norm(hay);
    if(!h) return 0;
    if(h.includes(qnorm)) return 100;
    const ws = tokens(qnorm); if(!ws.length) return 0;
    let sc = 0;
    for(const w of ws){
      if(!w) continue;
      if(h.includes(w)) sc += w.length>=4 ? 8 : 4;
      else {
        // cheap character overlap for Sinhala/Tamil diacritics & typos
        let hits=0;
        for(const ch of w) if(h.includes(ch)) hits++;
        sc += Math.min(4, Math.floor(hits/Math.max(1,w.length)*4));
      }
    }
    return sc;
  }

  // --- sources ---
  // Sheets are imported ONCE by the server (findSheetImport), which stores the CSV in
  // Firebase under schools/{sid}/findSources. Every device keeps a local copy so searches
  // are instant and work offline. Local copies that are damaged are ignored, never crash.
  let _idx = null;
  let _cloud = { importSheet:null, removeSheet:null, readCloud:null };
  function configure(c){ _cloud = Object.assign({}, _cloud, c||{}); }
  function cleanSource(s){
    if(!s || typeof s!=="object") return null;
    const id = String(s.id||"");
    if(!id) return null;
    return {
      id,
      label: String(s.label||"Sheet").slice(0,80) || "Sheet",
      url: typeof s.url==="string" ? s.url : "",
      addedAt: Number(s.addedAt)||0,
      fetchedAt: Number(s.fetchedAt)||0,
      rows: Array.isArray(s.rows) ? s.rows.filter(r=>Array.isArray(r)) : [],
      csv: typeof s.csv==="string" ? s.csv : "",
      rowCount: Number(s.rowCount)||0,
      error: typeof s.error==="string" ? s.error : ""
    };
  }
  function sources(){
    let raw;
    try{ raw = safeStore.jsonGet("find.sources."+Session.schoolId, []); }catch(e){ raw = []; }
    if(!Array.isArray(raw)) return [];
    return raw.map(cleanSource).filter(Boolean);
  }
  function saveSources(list){
    safeStore.jsonSet("find.sources."+Session.schoolId, list.map(cleanSource).filter(Boolean));
  }
  function upsertLocal(entry){
    const list = sources().filter(s=>s.id!==entry.id);
    list.unshift(cleanSource(entry));
    saveSources(list);
    return cleanSource(entry);
  }
  // Ask the server to read the Google Sheet, store it in Firebase and return it.
  async function importSheet(label, url){
    if(!_cloud.importSheet) throw new Error("Sheet import is not available right now.");
    const rec = await _cloud.importSheet(String(label||"Sheet"), String(url||"").trim());
    if(!rec || typeof rec.csv!=="string") throw new Error("The server did not return the sheet data.");
    const existing = sources().find(s=>s.id===rec.id);
    return upsertLocal({
      id: rec.id, label: rec.label||label, url: rec.url||url,
      addedAt: existing ? existing.addedAt : Date.now(),
      fetchedAt: rec.fetchedAt||Date.now(), csv: rec.csv,
      rows: parseCSV(rec.csv), rowCount: rec.rowCount||0, error:""
    });
  }
  function addSource(label, url){ return importSheet(label, url); }
  function removeSource(id){
    saveSources(sources().filter(s=>s.id!==id));
    if(_cloud.removeSheet && String(id).indexOf("sheet_")===0){
      Promise.resolve().then(()=>_cloud.removeSheet(id)).catch(e=>L("remove failed",e&&e.message));
    }
  }
  // Pull sheets the school has already imported (newer copies replace local ones).
  // Sheets deleted in the cloud are dropped locally. Returns the number of changes.
  async function syncFromCloud(){
    if(!_cloud.readCloud) return 0;
    const cloud = await _cloud.readCloud() || {};
    const list = sources();
    let changed = 0;
    const next = list.filter(s=>{
      if(String(s.id).indexOf("sheet_")!==0) return true;   // legacy local-only entries stay
      const keep = !!cloud[s.id];
      if(!keep) changed++;
      return keep;
    });
    for(const [id, rec] of Object.entries(cloud)){
      if(!rec || typeof rec.csv!=="string") continue;
      const local = next.find(s=>s.id===id);
      if(local && (local.fetchedAt||0) >= (Number(rec.fetchedAt)||0) && local.csv===rec.csv) continue;
      const entry = cleanSource({
        id, label: rec.label||"Sheet", url: rec.url||"", addedAt: local ? local.addedAt : (Number(rec.fetchedAt)||Date.now()),
        fetchedAt: Number(rec.fetchedAt)||Date.now(), csv: rec.csv, rows: parseCSV(rec.csv), rowCount: rec.rowCount||0, error:""
      });
      const i = next.findIndex(s=>s.id===id);
      if(i>=0) next[i]=entry; else next.unshift(entry);
      changed++;
    }
    if(changed){ saveSources(next); _idx = null; }
    return changed;
  }
  function sheetExportUrl(url){
    const m = String(url||"").match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if(!m) return null;
    const gidm = String(url).match(/gid=(\d+)/);
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gidm?gidm[1]:"0"}`;
  }
  function parseCSV(text){
    const out=[];
    let row=[], cell="", inQ=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i], nx=text[i+1];
      if(inQ){
        if(ch==='"' && nx==='"'){ cell+='"'; i++; }
        else if(ch==='"') inQ=false;
        else cell+=ch;
      } else {
        if(ch==='"') inQ=true;
        else if(ch===","){ row.push(cell); cell=""; }
        else if(ch==="\n"){ row.push(cell); out.push(row); row=[]; cell=""; }
        else if(ch==="\r"){ /* skip */ }
        else cell+=ch;
      }
    }
    if(cell.length||row.length){ row.push(cell); out.push(row); }
    return out.filter(r=>r.some(c=>String(c||"").trim().length));
  }
  function sheetRowsToDocs(src){
    const rows = (src.rows && src.rows.length) ? src.rows : parseCSV(src.csv||"");
    if(rows.length<2) return [];
    const headers = rows[0].map(h=>String(h||"").trim());
    const docs=[];
    for(let i=1;i<rows.length;i++){
      const r=rows[i];
      const bits=[];
      for(let c=0;c<headers.length;c++){
        const v = String(r[c]||"").trim();
        if(v) bits.push((headers[c]?headers[c]+": ":"")+v);
      }
      if(!bits.length) continue;
      docs.push({
        kind:"sheet",
        sourceId: src.id,
        sourceLabel: src.label,
        row: i,
        title: String(r[0]||("Row "+i)),
        body: bits.join(" · "),
        raw: r,
        headers
      });
    }
    return docs;
  }

  // --- build the local index from the app state ---
  function buildDocs(){
    const docs = [];
    const S_ = (id)=>(state.subjects||[]).find(x=>x.id===id);
    const T_ = (id)=>(state.teachers||[]).find(x=>x.id===id);
    const C_ = (id)=>(state.classes||[]).find(x=>x.id===id);
    // teachers
    (state.teachers||[]).forEach(t=>{
      const subs=(t.subjectIds||[]).map(s=>S_(s)?.name).filter(Boolean).join(", ");
      const grades=(t.gradeIds||[]).join(", ");
      docs.push({kind:"teacher", id:t.id, title:t.name, body:[t.code,subs,grades,t.email,t.phone].filter(Boolean).join(" · "), item:t});
    });
    // subjects
    (state.subjects||[]).forEach(s=>{
      docs.push({kind:"subject", id:s.id, title:s.name, body:[s.code].filter(Boolean).join(" · "), item:s});
    });
    // classes
    (state.classes||[]).forEach(c=>{
      const ct = c.classTeacherId?T_(c.classTeacherId)?.name:"";
      docs.push({kind:"class", id:c.id, title:c.name, body:[c.grade,c.stream,c.house,ct?"Class teacher: "+ct:""].filter(Boolean).join(" · "), item:c});
    });
    // timetable cells
    (state.classes||[]).forEach(c=>{
      Object.entries(state.timetable?.[c.id]||{}).forEach(([d,row])=>{
        Object.entries(row||{}).forEach(([p,lessons])=>{
          (Array.isArray(lessons)?lessons:[lessons]).forEach((L_,li)=>{
            if(!L_||!L_.subjectId) return;
            const sub = S_(L_.subjectId);
            const t = T_(L_.teacherId);
            const room = L_.room;
            docs.push({kind:"slot", id:c.id+"|"+d+"|"+p+"|"+li,
              title: (c.name||"")+" · "+["Mon","Tue","Wed","Thu","Fri","Sat"][+d]+" P"+(+p+1),
              body:[sub?.name,t?.name?("with "+t.name):"",room?("Room "+room):""].filter(Boolean).join(" · "),
              item:{ classId:c.id, d:+d, p:+p, li:+li, subjectId:L_.subjectId, teacherId:L_.teacherId, room }});
          });
        });
      });
    });
    // attendance — today + recent 14 days
    Object.entries(state._attendance||{}).forEach(([date,day])=>{
      Object.entries(day?.byMember||{}).forEach(([uid,rec])=>{
        const m=T_(uid); const name=m?.name||uid;
        const evs=rec.events?Object.values(rec.events).sort((a,b)=>(a.at||0)-(b.at||0)):[];
        const last=evs[evs.length-1];
        if(!last) return;
        docs.push({kind:"attendance", id:date+"/"+uid, title:name+" · "+date,
          body: (last.kind==="in"?"Clocked in ":"Clocked out ")+new Date(last.at).toLocaleTimeString()+(last.method?(" via "+last.method):"")+(last.deviceLabel?" on "+last.deviceLabel:""),
          item:{date,uid,...last,name}});
      });
    });
    // members
    Object.entries(App.members||{}).forEach(([uid,m])=>{
      if(!m) return;
      docs.push({kind:"member", id:uid, title:m.name||m.email||uid, body:[m.email,m.role,m.active?"active":"inactive",m.teacherId?"teacher:"+m.teacherId:""].filter(Boolean).join(" · "), item:m});
    });
    // public sheet rows
    sources().forEach(src=>{ sheetRowsToDocs(src).forEach(d=>docs.push(d)); });
    return docs;
  }

  function search(q, limit=60){
    if(!_idx) _idx = buildDocs();
    const qn = norm(q);
    if(!qn) return [];
    const ws = tokens(q);
    const res = [];
    _idx.forEach(d=>{
      const s1 = score(d.title, qn);
      const s2 = score(d.body, qn);
      const s = Math.max(s1*1.4, s2);
      if(s>=5) res.push({...d, score:s});
    });
    res.sort((a,b)=>b.score-a.score);
    return res.slice(0,limit);
  }

  // --- AI call ---
  function refresh(){ _idx = buildDocs(); }

  return { search, sources, configure, importSheet, addSource, removeSource, syncFromCloud, refresh, sheetExportUrl, parseCSV, tokens, norm, score };
})();

window.Find = Find;
