/* Find: universal search + optional AI answers over school data + public sheets.
   - Local fuzzy search is always available, fully offline.
   - AI answers only when the user adds a Google AI Studio key (same key the
     Scanner already uses) AND they click "Ask AI" — no background calls.
   - Public Google Sheet URLs are fetched as CSV from the device, parsed into
     rows, added to the local index. They live in the browser (localStorage per
     school) so they don't bloat Firebase; refresh is one tap. */

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
  let _idx = null;
  function sources(){
    return safeStore.jsonGet("find.sources."+Session.schoolId, []);
  }
  function saveSources(list){
    safeStore.jsonSet("find.sources."+Session.schoolId, list);
  }
  function addSource(label, url){
    const list=sources();
    const id = "src_"+Date.now().toString(36);
    list.unshift({ id, label:String(label||"").slice(0,80)||"Sheet", url:String(url||"").trim(), addedAt:Date.now(), rows:[], fetchedAt:0, error:"" });
    saveSources(list);
    return list[0];
  }
  function removeSource(id){
    saveSources(sources().filter(s=>s.id!==id));
  }
  function sheetExportUrl(url){
    // Accept any public Google Sheets URL and return the /export?format=csv link
    // for the first sheet. "/edit", "/edit#gid=0", "/pubhtml" all accepted.
    const m = String(url||"").match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if(!m) return null;
    const gidm = String(url).match(/gid=(\d+)/);
    const gid = gidm ? gidm[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  async function fetchSource(src){
    const csv = sheetExportUrl(src.url);
    if(!csv){ src.error="That doesn't look like a Google Sheet link."; return src; }
    try{
      const r = await fetch(csv, { cache:"no-store" });
      if(!r.ok) throw new Error("HTTP "+r.status);
      const text = await r.text();
      const rows = parseCSV(text);
      src.rows = rows;
      src.fetchedAt = Date.now();
      src.error = "";
    }catch(e){
      src.error = "Could not read this sheet ("+(e.message||"link not public")+"). Make sure it is shared as 'Anyone with the link can view'.";
      src.rows = [];
    }
    const all = sources();
    const i = all.findIndex(s=>s.id===src.id);
    if(i>=0){ all[i]=src; saveSources(all); }
    return src;
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
    const rows = src.rows||[];
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
  async function ask(q, onProgress){
    const key = (Scan.aiKey||"").trim() || localStorage.getItem("cf.aiKey")||"";
    if(!key) throw new Error("Add your Google AI Studio key in the Scanner (Settings → AI reader) to ask questions, or use local search — it works offline.");
    if(!navigator.onLine) throw new Error("AI answers need internet. Local search above works offline.");
    const hits = search(q, 30);
    const ctxBlocks = hits.slice(0,16).map((h,i)=>{
      const label = {teacher:"Teacher",subject:"Subject",class:"Class",slot:"Lesson",attendance:"Attendance",member:"User",sheet:("Sheet: "+h.sourceLabel)}[h.kind]||h.kind;
      return `[${i+1}] (${label}) ${h.title} — ${h.body}`;
    });
    const sheetStatus = sources().map(s=>`- ${s.label}: ${s.rows?s.rows.length-1:"0"} rows, fetched ${s.fetchedAt?new Date(s.fetchedAt).toLocaleString():"never"}${s.error?" (error: "+s.error+")":""}`).join("\n");
    const sys = `You are the Find assistant inside CampusFlow, a school timetable app. Answer briefly and factually, in the same language the user asked. Use ONLY the facts in the DATA block below. If the data does not contain the answer, say "I don't see that in the school's data yet — add a public sheet link with more data, or ask differently." End with a short "Sources:" line listing the [n] items you used.

School: ${state.settings.schoolName||"School"}.
Days per week: ${state.settings.daysPerWeek}, periods per day: ${state.settings.periodsPerDay}, teachers: ${(state.teachers||[]).length}, classes: ${(state.classes||[])}.
${sheetStatus?("Linked sheets:\n"+sheetStatus):"No linked sheets."}

DATA:
${ctxBlocks.join("\n")||"(no matching data)"}

Question: ${q}`;
    const model = defaultGeminiModel();
    onProgress?.("asking…");
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",{
      method:"POST", headers:{"Content-Type":"application/json","x-goog-api-key":key},
      body: JSON.stringify({ contents:[{ parts:[{text:sys}] }], generationConfig:{temperature:0.2,maxOutputTokens:1024} })
    });
    if(!r.ok){
      const t = await r.text().catch(()=>"");
      if(r.status===400&&/API key/i.test(t)) throw new Error("That AI key was rejected. Open Scanner → Settings and check it.");
      if(r.status===429) throw new Error("AI is rate-limiting right now — retry in a minute, or use local search.");
      throw new Error("AI error "+r.status);
    }
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("\n")||"";
    if(!text.trim()) throw new Error("The AI returned an empty answer. Try rephrasing.");
    return { answer: text, hits: hits.slice(0,8) };
  }

  function refresh(){ _idx = buildDocs(); }

  return { search, ask, sources, addSource, removeSource, fetchSource, refresh, sheetExportUrl, parseCSV, tokens, norm };
})();

window.Find = Find;
