/* Biometric attendance / fingerprint helpers for CampusFlow.
   Browsers never see the actual fingerprint — the OS secure enclave (Touch ID,
   Android Biometric, Windows Hello) proves "this is the same person+device that
   was enrolled" using WebAuthn. That is exactly the guarantee a school needs:
   "this teacher, on their registered device, clocked in right now." */

const ATT = (()=>{
  const sid = ()=>Session.schoolId;
  /* Same school-day rule as app.js schoolDayKey (Sri Lanka time). */
  const todayKey = (d=new Date())=> schoolDayKey(d);
  const fmtClock = ts=>{
    if(!ts) return "";
    const d=new Date(ts); return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  };
  const fmtWhen = ts=>{
    if(!ts) return "—";
    const d=new Date(ts); const today=todayKey();
    const key=schoolDayKey(d);
    if(key===today) return fmtClock(ts);
    return d.toLocaleDateString()+" "+fmtClock(ts);
  };
  const hasBiometric = ()=>!!(navigator.credentials && window.PublicKeyCredential);

  /* --- helpers to talk to the cloud function that issues WebAuthn challenges --- */
  async function cf(name, data){ return callBackend(name, data, 45000); }
  function bufToB64(buf){
    const bytes=new Uint8Array(buf); let s="";
    for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  function b64ToBuf(s){
    s=s.replace(/-/g,"+").replace(/_/g,"/");
    const pad=s.length%4; if(pad) s+="=".repeat(4-pad);
    const bin=atob(s); const out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
    return out.buffer;
  }
  function decodeCred(c){
    const out={...c};
    if(c.rawId) out.rawId=b64ToBuf(c.rawId);
    if(c.challenge) out.challenge=b64ToBuf(c.challenge);
    if(c.user && c.user.id) out.user.id=b64ToBuf(c.user.id);
    if(c.excludeCredentials) out.excludeCredentials=c.excludeCredentials.map(e=>({...e,id:b64ToBuf(e.id)}));
    if(c.allowCredentials) out.allowCredentials=c.allowCredentials.map(e=>({...e,id:b64ToBuf(e.id)}));
    return out;
  }
  function encodeAssertion(ass){
    return {
      id: ass.id, rawId: bufToB64(ass.rawId), type: ass.type,
      response: {
        clientDataJSON: bufToB64(ass.response.clientDataJSON),
        authenticatorData: bufToB64(ass.response.authenticatorData),
        signature: bufToB64(ass.response.signature),
        userHandle: ass.response.userHandle?bufToB64(ass.response.userHandle):null
      }
    };
  }
  function encodeAttestation(att){
    return {
      id: att.id, rawId: bufToB64(att.rawId), type: att.type,
      response: {
        clientDataJSON: bufToB64(att.response.clientDataJSON),
        attestationObject: bufToB64(att.response.attestationObject)
      }
    };
  }

  /* --- register a fingerprint / face for clock-in --- */
  async function registerFinger({label}){
    if(!hasBiometric()) throw new Error("This device has no fingerprint/face reader the browser can use.");
    const opts=await cf("bioRegisterStart",{schoolId:sid(),label:String(label||"").slice(0,60)||"My phone"});
    const publicKey=decodeCred(opts.options);
    const att=await navigator.credentials.create({publicKey});
    if(!att) throw new Error("Your device cancelled the fingerprint setup.");
    const saved=await cf("bioRegisterFinish",{schoolId:sid(),credential:encodeAttestation(att),label:String(label||"").slice(0,60)||"My phone",requestId:opts.requestId});
    return saved;
  }

  /* --- clock in or clock out with a fingerprint --- */
  async function clockWithFinger(kind){ // kind: "in" | "out"
    if(!hasBiometric()) throw new Error("This device has no fingerprint reader. Use the password clock-in, or register a fingerprint from your phone.");
    const opts=await cf("bioAuthStart",{schoolId:sid()});
    const publicKey=decodeCred(opts.options);
    const ass=await navigator.credentials.get({publicKey});
    if(!ass) throw new Error("Fingerprint was cancelled.");
    const result=await cf("bioClock",{schoolId:sid(),credential:encodeAssertion(ass),kind:kind==="out"?"out":"in",requestId:opts.requestId});
    return result;
  }

  /* --- plain password / "I am here" button fallback (still recorded honestly) --- */
  async function clockManual(kind){
    return cf("clockManual",{schoolId:sid(),kind:kind==="out"?"out":"in"});
  }

  async function removeCredential(credId){
    return cf("bioRemove",{schoolId:sid(),credId:String(credId||"")});
  }
  async function listCredentials(){
    const r=await FB.db.ref(`schools/${sid()}/bioCreds/${Session.uid}`).once("value");
    return r.val()||{};
  }

  async function todayForMe(){
    const key=todayKey();
    const r=await FB.db.ref(`schools/${sid()}/attendance/${key}/byMember/${Session.uid}`).once("value");
    return r.val()||null;
  }
  /* Whole-day reads: the database only allows a principal, an admin or a team viewer
     (see database.rules.json). For anyone else, return nothing instead of letting the
     listener fail with permission_denied. */
  function mayReadDay(){ return typeof window.canReadDayAttendance!=="function" || window.canReadDayAttendance(); }
  async function todayForSchool(){
    if(!mayReadDay()) return { day:null, members:{}, denied:true };
    const key=todayKey();
    const [evSnap,memSnap] = await Promise.all([
      FB.db.ref(`schools/${sid()}/attendance/${key}`).once("value"),
      FB.db.ref(`schools/${sid()}/members`).once("value")
    ]);
    return { day: evSnap.val()||null, members: memSnap.val()||{} };
  }
  function latestStatus(byMember){
    if(!byMember) return {status:"away",inAt:null,outAt:null,dur:0};
    const ev=byMember.events?Object.values(byMember.events):[];
    ev.sort((a,b)=>(a.at||0)-(b.at||0));
    let inAt=null,outAt=null;
    for(const e of ev){ if(e.kind==="in"){ inAt=e.at; outAt=null; } else if(e.kind==="out"){ outAt=e.at; } }
    const last = ev[ev.length-1];
    const status = inAt && !outAt ? "in" : (outAt && inAt && outAt>inAt ? "out" : "away");
    return { status, inAt, outAt, lastAt: last?.at||null, method: last?.method||"", deviceLabel: last?.deviceLabel||"", note: last?.note||"" };
  }

  async function recentDays(days=14){
    if(!mayReadDay()) return [];
    const out=[]; const base=new Date(); base.setHours(0,0,0,0);
    const refs=[];
    for(let i=0;i<days;i++){ const k=schoolDayKey(new Date(Date.now()-i*86400000)); refs.push(FB.db.ref(`schools/${sid()}/attendance/${k}/byMember`).once("value").then(s=>({key:k,v:s.val()||{}}))); }
    const all=await Promise.all(refs);
    return all;
  }

  return {
    hasBiometric, todayKey, fmtClock, fmtWhen,
    registerFinger, clockWithFinger, clockManual, removeCredential, listCredentials,
    todayForMe, todayForSchool, latestStatus, recentDays
  };
})();

window.ATT=ATT;
