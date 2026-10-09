"use strict";

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

initializeApp({ databaseURL: "https://mom-school-time-table-default-rtdb.firebaseio.com" });

const REGION = "asia-south1";
/* App Check enforcement for the callable functions. Off until the web app has its site key
   and App Check is registered in the console; then deploy with ENFORCE_APP_CHECK=true. */
const APP_CHECK_ENFORCED = process.env.ENFORCE_APP_CHECK === "true";
const SUPER_UID = "FI059sTQ5hXFSAYEqKefDyk3kBw2";
const ROLES = new Set(["admin", "teacher", "staff"]);

const clean = (value, max = 160) => String(value || "").trim().slice(0, max);
const cleanEmail = value => clean(value, 254).toLowerCase();
const isOwner = auth => !!auth && auth.uid === SUPER_UID;
/* The database rules grant platform-wide access to any account whose record says
   role: "super"/"superadmin", and the client shows those accounts the whole admin
   console. If the functions only accepted the hard-coded owner UID, a delegated
   admin would see every button and have all of them fail with permission-denied.
   This mirrors the rules exactly — owner UID, or users/{uid}.role in (super,
   superadmin) with active === true. */
async function isPlatformAdmin(auth) {
  if (!auth) return false;
  if (auth.uid === SUPER_UID) return true;
  const snap = await getDatabase().ref(`users/${auth.uid}`).get();
  const user = snap.val();
  return !!user && user.active === true && (user.role === "super" || user.role === "superadmin");
}
/* RTDB push keys and Auth UIDs only use these characters. Anything else (including an
   empty string) would make a path such as "schools/" or "members/" point at a whole parent
   node, which the Admin SDK happily removes. Always validate IDs before building a path. */
const isId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const requireId = (value, what) => {
  if (!isId(value)) throw new HttpsError("invalid-argument", `${what} is missing or invalid.`);
  return value;
};

function requireSignedIn(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in and try again.");
  return request.auth;
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    throw new HttpsError("invalid-argument", "Password must be 6 to 128 characters.");
  }
}

function mapAuthError(error) {
  const code = String(error?.code || "");
  if (code.includes("email-already-exists")) return new HttpsError("already-exists", "That username or email already has an account.");
  if (code.includes("invalid-email")) return new HttpsError("invalid-argument", "That username or email is invalid.");
  if (code.includes("invalid-password")) return new HttpsError("invalid-argument", "The password is not valid.");
  return new HttpsError("internal", "Account provisioning failed. No school data was changed.");
}

/* Deletes Auth users in batches. Users that are already gone are fine; anything else
   is a real failure and must stop the caller before database records are removed. */
async function deleteAuthUsers(uids) {
  const auth = getAuth();
  for (let i = 0; i < uids.length; i += 1000) {
    const result = await auth.deleteUsers(uids.slice(i, i + 1000));
    const real = (result.errors || []).filter(e => e.error?.code !== "auth/user-not-found");
    if (real.length) {
      throw new HttpsError("internal", "Some sign-in accounts could not be removed. Nothing was deleted from the database. Retry in a moment.");
    }
  }
}

async function assertSchoolManager(auth, schoolId) {
  requireId(schoolId, "School");
  const db = getDatabase();
  if (await isPlatformAdmin(auth)) {
    const exists = await db.ref(`schools/${schoolId}/profile`).get();
    if (!exists.exists()) throw new HttpsError("not-found", "That school no longer exists.");
    return { owner: true };
  }
  const [userSnap, profileSnap] = await Promise.all([
    db.ref(`users/${auth.uid}`).get(),
    db.ref(`schools/${schoolId}/profile`).get()
  ]);
  const user = userSnap.val();
  const profile = profileSnap.val();
  if (!user || user.active === false || user.schoolId !== schoolId || user.role !== "principal") {
    throw new HttpsError("permission-denied", "Only this school's principal can manage accounts.");
  }
  if (profile?.status === "disabled" || (profile?.status === "trial" && profile.trialEnds && profile.trialEnds < Date.now())) {
    throw new HttpsError("failed-precondition", "School access is currently paused or expired.");
  }
  return { owner: false, user, profile };
}

exports.provisionSchool = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  if (!(await isPlatformAdmin(caller))) throw new HttpsError("permission-denied", "Only a platform admin can create schools.");

  const data = request.data || {};
  const name = clean(data.name, 120);
  const principalName = clean(data.principalName, 120);
  const email = cleanEmail(data.email);
  const password = data.password;
  const trialDays = Math.max(0, Math.min(365, Number(data.trialDays) || 0));
  const offer = clean(data.offer || "Standard", 80);

  if (!name || !principalName || !email) throw new HttpsError("invalid-argument", "School, principal and account fields are required.");
  if (!email.includes("@")) throw new HttpsError("invalid-argument", "Use a full email, or a username such as principal.sunrise (converted by the app before sending).");
  assertPassword(password);

  const auth = getAuth();
  const db = getDatabase();
  let user = null;
  try {
    user = await auth.createUser({ email, password, displayName: principalName, disabled: false });
    const schoolId = db.ref("schools").push().key;
    if (!isId(schoolId)) throw new Error("Could not reserve school ID.");
    const now = Date.now();
    const profile = {
      name, logo: "", principalUid: user.uid, principalEmail: email,
      status: trialDays ? "trial" : "active",
      plan: trialDays ? "trial" : "paid",
      offer,
      trialEnds: trialDays ? now + trialDays * 86400000 : null,
      createdAt: now
    };
    const updates = {};
    updates[`schools/${schoolId}/profile`] = profile;
    updates[`schools/${schoolId}/members/${user.uid}`] = {
      name: principalName, email, role: "principal", active: true, createdAt: now
    };
    updates[`users/${user.uid}`] = {
      name: principalName, email, role: "principal", schoolId, active: true, createdAt: now
    };
    await db.ref().update(updates);
    return { schoolId, uid: user.uid, email, status: profile.status, trialEnds: profile.trialEnds };
  } catch (error) {
    if (user) await auth.deleteUser(user.uid).catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw mapAuthError(error);
  }
});

exports.provisionMember = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const data = request.data || {};
  const schoolId = clean(data.schoolId, 80);
  await assertSchoolManager(caller, schoolId);

  const name = clean(data.name, 120);
  const email = cleanEmail(data.email);
  const role = clean(data.role, 20);
  const password = data.password;
  if (!name || !email || !ROLES.has(role)) throw new HttpsError("invalid-argument", "Name, account and a valid role are required.");
  assertPassword(password);

  const auth = getAuth();
  const db = getDatabase();
  let user = null;
  try {
    user = await auth.createUser({ email, password, displayName: name, disabled: false });
    const now = Date.now();
    const permissions = {};
    if (data.permissions?.editWorkspace === true || role === "admin") permissions.editWorkspace = true;
    if (data.permissions?.viewUsers === true || role === "admin") permissions.viewUsers = true;
    const teacherId = clean(data.teacherId, 80);
    const member = {
      name, email, role, active: true, permissions,
      teacherId: isId(teacherId) ? teacherId : null,
      createdAt: now
    };
    const updates = {};
    updates[`schools/${schoolId}/members/${user.uid}`] = member;
    updates[`users/${user.uid}`] = { name, email, role, schoolId, active: true, createdAt: now };
    await db.ref().update(updates);
    return { uid: user.uid, email };
  } catch (error) {
    if (user) await auth.deleteUser(user.uid).catch(() => {});
    throw mapAuthError(error);
  }
});

exports.replaceMemberLogin = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const data = request.data || {};
  const schoolId = clean(data.schoolId, 80);
  const oldUid = requireId(clean(data.oldUid, 128), "Member");
  const email = cleanEmail(data.email);
  const password = data.password;
  await assertSchoolManager(caller, schoolId);
  assertPassword(password);

  const db = getDatabase();
  const oldSnap = await db.ref(`schools/${schoolId}/members/${oldUid}`).get();
  const member = oldSnap.val();
  if (!member) throw new HttpsError("not-found", "That member no longer exists.");
  /* A school admin must not be able to hijack the principal's login, but two legitimate
     cases exist and the client offers both: the platform owner fixing a principal whose
     username account cannot receive reset emails, and a principal replacing their own
     username sign-in (the app's own copy tells them to do it from the Team screen).
     Blocking those made the button fail with "cannot be replaced here". */
  if (member.role === "principal" && !(await isPlatformAdmin(caller)) && caller.uid !== oldUid) {
    throw new HttpsError("permission-denied", "Only the platform owner can replace another principal's sign-in.");
  }

  const auth = getAuth();
  let user = null;
  try {
    user = await auth.createUser({ email, password, displayName: member.name, disabled: false });
  } catch (error) {
    throw mapAuthError(error);
  }
  try {
    const now = Date.now();
    const updates = {};
    updates[`schools/${schoolId}/members/${user.uid}`] = { ...member, email, active: true, createdAt: now };
    updates[`users/${user.uid}`] = { name: member.name, email, role: member.role, schoolId, active: true, createdAt: now };
    updates[`schools/${schoolId}/members/${oldUid}`] = null;
    updates[`users/${oldUid}`] = null;
    /* profile/principalUid is written at school creation and validated as immutable by the
       database rules, so a replaced principal login would otherwise leave it pointing at a
       deleted Auth account. Keep the record honest (the Admin SDK bypasses those rules). */
    if (member.role === "principal") {
      updates[`schools/${schoolId}/profile/principalUid`] = user.uid;
      updates[`schools/${schoolId}/profile/principalEmail`] = email;
    }
    await db.ref().update(updates);
  } catch (error) {
    await auth.deleteUser(user.uid).catch(() => {});
    throw mapAuthError(error);
  }
  /* The old password must stop working, so its Auth account has to go. If that fails the
     caller is told explicitly instead of silently leaving a working old login behind. */
  try {
    await deleteAuthUsers([oldUid]);
  } catch (error) {
    throw new HttpsError("internal", "The new sign-in was saved, but the old sign-in could not be removed. Delete it in Firebase Console → Authentication.");
  }
  return { uid: user.uid, email };
});

exports.removeMemberAccount = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const memberUid = requireId(clean(request.data?.memberUid, 128), "Member");
  await assertSchoolManager(caller, schoolId);
  if (memberUid === caller.uid) throw new HttpsError("failed-precondition", "You cannot remove your own account.");
  const db = getDatabase();
  const snap = await db.ref(`schools/${schoolId}/members/${memberUid}`).get();
  const member = snap.val();
  if (member && member.role === "principal" && !(await isPlatformAdmin(caller))) {
    throw new HttpsError("permission-denied", "The principal account is protected.");
  }
  /* Auth first: if it fails the database still shows the member, so the removal can be
     retried. Doing it the other way round could leave a working login with no record. */
  await deleteAuthUsers([memberUid]);
  const updates = {};
  updates[`schools/${schoolId}/members/${memberUid}`] = null;
  updates[`users/${memberUid}`] = null;
  await db.ref().update(updates);
  return { removed: true };
});

exports.deleteSchoolAccount = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 120, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  if (!(await isPlatformAdmin(caller))) throw new HttpsError("permission-denied", "Only a platform admin can delete a school.");
  const schoolId = requireId(clean(request.data?.schoolId, 80), "School");
  const db = getDatabase();
  const snap = await db.ref(`schools/${schoolId}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "That school no longer exists.");
  const members = snap.child("members").val() || {};
  const uids = Object.keys(members).filter(isId);
  await deleteAuthUsers(uids);
  const updates = {};
  updates[`schools/${schoolId}`] = null;
  uids.forEach(uid => { updates[`users/${uid}`] = null; });
  await db.ref().update(updates);
  return { deleted: true, accounts: uids.length };
});

/* ============ Biometric / fingerprint attendance ============
   Uses WebAuthn (the same API Touch ID, Android Biometric and Windows Hello
   use) so a teacher can clock in or out with their fingerprint from their own
   phone. The server never sees the fingerprint — the OS only hands us a signed
   assertion: "this is the same device+person that was enrolled."
   The challenge is single-use and expires in 3 minutes. Registered public keys
   live under schools/$sid/bioCreds/$uid/$credId. Clock-in events are appended
   to schools/$sid/attendance/$date/byMember/$uid/events/$pushId.
   A separate onRequest endpoint lets a USB-attached attendance machine or a
   small PC companion app push clock-ins using a per-school device key. */

const CHALLENGE_TTL_MS = 3 * 60 * 1000;
const BIO_RP_ID = (() => {
  // Same origin the app is served from; authDomain in the client config.
  // WebAuthn requires RP ID to equal the site's registrable domain.
  return process.env.BIO_RP_ID || "mom-school-time-table.firebaseapp.com";
})();
const BIO_RP_NAME = "CampusFlow";
const BIO_ORIGINS = new Set([
  "https://mom-school-time-table.firebaseapp.com",
  "https://mom-school-time-table.web.app"
]);

function b64ToBuf(s){
  s=String(s||"").replace(/-/g,"+").replace(/_/g,"/");
  while(s.length%4)s+="=";
  return Buffer.from(s,"base64");
}
function bufToB64(b){
  return Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function randBuf(n){ return crypto.randomBytes(n); }

async function assertSchoolMember(auth, schoolId){
  // Any active staff member of the school (teacher, staff, admin or principal).
  // This used to call assertSchoolManager, which only lets the principal through, so
  // teachers could not clock in or use Find sheets.
  requireId(schoolId, "School");
  const db = getDatabase();
  if (await isPlatformAdmin(auth)) {
    const exists = await db.ref(`schools/${schoolId}/profile`).get();
    if (!exists.exists()) throw new HttpsError("not-found", "That school no longer exists.");
    return { owner: true, member: { name: "Platform admin", role: "admin", active: true } };
  }
  const [memSnap, profileSnap] = await Promise.all([
    db.ref(`schools/${schoolId}/members/${auth.uid}`).get(),
    db.ref(`schools/${schoolId}/profile`).get()
  ]);
  const member = memSnap.val();
  const profile = profileSnap.val();
  if (!member || member.active !== true) {
    throw new HttpsError("permission-denied", "You are not an active member of this school.");
  }
  if (profile?.status === "disabled" || (profile?.status === "trial" && profile.trialEnds && profile.trialEnds < Date.now())) {
    throw new HttpsError("failed-precondition", "School access is currently paused or expired.");
  }
  return { owner: false, member, profile };
}

async function consumeChallenge(db, schoolId, uid, requestId, kind){
  if(!requestId || !/^[A-Za-z0-9_-]{6,128}$/.test(requestId)){
    throw new HttpsError("invalid-argument","Missing or invalid request id.");
  }
  const ref = db.ref(`schools/${schoolId}/_challenges/${uid}/${requestId}`);
  const snap = await ref.get();
  const v = snap.val();
  if(!v) throw new HttpsError("permission-denied","That fingerprint request expired or was already used. Try again.");
  if(v.kind !== kind) throw new HttpsError("permission-denied","Challenge kind mismatch. Try again.");
  if(v.expiresAt < Date.now()){ await ref.remove(); throw new HttpsError("deadline-exceeded","The fingerprint prompt took too long. Try again."); }
  await ref.remove();
  return v;
}

function decodeClientDataJSON(b64){
  const raw = JSON.parse(b64ToBuf(b64).toString("utf8"));
  return raw;
}
function parseAuthData(buf){
  // 32 bytes rpIdHash, 1 byte flags, 4 bytes signCount, then optional attested credential data + extensions
  if(buf.length < 37) throw new Error("Authenticator data too short.");
  const rpIdHash = buf.slice(0,32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const up = !!(flags & 0x01);
  const uv = !!(flags & 0x04);
  const at = !!(flags & 0x40);
  const ed = !!(flags & 0x80);
  return { rpIdHash, flags, signCount, up, uv, at, ed };
}

function verifyRpIdHash(rpIdHashBuf){
  const expected = crypto.createHash("sha256").update(BIO_RP_ID).digest();
  if(!rpIdHashBuf.equals(expected)) throw new Error("rpIdHash mismatch — not our site.");
}

function base64PemToDer(b64){
  // Handles both "plain base64" and "-----BEGIN...-----\n...\n-----END..."
  const stripped = String(b64).replace(/-----BEGIN[^-]+-----/g,"").replace(/-----END[^-]+-----/g,"").replace(/\s+/g,"");
  return Buffer.from(stripped,"base64");
}

function verifySignature(algo, pubJwk, authenticatorData, clientDataJSON, signature){
  // Build the signed data = authData || sha256(clientDataJSON)
  const clientHash = crypto.createHash("sha256").update(b64ToBuf(clientDataJSON)).digest();
  const signed = Buffer.concat([b64ToBuf(authenticatorData), clientHash]);
  const keyObj = crypto.createPublicKey({ key: pubJwk, format: "jwk" });
  const hash = algo === "ES256" ? "sha256" : algo === "RS256" ? "sha256" : null;
  if(!hash) throw new Error("Unsupported algorithm: "+algo);
  const ok = crypto.verify(hash, signed, keyObj, b64ToBuf(signature));
  if(!ok) throw new Error("Fingerprint signature did not match.");
}

function coseToJwk(cosePub){
  // Minimal COSE key parser for ES256 (alg -7) and RS256 (alg -257), which is
  // all platforms ship. We do not need a full COSE library for these two.
  // cosePub is a buffer holding a CBOR map {-1:alg, -2:x, -3:y} (EC) or {-1:alg, -2:n, -3:e} (RSA).
  // CBOR is non-trivial; use a small in-line parser for the shape we expect.
  const b = Buffer.isBuffer(cosePub)?cosePub:b64ToBuf(cosePub);
  const data = new Uint8Array(b);
  let i=0;
  function read(){ return data[i++]; }
  function readU16(){ const v=(data[i]<<8)|data[i+1]; i+=2; return v; }
  function readU32(){ const v=(data[i]*2**24)+(data[i+1]<<16)+(data[i+2]<<8)+data[i+3]; i+=4; return v; }
  function readBytes(len){ const start=i; i+=len; return data.slice(start,i); }
  function readUint(bytes){ let v=0; for(let k=0;k<bytes;k++) v=v*256+data[i++]; return v; }
  function readArg(){
    const mt=read(); const ai=mt&0x1f; const major=mt>>5;
    if(ai<24) return {major,val:ai};
    if(ai===24) return {major,val:read()};
    if(ai===25) return {major,val:readU16()};
    if(ai===26) return {major,val:readU32()};
    if(ai===27) { i+=8; throw new Error("64-bit integers unsupported in COSE header."); }
    throw new Error("Bad COSE small int ai="+ai);
  }
  function readItem(){
    const a=readArg();
    if(a.major===0) return {t:"int",v:a.val};
    if(a.major===1) return {t:"int",v:-1-a.val};
    if(a.major===2) return {t:"bytes",v:readBytes(a.val)};
    if(a.major===3) return {t:"text",v:Buffer.from(readBytes(a.val)).toString("utf8")};
    if(a.major===5){
      const out={}; for(let k=0;k<a.val;k++){ const key=readItem(); const val=readItem(); out[key.v]=val; }
      return {t:"map",v:out};
    }
    throw new Error("Unsupported COSE type major="+a.major);
  }
  const top=readItem();
  if(top.t!=="map") throw new Error("COSE key must be a map.");
  const m=top.v;
  const alg = (m[-1]||{}).v;
  if(alg===-7){
    const x=Buffer.from((m[-2]||{}).v);
    const y=Buffer.from((m[-3]||{}).v);
    return {
      jwk:{ kty:"EC", crv:"P-256", x:bufToB64(x), y:bufToB64(y), ext:false },
      alg:"ES256"
    };
  }
  if(alg===-257){
    const n=Buffer.from((m[-2]||{}).v);
    const e=Buffer.from((m[-3]||{}).v);
    return {
      jwk:{ kty:"RSA", n:bufToB64(n), e:bufToB64(e), ext:false },
      alg:"RS256"
    };
  }
  throw new Error("Unsupported COSE key alg "+alg+" (only ES256/RS256 are accepted).");
}

function parseAttestationObject(b64){
  // Minimal CBOR parser of `attStmt` and `authData` for "none" or "packed"/"fido-u2f"
  // attestation. For the trust model we want ("the device proves it's the same one
  // later"), we accept "none" and skip certificate chain validation — the school
  // is explicitly consenting to register whatever authenticator the teacher's
  // device offers. The public key is still validated on every clock-in.
  const buf = b64ToBuf(b64);
  const data = new Uint8Array(buf); let i=0;
  function read(){ return data[i++]; }
  function readU16(){ const v=(data[i]<<8)|data[i+1]; i+=2; return v; }
  function readU32(){ const v=(data[i]*2**24)+(data[i+1]<<16)+(data[i+2]<<8)+data[i+3]; i+=4; return v; }
  function readBytes(len){ const s=i; i+=len; return data.slice(s,i); }
  function readArg(){
    const mt=read(); const ai=mt&0x1f; const major=mt>>5;
    if(ai<24) return {major,val:ai};
    if(ai===24) return {major,val:read()};
    if(ai===25) return {major,val:readU16()};
    if(ai===26) return {major,val:readU32()};
    throw new Error("Bad CBOR byte in attestation.");
  }
  function readItem(){
    const a=readArg();
    if(a.major===0) return a.val;
    if(a.major===1) return -1-a.val;
    if(a.major===2) return readBytes(a.val);
    if(a.major===3) return Buffer.from(readBytes(a.val)).toString("utf8");
    if(a.major===5){
      const out={};
      const isTextOrInt=()=>true;
      for(let k=0;k<a.val;k++){ const key=readItem(); const val=readItem(); out[String(key.v!==undefined?key.v:key)]=val; }
      return out;
    }
    if(a.major===4){
      const out=[]; for(let k=0;k<a.val;k++) out.push(readItem()); return out;
    }
    throw new Error("Unsupported CBOR major in attestation: "+a.major);
  }
  const obj=readItem();
  const fmt=String(obj.fmt||"none");
  const authData=Buffer.from(obj.authData);
  // authData: rpIdHash(32) + flags(1) + signCount(4) + [aaguid(16)+credIdLen(2)+credId+pubkey(CBOR)]
  if(authData.length<55) throw new Error("Attestation authData too short.");
  const flags=authData[32];
  const at=!!(flags&0x40);
  if(!at) throw new Error("Attestation did not include a credential.");
  let off=37;
  const aaguid=authData.slice(off,off+16); off+=16;
  const credIdLen=authData.readUInt16BE(off); off+=2;
  const credId=authData.slice(off,off+credIdLen); off+=credIdLen;
  const pubKeyCose=authData.slice(off);
  const pub=coseToJwk(pubKeyCose);
  return { fmt, authData, credId, pub, aaguid };
}

exports.bioRegisterStart = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const label = clean(request.data?.label, 80) || "My phone";
  const { member } = await assertSchoolMember(caller, schoolId);
  const db = getDatabase();
  const requestId = bufToB64(randBuf(18));
  const challenge = randBuf(32);
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await db.ref(`schools/${schoolId}/_challenges/${caller.uid}/${requestId}`).set({
    kind: "bioRegister", challenge: bufToB64(challenge), label, expiresAt, createdAt: Date.now()
  });
  const userHandle = Buffer.from(caller.uid, "utf8");
  // Enumerate existing cred ids so the phone does not re-register the same one.
  const existingSnap = await db.ref(`schools/${schoolId}/bioCreds/${caller.uid}`).get();
  const existing = existingSnap.val()||{};
  const excludeCredentials = Object.keys(existing).map(id=>({ type:"public-key", id, transports:["internal"] }));
  return {
    requestId,
    options: {
      rp: { id: BIO_RP_ID, name: BIO_RP_NAME },
      user: { id: bufToB64(userHandle), name: member.email || caller.uid, displayName: member.name || member.email || "Staff" },
      challenge: bufToB64(challenge),
      pubKeyCredParams: [{ type:"public-key", alg:-7 }, { type:"public-key", alg:-257 }],
      timeout: 120000,
      attestation: "none",
      authenticatorSelection: { authenticatorAttachment:"platform", userVerification:"required", requireResidentKey:false },
      excludeCredentials
    }
  };
});

exports.bioRegisterFinish = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const requestId = clean(request.data?.requestId, 128);
  const label = clean(request.data?.label, 80) || "My phone";
  const cred = request.data?.credential || {};
  await assertSchoolMember(caller, schoolId);
  const db = getDatabase();
  const ch = await consumeChallenge(db, schoolId, caller.uid, requestId, "bioRegister");
  const cdj = decodeClientDataJSON(cred.response.clientDataJSON);
  if(cdj.type !== "webauthn.create") throw new HttpsError("invalid-argument","Wrong WebAuthn response type.");
  if(!BIO_ORIGINS.has(cdj.origin)) throw new HttpsError("permission-denied","Origin mismatch.");
  if(cdj.challenge !== ch.challenge) throw new HttpsError("permission-denied","Challenge mismatch.");
  const att = parseAttestationObject(cred.response.attestationObject);
  verifyRpIdHash(att.authData.slice(0,32));
  const credId = bufToB64(att.credId);
  const now = Date.now();
  await db.ref(`schools/${schoolId}/bioCreds/${caller.uid}/${credId}`).set({
    credId,
    label,
    pubJwk: att.pub.jwk,
    alg: att.pub.alg,
    signCount: 0,
    createdAt: now,
    lastUsedAt: null
  });
  // Tidy: drop expired challenges for this user.
  await db.ref(`schools/${schoolId}/_challenges/${caller.uid}`).once("value").then(snap=>{
    const updates={}; Object.entries(snap.val()||{}).forEach(([k,v])=>{ if(v.expiresAt && v.expiresAt < now) updates[k]=null; });
    if(Object.keys(updates).length) return snap.ref.update(updates);
  }).catch(()=>{});
  return { ok:true, credId, label };
});

exports.bioAuthStart = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  await assertSchoolMember(caller, schoolId);
  const db = getDatabase();
  const credSnap = await db.ref(`schools/${schoolId}/bioCreds/${caller.uid}`).get();
  const creds = credSnap.val()||{};
  const credIds = Object.keys(creds);
  if(!credIds.length) throw new HttpsError("failed-precondition","You have not registered a fingerprint on this phone yet. Use 'Add fingerprint' first.");
  const requestId = bufToB64(randBuf(18));
  const challenge = randBuf(32);
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await db.ref(`schools/${schoolId}/_challenges/${caller.uid}/${requestId}`).set({
    kind:"bioClock", challenge:bufToB64(challenge), expiresAt, createdAt: Date.now()
  });
  return {
    requestId,
    options: {
      challenge: bufToB64(challenge),
      rpId: BIO_RP_ID,
      timeout: 90000,
      userVerification: "required",
      allowCredentials: credIds.map(id=>({ type:"public-key", id, transports:["internal"] }))
    }
  };
});

/* The school day in Sri Lanka time, the same rule the app uses for every attendance date. */
function schoolDayKey(d=new Date()){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Colombo",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
}
async function recordClock(db, schoolId, uid, kind, method, deviceLabel, note){
  if(kind!=="in"&&kind!=="out") throw new HttpsError("invalid-argument","Kind must be in or out.");
  const date = schoolDayKey(new Date());
  const now = Date.now();
  const ref = db.ref(`schools/${schoolId}/attendance/${date}/byMember/${uid}/events`).push();
  const evt = { at: now, kind, method, deviceLabel: deviceLabel||"", note: note||"", via: ref.key };
  await ref.set(evt);
  // live "today" summary for the principal screen (kept shallow)
  await db.ref(`schools/${schoolId}/attendance/${date}/byMember/${uid}/last`).set({...evt});
  return { date, event: evt };
}

exports.bioClock = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const kind = clean(request.data?.kind, 8) === "out" ? "out" : "in";
  const requestId = clean(request.data?.requestId, 128);
  const cred = request.data?.credential || {};
  const { member } = await assertSchoolMember(caller, schoolId);
  const db = getDatabase();
  const ch = await consumeChallenge(db, schoolId, caller.uid, requestId, "bioClock");
  const cdj = decodeClientDataJSON(cred.response.clientDataJSON);
  if(cdj.type !== "webauthn.get") throw new HttpsError("invalid-argument","Wrong WebAuthn response type.");
  if(!BIO_ORIGINS.has(cdj.origin)) throw new HttpsError("permission-denied","Origin mismatch.");
  if(cdj.challenge !== ch.challenge) throw new HttpsError("permission-denied","Challenge mismatch.");
  const rawCredId = cred.rawId;
  const credSnap = await db.ref(`schools/${schoolId}/bioCreds/${caller.uid}/${rawCredId}`).get();
  const stored = credSnap.val();
  if(!stored) throw new HttpsError("permission-denied","That fingerprint is not registered for this account.");
  const authData = b64ToBuf(cred.response.authenticatorData);
  const parsed = parseAuthData(authData);
  verifyRpIdHash(parsed.rpIdHash);
  if(!parsed.up) throw new Error("User presence bit not set.");
  verifySignature(stored.alg, stored.pubJwk, cred.response.authenticatorData, cred.response.clientDataJSON, cred.response.signature);
  const nextCount = parsed.signCount || 0;
  await db.ref(`schools/${schoolId}/bioCreds/${caller.uid}/${rawCredId}`).update({ signCount: nextCount, lastUsedAt: Date.now() });
  const res = await recordClock(db, schoolId, caller.uid, kind, "fingerprint", stored.label||"");
  return { ok:true, ...res, memberName: member.name };
});

exports.bioRemove = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const credId = clean(request.data?.credId, 200);
  await assertSchoolMember(caller, schoolId);
  if(!/^[A-Za-z0-9_-]{6,200}$/.test(credId)) throw new HttpsError("invalid-argument","Invalid credential id.");
  await getDatabase().ref(`schools/${schoolId}/bioCreds/${caller.uid}/${credId}`).remove();
  return { ok:true };
});

exports.clockManual = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const kind = clean(request.data?.kind, 8) === "out" ? "out" : "in";
  const { member } = await assertSchoolMember(caller, schoolId);
  const db = getDatabase();
  const res = await recordClock(db, schoolId, caller.uid, kind, "manual", "", member.name+" signed in without fingerprint");
  return { ok:true, ...res, memberName: member.name };
});

/* ---- Principal manages today's attendance ----
   op "in" / "out": record a sign-in or sign-out the person could not make (forgot, device
   failed). op "undo": remove the most recent record for that person today. Only the
   principal (or the platform admin) may do this; every change is marked "manual". */
exports.attendanceManual = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const data = request.data || {};
  const schoolId = clean(data.schoolId, 80);
  const uid = clean(data.uid, 128);
  const op = clean(data.op, 10);
  const note = clean(data.note, 120);
  if (!["in", "out", "undo"].includes(op)) throw new HttpsError("invalid-argument", "Choose in, out or undo.");
  if (!uid) throw new HttpsError("invalid-argument", "Choose a staff member.");
  const mgr = await assertSchoolManager(caller, schoolId);
  const db = getDatabase();
  const member = (await db.ref(`schools/${schoolId}/members/${uid}`).get()).val();
  if (!member || member.active !== true) throw new HttpsError("not-found", "That person is not an active member of this school.");

  const date = schoolDayKey(new Date());
  const base = `schools/${schoolId}/attendance/${date}/byMember/${uid}`;
  const events = Object.entries((await db.ref(`${base}/events`).get()).val() || {})
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));

  if (op === "undo") {
    if (!events.length) throw new HttpsError("failed-precondition", "There is nothing to undo for this person today.");
    const [lastKey] = events[events.length - 1];
    await db.ref(`${base}/events/${lastKey}`).remove();
    const prev = events.length > 1 ? events[events.length - 2][1] : null;
    if (prev) await db.ref(`${base}/last`).set({ ...prev });
    else await db.ref(`${base}/last`).remove();
    return { ok: true, undone: true, date };
  }

  let inOpen = false;
  for (const [, e] of events) {
    if (e.kind === "in") inOpen = true;
    else if (e.kind === "out") inOpen = false;
  }
  if (op === "in" && inOpen) throw new HttpsError("failed-precondition", "This person is already signed in.");
  if (op === "out" && !inOpen) throw new HttpsError("failed-precondition", "This person is not signed in.");

  const by = mgr.owner ? "Platform admin" : (mgr.user?.name || "Principal");
  const res = await recordClock(db, schoolId, uid, op, "manual", "Set by " + by, note ? "Principal: " + note : "Set by principal");
  return { ok: true, date: res.date, memberName: member.name || "" };
});

/* ---- USB / external attendance-machine push (a simple API key per school) ----
   A small companion app running on a PC wired to a USB fingerprint reader, or a
   wall-mounted attendance machine, can POST JSON to this URL:
     POST /attendancePush  (also deployed at asia-south1)
     Headers: Authorization: Bearer <deviceKey>
     Body: { staffId, kind: "in"|"out", at?: <ms>, note?, device? }
   staffId is the teacher/staff id (the short code or Firebase uid). The function
   matches it against members[].teacherId first, then uid, then email. */
exports.attendancePush = onRequest({ region: REGION, timeoutSeconds: 30, memory: "256MiB", cors:true }, async (req, res) => {
  try{
    if(req.method==="OPTIONS"){ res.set("Access-Control-Allow-Methods","POST,OPTIONS"); res.set("Access-Control-Allow-Headers","Authorization,Content-Type"); return res.status(204).send(""); }
    if(req.method!=="POST") return res.status(405).json({error:"method not allowed"});
    const key = String(req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
    if(!key || !/^[A-Za-z0-9_-]{16,200}$/.test(key)) return res.status(401).json({error:"missing device key"});
    const db = getDatabase();
    // Keys are stored only as a SHA-256 hash, so a leaked database cannot be used to clock in.
    const keyHash = sha256Hex(key);
    let found=null;
    const hashSnap = await db.ref("deviceKeys").orderByChild("keyHash").equalTo(keyHash).limitToFirst(1).get();
    hashSnap.forEach(s=>{ found={ ...s.val(), deviceId:s.key }; });
    if(!found){
      // Legacy devices created before hashing stored the key in plain text: match, then convert.
      const legacy = await db.ref("deviceKeys").orderByChild("key").equalTo(key).limitToFirst(1).get();
      legacy.forEach(s=>{ found={ ...s.val(), deviceId:s.key }; });
      if(found){ await db.ref(`deviceKeys/${found.deviceId}`).update({ keyHash, key: null }); }
    }
    if(!found||!found.active) return res.status(401).json({error:"invalid device key"});

    // Rate limit: at most 60 pushes per device per minute (a stolen key cannot flood the school).
    const bucket = Math.floor(Date.now()/60000);
    const rateRef = db.ref(`deviceKeys/${found.deviceId}/rate`);
    const rate = await rateRef.transaction(cur => (cur && cur.bucket===bucket) ? { bucket, count: cur.count+1 } : { bucket, count: 1 });
    if(rate.snapshot.val()?.count > 60) return res.status(429).json({error:"too many clock-ins from this device, slow down"});
    const schoolId=found.schoolId;
    const body = req.body && typeof req.body==="object" ? req.body : {};
    const staffId = clean(body.staffId,128);
    const kind = clean(body.kind,8)==="out"?"out":"in";
    const deviceAt = Number(body.at);
    if(!staffId) return res.status(400).json({error:"staffId is required"});
    const membersSnap = await db.ref(`schools/${schoolId}/members`).get();
    const members = membersSnap.val()||{};
    let matched=null, matchedUid=null;
    for(const [uid,m] of Object.entries(members)){
      if(!m || m.active!==true) continue;
      if(uid===staffId){ matched=m; matchedUid=uid; break; }
      if(m.teacherId && m.teacherId===staffId){ matched=m; matchedUid=uid; break; }
      if(m.email && m.email.toLowerCase()===staffId.toLowerCase()){ matched=m; matchedUid=uid; break; }
    }
    if(!matched) return res.status(404).json({error:"staff not found on this device's school"});
    /* The clock-in time is the server's clock, never the device's: a device cannot backdate itself. */
    const nowMs = Date.now();
    const date = schoolDayKey(new Date(nowMs));
    const deviceClockOk = isFinite(deviceAt) && Math.abs(deviceAt-nowMs) <= 10*60*1000;
    const evRef=db.ref(`schools/${schoolId}/attendance/${date}/byMember/${matchedUid}/events`).push();
    const evt={ at:nowMs, kind, method:"device", deviceLabel:found.label||"Attendance device", note:clean(body.note,200), via:evRef.key, deviceClockOk };
    await evRef.set(evt);
    await db.ref(`schools/${schoolId}/attendance/${date}/byMember/${matchedUid}/last`).set({...evt});
    /* Let the principal see when this device last sent a clock-in (shown as "last seen"). */
    await db.ref(`deviceKeys/${found.deviceId}/lastSeenAt`).set(Date.now());
    return res.status(200).json({ ok:true, name:matched.name, role:matched.role, kind, at:evt.at });
  }catch(e){
    console.error("attendancePush failed:", e);
    return res.status(500).json({error:String(e.message||e)});
  }
});

function sha256Hex(v){ return crypto.createHash("sha256").update(String(v)).digest("hex"); }
function genDeviceKey(){ return "cfsk_" + bufToB64(crypto.randomBytes(24)); }

exports.deviceKeyCreate = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 20, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const label = clean(request.data?.label, 80) || "Reception scanner";
  await assertSchoolManager(caller, schoolId);
  const db = getDatabase();
  const key = genDeviceKey();
  const pushRef = db.ref("deviceKeys").push();
  const rec = { schoolId, label, active:true, createdAt: Date.now(), createdBy: caller.uid, lastSeenAt:null };
  // Only the SHA-256 of the key is stored. The key itself is shown once and cannot be recovered.
  await pushRef.set({ ...rec, keyHash: sha256Hex(key) });
  return { deviceId: pushRef.key, key, label };
});

exports.deviceKeyRevoke = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 20, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const deviceId = requireId(clean(request.data?.deviceId, 128), "Device");
  await assertSchoolManager(caller, schoolId);
  const db = getDatabase();
  const snap = await db.ref(`deviceKeys/${deviceId}`).get();
  const rec = snap.val();
  if(!rec || rec.schoolId !== schoolId) throw new HttpsError("not-found","That device is not linked to this school.");
  await snap.ref.update({ active:false, revokedAt: Date.now() });
  return { ok:true };
});

exports.deviceKeyList = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 20, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  await assertSchoolManager(caller, schoolId);
  const db = getDatabase();
  const snap = await db.ref("deviceKeys").orderByChild("schoolId").equalTo(schoolId).get();
  const out=[];
  snap.forEach(s=>{
    const v=s.val();
    out.push({ deviceId:s.key, label:v.label, active:v.active!==false, createdAt:v.createdAt, lastSeenAt:v.lastSeenAt, revokedAt:v.revokedAt });
  });
  return { devices: out };
});

/* ---------------------------------------------------------------------------
   Find sheets. Browsers cannot read a Google Sheet directly (Google sends no
   CORS header), so the server fetches the public CSV once and stores it under
   the school. Every device then reads the copy from Firebase and caches it, so
   later searches are instant and work offline.
   --------------------------------------------------------------------------- */
const SHEET_MAX_BYTES = 1.5 * 1024 * 1024;
const SHEET_ID_RE = /^sheet_[A-Za-z0-9_]{1,120}$/;

function parseGoogleSheetUrl(url){
  const text = String(url || "");
  const m = text.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,120})(?=[\/?#]|$)/);
  if (!m) return null;
  const g = text.match(/[#?&]gid=(\d{1,12})/);
  return { sheetId: m[1], gid: g ? g[1] : "0" };
}

exports.findSheetImport = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const data = request.data || {};
  const schoolId = clean(data.schoolId, 80);
  if (!schoolId) throw new HttpsError("invalid-argument", "Missing school.");
  await assertSchoolMember(caller, schoolId);   // any active member may add a sheet to search

  const parsed = parseGoogleSheetUrl(data.url);
  if (!parsed) throw new HttpsError("invalid-argument", "That doesn't look like a Google Sheets link.");
  const label = clean(data.label, 80) || "Sheet";
  const id = ("sheet_" + parsed.sheetId.replace(/[^A-Za-z0-9]/g, "").slice(0, 60) + "_" + parsed.gid).slice(0, 120);
  const exportUrl = `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv&gid=${parsed.gid}`;

  let csv;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let res;
    try {
      res = await fetch(exportUrl, { redirect: "follow", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new HttpsError("failed-precondition", `Google returned ${res.status}. Share the sheet as "Anyone with the link can view".`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > SHEET_MAX_BYTES) {
      throw new HttpsError("failed-precondition", "That sheet is over 1.5 MB. Keep the rows Find needs in a smaller sheet.");
    }
    csv = buf.toString("utf8");
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("unavailable", "Could not reach Google Sheets right now. Try again in a minute.");
  }
  if (/^\s*</.test(csv)) {
    throw new HttpsError("failed-precondition", 'Google sent a web page, not a table. Share the sheet as "Anyone with the link can view".');
  }

  const rowCount = csv.split(/\r?\n/).filter(line => line.trim()).length - 1;
  const rec = {
    label,
    url: `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/edit#gid=${parsed.gid}`,
    gid: parsed.gid,
    fetchedAt: Date.now(),
    rowCount: Math.max(0, rowCount),
    importedBy: caller.uid,
    csv
  };
  await getDatabase().ref(`schools/${schoolId}/findSources/${id}`).set(rec);
  return { id, ...rec };
});

exports.findSheetRemove = onCall({ region: REGION, enforceAppCheck: APP_CHECK_ENFORCED, timeoutSeconds: 30, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const data = request.data || {};
  const schoolId = clean(data.schoolId, 80);
  const id = clean(data.id, 140);
  if (!schoolId || !SHEET_ID_RE.test(id)) throw new HttpsError("invalid-argument", "Invalid sheet.");
  await assertSchoolMember(caller, schoolId);
  await getDatabase().ref(`schools/${schoolId}/findSources/${id}`).remove();
  return { ok: true };
});
