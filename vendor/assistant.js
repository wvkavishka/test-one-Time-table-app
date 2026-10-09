/* CampusFlow Assistant: offline, no API keys, no network.
   Reads the school's own in-memory data (state, timetable, attendance, linked
   sheets via Find) and answers common school questions with cited sources.
   It is a rule-based intent matcher, not a language model, so it never invents
   facts: if it cannot find something it says so and shows the closest matches. */
const Assistant = (()=>{
  const DAY_EN = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const DAY_WORDS = [
    [/\b(mon|monday)\b|සඳුදා|திங்கள்/, 0],
    [/\b(tue|tues|tuesday)\b|අඟහරුවාදා|செவ்வாய்/, 1],
    [/\b(wed|wednesday)\b|බදාදා|புதன்/, 2],
    [/\b(thu|thur|thurs|thursday)\b|බ්‍රහස්පතින්දා|வியாழன்/, 3],
    [/\b(fri|friday)\b|සිකුරාදා|வெள்ளி/, 4],
    [/\b(sat|saturday)\b|සෙනසුරාදා|சனி/, 5],
  ];
  const TODAY = () => { const d=(new Date().getDay()+6)%7; return d; }; // Mon=0

  const norm = s => Find.norm(String(s||""));
  const fz = (hay, q) => Find.score(String(hay||""), q); // 0 if no match

  function dayFrom(q){ for(const [re,i] of DAY_WORDS){ if(re.test(q.toLowerCase())) return i; } return null; }
  function periodFrom(q){
    const m = String(q).toLowerCase().match(/\b(?:p|period|per)\s?([1-9]\d?)\b/);
    return m ? (+m[1]-1) : null;
  }
  const bell = p => { const m=BELL_START+p*BELL_STEP; return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0"); };
  const lessons = cell => (typeof lessonsOf==="function") ? lessonsOf(cell) : (Array.isArray(cell)?cell:(cell?[cell]:[]));
  const tById = id => (state.teachers||[]).find(x=>x.id===id);
  const sById = id => (state.subjects||[]).find(x=>x.id===id);
  const cById = id => (state.classes||[]).find(x=>x.id===id);
  const daysN = () => state.settings.daysPerWeek||5;
  const periodsN = () => state.settings.periodsPerDay||7;

  function bestTeacher(qn){
    let best=null, bs=0;
    (state.teachers||[]).forEach(t=>{
      const s=Math.max(fz(t.name,qn), fz(t.code,qn), fz(t.email,qn));
      if(s>bs){ bs=s; best=t; }
    });
    return bs>=8 ? best : null;
  }
  function bestSubject(qn){
    let best=null, bs=0;
    (state.subjects||[]).forEach(s=>{ const sc=Math.max(fz(s.name,qn), fz(s.code,qn)); if(sc>bs){ bs=sc; best=s; } });
    return bs>=8 ? best : null;
  }
  function bestClass(qn){
    let best=null, bs=0;
    (state.classes||[]).forEach(c=>{ const sc=fz(c.name,qn); if(sc>bs){ bs=sc; best=c; } });
    return bs>=8 ? best : null;
  }
  function isBusyFor(tid,d,p){ return !!busyAtSlot(tid,d,p); }
  function teacherFree(t,d,p){ return !isBusyFor(t.id,d,p) && !(typeof isBlocked==="function" && isBlocked(t,d,p)); }

  function result(lines, sources){ return { text: lines.filter(x=>x!==null&&x!==undefined&&x!=="").join("\n"), sources: sources||[] }; }

  function answer(raw){
    const q = String(raw||"").trim();
    if(!q) return result(["Ask about your school: who teaches a subject, who is free, where a class is, who is in today, or anything in your linked sheets."]);
    const qn = norm(q);
    const d = dayFrom(q);
    const dd = d!=null ? d : TODAY();
    const p = periodFrom(q);
    const t = bestTeacher(qn), s = bestSubject(qn), c = bestClass(qn);
    const src = [];

    if(dd>=daysN()) return result(["That's outside the school week."]);

    // 1) Who is free (optionally for a class / period)
    if(/\b(free|available|absent|off)\b/.test(q.toLowerCase()) && !t){
      const per = p!=null ? p : null;
      if(per==null) return result(["Tell me the period, e.g. \"who is free period 3 wednesday\"."]);
      if(per>=periodsN()) return result(["That period is outside the school day."]);
      const list = (state.teachers||[]).filter(x=>teacherFree(x,dd,per) && (!c || (typeof canTeachClass==="function"? canTeachClass(x,c.id):true)));
      const when = `${DAY_EN[dd]} period ${per+1} (${bell(per)})${c?" for "+c.name:""}`;
      if(!list.length) return result([`No free teachers ${when}.`]);
      list.slice(0,12).forEach(x=>src.push({kind:"teacher",id:x.id,title:x.name,detail:"free "+when}));
      return result([`${list.length} free ${list.length===1?"teacher":"teachers"} ${when}:`, list.slice(0,12).map(x=>"• "+x.name+(x.code?" ("+x.code+")":"")).join("\n"), list.length>12?`…and ${list.length-12} more.`:""], src);
    }

    // 2) A teacher's own free periods
    if(t && /\bfree\b|\bavailable\b/.test(q.toLowerCase())){
      const frees=[]; for(let pp=0;pp<periodsN();pp++) if(teacherFree(t,dd,pp)) frees.push(pp);
      src.push({kind:"teacher",id:t.id,title:t.name,detail:DAY_EN[dd]});
      if(!frees.length) return result([`${t.name} has no free periods on ${DAY_EN[dd]}.`], src);
      return result([`${t.name} is free on ${DAY_EN[dd]} during:`, frees.map(pp=>`• Period ${pp+1} (${bell(pp)})`).join("\n")], src);
    }

    // 3) Who teaches a subject
    if(s && /\bteach|teaches|who\b/.test(q.toLowerCase())){
      const list=(state.teachers||[]).filter(x=>(x.subjectIds||[]).includes(s.id));
      if(!list.length) return result([`No teacher is assigned to ${s.name} yet. Add it in Database → Teachers.`]);
      list.slice(0,10).forEach(x=>src.push({kind:"teacher",id:x.id,title:x.name,detail:s.name}));
      return result([`${s.name}${s.code?" ("+s.code+")":""} is taught by ${list.length} teacher${list.length>1?"s":""}:`, list.slice(0,10).map(x=>"• "+x.name+(x.code?" ("+x.code+")":"")).join("\n")], src);
    }

    // 4) Where is a teacher / a class / a subject right now
    if(/\bwhere\b|\bwhich class\b|\broom\b/.test(q.toLowerCase()) && (t||s||c)){
      const hits=[];
      (state.classes||[]).forEach(cls=>{
        for(let pp=0;pp<periodsN();pp++){
          if(p!=null && pp!==p) continue;
          lessons(getCell(cls.id,dd,pp)).forEach(L=>{
            if(t && L.teacherId!==t.id) return;
            if(s && L.subjectId!==s.id) return;
            if(c && cls.id!==c.id) return;
            hits.push({cls,pp,L});
          });
        }
      });
      if(!hits.length) return result([`Nothing scheduled ${DAY_EN[dd]}${p!=null?" period "+(p+1):""} for ${(t||s||c).name}.`]);
      const h=hits[0];
      const who = t?t.name:(s?s.name:h.cls.name);
      src.push({kind:"slot",id:h.cls.id+"|"+dd+"|"+h.pp,title:h.cls.name+" · "+DAY_EN[dd]+" P"+(h.pp+1),detail:who});
      return result([`${who} is with ${h.cls.name} on ${DAY_EN[dd]}, period ${h.pp+1} (${bell(h.pp)})${sById(h.L.subjectId)?", "+sById(h.L.subjectId).name:""}.`, hits.length>1?`(${hits.length} matching lessons; showing the first.)`:""], src);
    }

    // 5) About a teacher
    if(t){
      const subs=(t.subjectIds||[]).map(id=>sById(id)?.name).filter(Boolean);
      src.push({kind:"teacher",id:t.id,title:t.name,detail:"Profile"});
      const lines=[`${t.name}${t.code?" ("+t.code+")":""}.`];
      if(subs.length) lines.push("Subjects: "+subs.join(", ")+".");
      const slots=(typeof slotsOfTeacherOn==="function")?slotsOfTeacherOn(t.id,dd):[];
      lines.push(slots.length?`${DAY_EN[dd]}: ${slots.length} period${slots.length>1?"s":""}, first at ${bell(slots[0].p)}.`:`No lessons on ${DAY_EN[dd]}.`);
      return result(lines, src);
    }

    // 6) Who is in today (attendance)
    if(/\b(in today|present|attendance|signed in|clocked in|who is in)\b/.test(q.toLowerCase())){
      const k=(window.ATT&&ATT.todayKey)?ATT.todayKey():localDateKey(new Date());
      const day=(state._attendance||{})[k];
      const mayRead = typeof window.canReadDayAttendance==="function" ? window.canReadDayAttendance() : (typeof canViewUsers==="function" && canViewUsers());
      if(!mayRead) return result(["Attendance is only visible to the principal and admins."]);
      if(day===undefined) return result(["Today's attendance has not loaded yet. Give it a moment, or open Attendance."]);
      if(!day) return result(["Nobody has clocked in today yet."]);
      const ins=[];
      Object.entries(day.byMember||{}).forEach(([uid,rec])=>{
        const st=(window.ATT&&ATT.latestStatus)?ATT.latestStatus(rec):{status:"away"};
        if(st.status==="in"){ const m=tById(uid)||(state.members||{})[uid]; if(m) ins.push(m); }
      });
      ins.forEach(m=>src.push({kind:"attendance",id:k,title:m.name,detail:"signed in today"}));
      if(!ins.length) return result(["Nobody is signed in right now today."]);
      return result([`${ins.length} signed in right now:`, ins.slice(0,15).map(m=>"• "+m.name).join("\n"), ins.length>15?`…and ${ins.length-15} more.`:""], src);
    }

    // 7) Counts
    if(/\bhow many\b|\bcount\b|\btotal\b/.test(q.toLowerCase())){
      if(/teacher/.test(q.toLowerCase())) return result([`${(state.teachers||[]).length} teachers.`],[{kind:"database",id:"teachers",title:"Teachers",detail:""}]);
      if(/class/.test(q.toLowerCase())) return result([`${(state.classes||[]).length} classes.`],[{kind:"database",id:"classes",title:"Classes",detail:""}]);
      if(/subject/.test(q.toLowerCase())) return result([`${(state.subjects||[]).length} subjects.`],[{kind:"database",id:"subjects",title:"Subjects",detail:""}]);
    }

    // 8) School day
    if(/\bperiods?\b.*\bday\b|\bbell\b|\bstart\b|\bend\b|\bfinish\b/.test(q.toLowerCase())){
      return result([`${periodsN()} periods a day, ${daysN()} days a week. First bell ${bell(0)}, last period starts ${bell(periodsN()-1)}.`]);
    }

    // 9) Linked Google Sheet rows (student marks, contacts, etc.)
    const sheetHits = Find.search(q,20).filter(h=>h.kind==="sheet").slice(0,5);
    if(sheetHits.length){
      const top=sheetHits[0];
      sheetHits.forEach(h=>src.push({kind:"sheet",id:h.id,title:h.title,detail:h.sourceLabel}));
      return result([`From "${top.sourceLabel}":`, top.body, sheetHits.length>1?`(${sheetHits.length-1} more matching row${sheetHits.length>2?"s":""} below.)`:""], src);
    }

    // 10) Fallback: closest matches across all data
    const hits=Find.search(q,8);
    if(hits.length){
      const lines=["I can't answer that exactly, but these are the closest matches in your school data:"];
      hits.slice(0,6).forEach(h=>{ lines.push("• "+h.title+(h.body?" — "+String(h.body).slice(0,120):"")); src.push({kind:h.kind,id:h.id,title:h.title,detail:""}); });
      return result(lines, src);
    }
    return result(["I don't have that yet. Try a teacher, subject or class name, ask who is free in a period, or add a public Google Sheet with student data."]);
  }

  function localDateKey(dt){ const y=dt.getFullYear(), m=String(dt.getMonth()+1).padStart(2,"0"), dy=String(dt.getDate()).padStart(2,"0"); return y+"-"+m+"-"+dy; }

  return { answer };
})();
window.Assistant = Assistant;
