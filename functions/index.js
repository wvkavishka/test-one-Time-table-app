"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

initializeApp({ databaseURL: "https://mom-school-time-table-default-rtdb.firebaseio.com" });

const REGION = "asia-south1";
const SUPER_UID = "FI059sTQ5hXFSAYEqKefDyk3kBw2";
const ROLES = new Set(["admin", "teacher", "staff"]);

const clean = (value, max = 160) => String(value || "").trim().slice(0, max);
const cleanEmail = value => clean(value, 254).toLowerCase();
const isOwner = auth => !!auth && auth.uid === SUPER_UID;
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
  if (isOwner(auth)) {
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
  if (!user || user.active !== true || user.schoolId !== schoolId || user.role !== "principal") {
    throw new HttpsError("permission-denied", "Only this school's principal can manage accounts.");
  }
  if (profile?.status === "disabled" || (profile?.status === "trial" && profile.trialEnds && profile.trialEnds < Date.now())) {
    throw new HttpsError("failed-precondition", "School access is currently paused or expired.");
  }
  return { owner: false, user, profile };
}

exports.provisionSchool = onCall({ region: REGION, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  if (!isOwner(caller)) throw new HttpsError("permission-denied", "Only the platform owner can create schools.");

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

exports.provisionMember = onCall({ region: REGION, timeoutSeconds: 60, memory: "256MiB" }, async request => {
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

exports.replaceMemberLogin = onCall({ region: REGION, timeoutSeconds: 60, memory: "256MiB" }, async request => {
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
  if (member.role === "principal" && !isOwner(caller) && caller.uid !== oldUid) {
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

exports.removeMemberAccount = onCall({ region: REGION, timeoutSeconds: 60, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  const schoolId = clean(request.data?.schoolId, 80);
  const memberUid = requireId(clean(request.data?.memberUid, 128), "Member");
  await assertSchoolManager(caller, schoolId);
  if (memberUid === caller.uid) throw new HttpsError("failed-precondition", "You cannot remove your own account.");
  const db = getDatabase();
  const snap = await db.ref(`schools/${schoolId}/members/${memberUid}`).get();
  const member = snap.val();
  if (member && member.role === "principal" && !isOwner(caller)) {
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

exports.deleteSchoolAccount = onCall({ region: REGION, timeoutSeconds: 120, memory: "256MiB" }, async request => {
  const caller = requireSignedIn(request);
  if (!isOwner(caller)) throw new HttpsError("permission-denied", "Only the platform owner can delete a school.");
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
