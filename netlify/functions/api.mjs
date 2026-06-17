import { createHash } from "node:crypto";

import {
  createDeviceUid,
  createEventId,
  createId,
  emailIndexKey,
  hashPassword,
  hashToken,
  issueToken,
  normalizeEmail,
  verifyPassword,
} from "../lib/security.mjs";
import { error, json, methodNotAllowed, readJson, redirect } from "../lib/responses.mjs";
import {
  deleteByPrefix,
  getJson,
  listJson,
  putJson,
  stores,
} from "../lib/storage.mjs";

const USERS = stores.users;
const SESSIONS = stores.sessions;
const DEVICES = stores.devices;
const EVENTS = stores.events;
const CONNECTIONS = stores.connections;

function nowIso() {
  return new Date().toISOString();
}

function normalizedPath(req) {
  let path = new URL(req.url).pathname;
  path = path.replace(/^\/\.netlify\/functions\/api/, "");
  path = path.replace(/^\/api/, "");
  return path || "/";
}

function bearerToken(req) {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    created_at: user.created_at,
  };
}

function publicDevice(device) {
  return {
    device_uid: device.device_uid,
    device_name: device.device_name,
    owner: device.owner,
    login_username: device.login_username,
    vault_hash: device.vault_hash || null,
    registered_at: device.registered_at,
  };
}

function validateString(value, name, min = 1, max = 200) {
  const text = String(value || "").trim();
  if (text.length < min) {
    const problem = new Error(`${name} must contain at least ${min} character(s).`);
    problem.status = 422;
    throw problem;
  }
  if (text.length > max) {
    const problem = new Error(`${name} cannot exceed ${max} characters.`);
    problem.status = 422;
    throw problem;
  }
  return text;
}

async function getUserById(userId) {
  return await getJson(USERS(), `user/${userId}`);
}

async function getUserByEmail(email) {
  const index = await getJson(USERS(), `email/${emailIndexKey(email)}`);
  if (!index?.user_id) return null;
  return await getUserById(index.user_id);
}

async function getSession(token) {
  if (!token) return null;
  const sessionStore = SESSIONS();
  const key = `session/${hashToken(token)}`;
  const session = await getJson(sessionStore, key);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await sessionStore.delete(key);
    return null;
  }
  return session;
}

async function currentUser(req, required = true) {
  const token = bearerToken(req);
  const session = await getSession(token);
  const user = session ? await getUserById(session.user_id) : null;

  if (!user && required) {
    const problem = new Error("Sign in is required or the session has expired.");
    problem.status = 401;
    throw problem;
  }
  return user;
}

async function createSession(userId) {
  const issued = issueToken();
  await putJson(SESSIONS(), `session/${issued.tokenHash}`, {
    user_id: userId,
    created_at: issued.createdAt,
    expires_at: issued.expiresAt,
  });
  return {
    access_token: issued.accessToken,
    token_type: "bearer",
    expires_at: issued.expiresAt,
  };
}

async function revokeUserSessions(userId) {
  const store = SESSIONS();
  const sessions = await listJson(store, "session/");
  const matching = sessions.filter((item) => item.user_id === userId);
  const { blobs } = await store.list({ prefix: "session/" });
  await Promise.all(
    blobs.map(async (entry) => {
      const session = await getJson(store, entry.key);
      if (session?.user_id === userId) await store.delete(entry.key);
    }),
  );
  return matching.length;
}

async function listUsers() {
  return await listJson(USERS(), "user/");
}

async function getDevice(uid) {
  return await getJson(DEVICES(), `device/${uid}`);
}

async function listDevicesForUser(userId) {
  const devices = await listJson(DEVICES(), "device/");
  return devices
    .filter((item) => item.user_id === userId)
    .sort((a, b) => String(b.registered_at).localeCompare(String(a.registered_at)))
    .map(publicDevice);
}

async function resolveRegistrationOwner(req) {
  const authenticated = await currentUser(req, false);
  if (authenticated) return authenticated;

  const users = await listUsers();
  if (users.length === 1) return users[0];
  if (users.length === 0) {
    const problem = new Error("Create an owner account before registering a USB.");
    problem.status = 403;
    throw problem;
  }
  const problem = new Error("Sign in is required when multiple owner accounts exist.");
  problem.status = 401;
  throw problem;
}

function hostFields(payload) {
  const hostUser = String(payload.host_user || payload.windows_user || "Unknown");
  let hostDevice = String(payload.host_device || payload.computer_name || "Unknown");
  const hostPlatform = String(
    payload.host_platform ||
      (hostDevice.toLowerCase().includes("android") ? "Android" : "Windows"),
  );
  if (
    hostPlatform &&
    !hostDevice.toLowerCase().includes(hostPlatform.toLowerCase())
  ) {
    hostDevice = `${hostPlatform} | ${hostDevice}`;
  }
  return { hostUser, hostDevice, hostPlatform };
}

function locationText(location) {
  const city = String(location.city || "Unknown").trim() || "Unknown";
  const country = String(location.country || "Unknown").trim() || "Unknown";
  return `${city}, ${country}`;
}

async function resolveLocation(payload, deviceUid, context, req) {
  const cityValue = String(payload.city || "").trim();
  const countryValue = String(payload.country || "").trim();
  const meaningful = (value) =>
    value && !["unknown", "null", "-"].includes(value.toLowerCase());

  if (
    payload.latitude !== undefined ||
    payload.longitude !== undefined ||
    meaningful(cityValue) ||
    meaningful(countryValue)
  ) {
    const fallbackCity = context?.geo?.city || "Unknown";
    const fallbackCountry = context?.geo?.country?.name || "Unknown";
    return {
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      city: meaningful(cityValue) ? cityValue : fallbackCity,
      country: meaningful(countryValue) ? countryValue : fallbackCountry,
      ip: payload.ip || req.headers.get("x-nf-client-connection-ip") || null,
      source: meaningful(cityValue) || meaningful(countryValue)
        ? "host_device"
        : "host_coordinates_with_request_geo",
    };
  }

  if (deviceUid) {
    const state = await getJson(CONNECTIONS(), `connection/${deviceUid}`);
    if (state && (state.latitude !== null || state.longitude !== null)) {
      const pieces = String(state.location || "Unknown")
        .split(",", 2)
        .map((part) => part.trim());
      return {
        latitude: state.latitude ?? null,
        longitude: state.longitude ?? null,
        city: pieces[0] || "Unknown",
        country: pieces[1] || "Unknown",
        ip: null,
        source: "latest_usb_monitor_location",
      };
    }
  }

  return {
    latitude: null,
    longitude: null,
    city: context?.geo?.city || "Unknown",
    country: context?.geo?.country?.name || "Unknown",
    ip: req.headers.get("x-nf-client-connection-ip") || null,
    source: "netlify_request_geo",
  };
}

async function calculateTamperStatus(device, incomingStatus, vaultHash) {
  const statuses = [];
  const incoming = String(incomingStatus || "OK").trim().toUpperCase();
  if (incoming && incoming !== "OK") {
    statuses.push(...incoming.split(",").map((part) => part.trim()).filter(Boolean));
  }

  if (device && vaultHash) {
    if (!device.vault_hash) {
      device.vault_hash = vaultHash;
      await putJson(DEVICES(), `device/${device.device_uid}`, device);
    } else if (device.vault_hash !== vaultHash) {
      statuses.push("TAMPER_VAULT_MODIFIED");
    }
  }

  return [...new Set(statuses)].join(",") || "OK";
}

async function createEvent({
  deviceUid,
  deviceName,
  owner,
  loginUsername,
  hostUser,
  hostDevice,
  hostPlatform,
  connection,
  eventType,
  accessStatus,
  tamperStatus,
  location,
  notifyOwner = false,
  notificationKind = null,
}) {
  const id = createEventId();
  const timestamp = nowIso();
  const event = {
    id,
    device_uid: deviceUid,
    device_name: deviceName || null,
    owner: owner || null,
    login_username: loginUsername || null,
    windows_user: hostUser,
    computer_name: hostDevice,
    host_user: hostUser,
    host_device: hostDevice,
    host_platform: hostPlatform,
    location: locationText(location),
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    time: timestamp,
    timestamp,
    connection,
    connection_status: connection,
    access_status: accessStatus,
    status: accessStatus,
    event_type: eventType,
    tamper_status: tamperStatus || "OK",
    notify_owner: Boolean(notifyOwner),
    notification_kind: notificationKind || null,
  };
  await putJson(EVENTS(), `event/${id}`, event);
  await updateConnection(event);
  return event;
}

async function updateConnection(event) {
  const store = CONNECTIONS();
  const key = `connection/${event.device_uid}`;
  const previous = await getJson(store, key);
  const accessStatus =
    event.event_type === "ACCESS"
      ? event.access_status
      : previous?.access_status || "NOT_ATTEMPTED";
  const state = {
    device_uid: event.device_uid,
    device_name: event.device_name,
    owner: event.owner,
    login_username: event.login_username,
    windows_user: event.windows_user,
    computer_name: event.computer_name,
    host_user: event.host_user,
    host_device: event.host_device,
    host_platform: event.host_platform,
    location: event.location,
    latitude: event.latitude,
    longitude: event.longitude,
    last_seen: event.time,
    time: event.time,
    connection: event.connection,
    connection_status: event.connection,
    access_status: accessStatus,
    tamper_status: event.tamper_status,
  };
  await putJson(store, key, state);
  return state;
}

async function ownedDeviceUids(userId) {
  const devices = await listJson(DEVICES(), "device/");
  return new Set(
    devices.filter((item) => item.user_id === userId).map((item) => item.device_uid),
  );
}

async function eventsForUser(userId, limit = 250) {
  const allowed = await ownedDeviceUids(userId);
  const events = await listJson(EVENTS(), "event/");
  return events
    .filter((item) => allowed.has(item.device_uid))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, Math.max(1, Math.min(Number(limit) || 250, 1000)));
}

async function connectionsForUser(userId) {
  const allowed = await ownedDeviceUids(userId);
  const connections = await listJson(CONNECTIONS(), "connection/");
  return connections
    .filter((item) => allowed.has(item.device_uid))
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
}


async function dashboardSummary(userId, limit = 250) {
  const [allDevices, allEvents, allConnections] = await Promise.all([
    listJson(DEVICES(), "device/"),
    listJson(EVENTS(), "event/"),
    listJson(CONNECTIONS(), "connection/"),
  ]);
  const ownedDevices = allDevices
    .filter((item) => item.user_id === userId)
    .sort((a, b) => String(b.registered_at).localeCompare(String(a.registered_at)));
  const allowed = new Set(ownedDevices.map((item) => item.device_uid));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
  const events = allEvents
    .filter((item) => allowed.has(item.device_uid))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, safeLimit);
  const connections = allConnections
    .filter((item) => allowed.has(item.device_uid))
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  return {
    devices: ownedDevices.map(publicDevice),
    events,
    connections,
    generated_at: nowIso(),
  };
}

async function deleteDeviceRecords(uid) {
  await DEVICES().delete(`device/${uid}`);
  await CONNECTIONS().delete(`connection/${uid}`);
  const eventStore = EVENTS();
  const { blobs } = await eventStore.list({ prefix: "event/" });
  await Promise.all(
    blobs.map(async (entry) => {
      const event = await getJson(eventStore, entry.key);
      if (event?.device_uid === uid) await eventStore.delete(entry.key);
    }),
  );
}

async function ensureOwnedDevice(uid, userId) {
  const device = await getDevice(uid);
  if (!device || device.user_id !== userId) {
    const problem = new Error("Registered USB device not found.");
    problem.status = 404;
    throw problem;
  }
  return device;
}


async function handleAdminImport(req) {
  if (req.method !== "POST") return methodNotAllowed();
  const configuredSecret = process.env.MIGRATION_SECRET || "";
  const suppliedSecret = req.headers.get("x-migration-secret") || "";
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    return error("Migration endpoint is disabled or the secret is incorrect.", 403);
  }

  const payload = await readJson(req);
  const users = Array.isArray(payload.users) ? payload.users : [];
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const events = Array.isArray(payload.events) ? payload.events : [];
  const connections = Array.isArray(payload.connection_states)
    ? payload.connection_states
    : [];

  const userStore = USERS();
  for (const record of users) {
    if (!record.id || !record.email || !record.password_hash) continue;
    const user = {
      id: record.id,
      name: record.name || "USB Owner",
      email: normalizeEmail(record.email),
      password_hash: record.password_hash,
      created_at: record.created_at || nowIso(),
    };
    await putJson(userStore, `user/${user.id}`, user);
    await putJson(userStore, `email/${emailIndexKey(user.email)}`, {
      user_id: user.id,
    });
  }

  for (const record of devices) {
    if (!record.device_uid || !record.password_hash) continue;
    await putJson(DEVICES(), `device/${record.device_uid}`, {
      ...record,
      registered_at: record.registered_at || nowIso(),
    });
  }

  for (const record of events) {
    const id = Number(record.id) || createEventId();
    await putJson(EVENTS(), `event/${id}`, { ...record, id });
  }

  for (const record of connections) {
    if (!record.device_uid) continue;
    await putJson(CONNECTIONS(), `connection/${record.device_uid}`, record);
  }

  return json({
    success: true,
    message: "SQLite export imported into Netlify Blobs.",
    imported: {
      users: users.length,
      devices: devices.length,
      events: events.length,
      connection_states: connections.length,
    },
  });
}

async function handleSignup(req) {
  if (req.method !== "POST") return methodNotAllowed();
  const payload = await readJson(req);
  const name = validateString(payload.name, "Name", 2, 80);
  const email = normalizeEmail(payload.email);
  validateString(payload.password, "Password", 8, 200);

  if (await getUserByEmail(email)) {
    return error("An account already uses this email.", 409);
  }

  const user = {
    id: createId(),
    name,
    email,
    password_hash: hashPassword(payload.password),
    created_at: nowIso(),
  };
  const userStore = USERS();
  await putJson(userStore, `user/${user.id}`, user, { onlyIfNew: true });
  await putJson(userStore, `email/${emailIndexKey(email)}`, { user_id: user.id }, { onlyIfNew: true });

  const session = await createSession(user.id);
  return json({
    success: true,
    message: "Account created successfully.",
    user: publicUser(user),
    ...session,
  });
}

async function handleLogin(req) {
  if (req.method !== "POST") return methodNotAllowed();
  const payload = await readJson(req);
  const email = normalizeEmail(payload.email);
  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(payload.password, user.password_hash)) {
    return error("Incorrect email or password.", 401);
  }
  const session = await createSession(user.id);
  return json({
    success: true,
    message: "Signed in successfully.",
    user: publicUser(user),
    ...session,
  });
}

async function handleAccount(req, subpath) {
  if (subpath === "/account/signup") return await handleSignup(req);
  if (subpath === "/account/login") return await handleLogin(req);

  const user = await currentUser(req, true);
  if (subpath === "/account/me" && req.method === "GET") {
    return json({ user: publicUser(user) });
  }
  if (subpath === "/account/logout" && req.method === "POST") {
    await revokeUserSessions(user.id);
    return json({ success: true, message: "Signed out successfully." });
  }
  if (subpath === "/account" && req.method === "DELETE") {
    const payload = await readJson(req);
    if (!verifyPassword(payload.password, user.password_hash)) {
      return error("Password is incorrect.", 401);
    }
    const devices = await listDevicesForUser(user.id);
    for (const device of devices) await deleteDeviceRecords(device.device_uid);
    await revokeUserSessions(user.id);
    const userStore = USERS();
    await userStore.delete(`user/${user.id}`);
    await userStore.delete(`email/${emailIndexKey(user.email)}`);
    return json({
      success: true,
      message: "Account and all owned USB records were deleted.",
    });
  }
  return methodNotAllowed();
}

async function handleDeviceRegister(req) {
  if (req.method !== "POST") return methodNotAllowed();
  const payload = await readJson(req);
  const ownerAccount = await resolveRegistrationOwner(req);

  const device = {
    device_uid: createDeviceUid(),
    user_id: ownerAccount.id,
    device_name: validateString(payload.device_name, "USB name", 1, 80),
    owner: validateString(payload.owner, "Owner", 1, 80),
    login_username: validateString(payload.login_username, "Login username", 1, 80),
    password_hash: hashPassword(validateString(payload.password, "Password", 4, 200)),
    vault_hash: null,
    registered_at: nowIso(),
  };
  await putJson(DEVICES(), `device/${device.device_uid}`, device, { onlyIfNew: true });
  const identity = publicDevice(device);
  delete identity.vault_hash;
  delete identity.registered_at;

  return json({
    registered: true,
    message: "USB registered successfully",
    device: publicDevice(device),
    usb_guardian_id: identity,
    usb_guardian_id_text: JSON.stringify(identity, null, 2),
  });
}

async function handleDeviceCheck(req, uid) {
  if (req.method !== "GET") return methodNotAllowed();
  const device = await getDevice(uid);
  return json({
    registered: Boolean(device),
    device: device ? publicDevice(device) : null,
  });
}

async function handleDeviceLogin(req, context) {
  if (req.method !== "POST") return methodNotAllowed();
  const payload = await readJson(req);
  const uid = validateString(payload.device_uid, "Device UID", 3, 100);
  const loginUsername = validateString(payload.login_username, "Login username", 1, 80);
  const { hostUser, hostDevice, hostPlatform } = hostFields(payload);
  const location = await resolveLocation(payload, uid, context, req);
  const device = await getDevice(uid);

  const base = {
    deviceUid: uid,
    deviceName: device?.device_name || null,
    owner: device?.owner || null,
    loginUsername,
    hostUser,
    hostDevice,
    hostPlatform,
    connection: "CONNECTED",
    eventType: "ACCESS",
    tamperStatus: String(payload.tamper_status || "OK").toUpperCase(),
    location,
  };

  if (!device) {
    const event = await createEvent({ ...base, accessStatus: "DENIED_DEVICE_NOT_REGISTERED" });
    return json({ success: false, message: "ACCESS DENIED", reason: "Device not registered", ...event });
  }
  if (loginUsername !== device.login_username) {
    const event = await createEvent({ ...base, deviceName: device.device_name, owner: device.owner, accessStatus: "DENIED_WRONG_USERNAME" });
    return json({ success: false, message: "ACCESS DENIED", reason: "Wrong username", ...event });
  }
  if (!verifyPassword(payload.password, device.password_hash)) {
    const event = await createEvent({ ...base, deviceName: device.device_name, owner: device.owner, accessStatus: "DENIED_WRONG_PASSWORD" });
    return json({ success: false, message: "ACCESS DENIED", reason: "Wrong password", ...event });
  }

  const event = await createEvent({
    ...base,
    deviceName: device.device_name,
    owner: device.owner,
    loginUsername: device.login_username,
    accessStatus: "GRANTED",
  });
  return json({ success: true, message: "ACCESS GRANTED", reason: "Login successful", ...event });
}

async function handleDeviceOpened(req, context) {
  if (req.method !== "POST") return methodNotAllowed();
  const payload = await readJson(req);
  const uid = validateString(payload.device_uid, "Device UID", 3, 100);
  const device = await getDevice(uid);
  const location = await resolveLocation(payload, uid, context, req);
  const { hostUser, hostDevice, hostPlatform } = hostFields(payload);
  const tamperStatus = await calculateTamperStatus(
    device,
    payload.tamper_status,
    payload.vault_hash,
  );

  const previous = await getJson(CONNECTIONS(), `connection/${uid}`);
  const previousSeen = new Date(previous?.last_seen || previous?.time || 0).getTime();
  const recentMonitorActivation =
    previous?.connection === "CONNECTED" &&
    Number.isFinite(previousSeen) &&
    Date.now() - previousSeen <= 15000;

  const event = await createEvent({
    deviceUid: uid,
    deviceName: device?.device_name || payload.device_name || null,
    owner: device?.owner || payload.owner || null,
    loginUsername: device?.login_username || payload.login_username || null,
    hostUser,
    hostDevice,
    hostPlatform,
    connection: "CONNECTED",
    eventType: "ACTIVATION",
    accessStatus: "APPLICATION_OPENED",
    tamperStatus,
    location,
    notifyOwner: Boolean(device && !recentMonitorActivation),
    notificationKind: "APPLICATION_OPENED",
  });

  return json({
    success: true,
    message: "USB Guardian activation recorded",
    registered: Boolean(device),
    notification_queued: Boolean(device && !recentMonitorActivation),
    event,
  });
}

async function handleConnection(req, context) {
  if (req.method !== "POST") return methodNotAllowed();
  const payload = await readJson(req);
  const uid = validateString(payload.device_uid, "Device UID", 1, 100);
  const connection = String(payload.connection || payload.connection_status || "").trim().toUpperCase();
  if (!["CONNECTED", "DISCONNECTED"].includes(connection)) {
    return json({ success: false, message: "Connection update rejected", reason: "connection must be CONNECTED or DISCONNECTED" });
  }

  const device = await getDevice(uid);
  const previous = await getJson(CONNECTIONS(), `connection/${uid}`);
  const previousSeen = new Date(previous?.last_seen || previous?.time || 0).getTime();
  const previousConnectionIsFresh =
    previous?.connection === "CONNECTED" &&
    Number.isFinite(previousSeen) &&
    Date.now() - previousSeen <= 30000;
  const isActivation = connection === "CONNECTED" && !previousConnectionIsFresh;

  const location = await resolveLocation(payload, null, context, req);
  const { hostUser, hostDevice, hostPlatform } = hostFields(payload);
  const tamperStatus = await calculateTamperStatus(device, payload.tamper_status, payload.vault_hash);
  const event = await createEvent({
    deviceUid: uid,
    deviceName: device?.device_name || payload.device_name || null,
    owner: device?.owner || payload.owner || null,
    loginUsername: device?.login_username || payload.login_username || null,
    hostUser,
    hostDevice,
    hostPlatform,
    connection,
    eventType: isActivation ? "ACTIVATION" : "CONNECTION",
    accessStatus: isActivation ? "PENDRIVE_ACTIVATED" : "NOT_ATTEMPTED",
    tamperStatus,
    location,
    notifyOwner: Boolean(device && isActivation),
    notificationKind: isActivation ? "PENDRIVE_ACTIVATED" : null,
  });
  return json({
    success: true,
    message: isActivation
      ? "Pendrive activation recorded"
      : `Connection updated: ${connection}`,
    registered: Boolean(device),
    notification_queued: Boolean(device && isActivation),
    event,
    missing_files: Array.isArray(payload.missing_files) ? payload.missing_files : [],
  });
}

async function handleDevices(req, path) {
  const user = await currentUser(req, true);
  if (path === "/devices" && req.method === "GET") {
    return json({ devices: await listDevicesForUser(user.id) });
  }
  const match = path.match(/^\/devices\/([^/]+)$/);
  if (match && req.method === "DELETE") {
    const uid = decodeURIComponent(match[1]);
    const device = await ensureOwnedDevice(uid, user.id);
    await deleteDeviceRecords(uid);
    return json({ success: true, message: `${device.device_name} and its logs were deleted.` });
  }
  return methodNotAllowed();
}

async function handleEvents(req, path) {
  const user = await currentUser(req, true);
  if (path === "/events" && req.method === "GET") {
    const limit = new URL(req.url).searchParams.get("limit") || "250";
    return json({ events: await eventsForUser(user.id, limit) });
  }
  if (path === "/events/delete-selected" && req.method === "POST") {
    const payload = await readJson(req);
    const selected = new Set((payload.event_ids || []).map((value) => Number(value)).filter(Number.isFinite));
    if (!selected.size) return error("Select at least one event.", 422);
    const owned = await eventsForUser(user.id, 1000);
    const ids = owned.filter((event) => selected.has(Number(event.id))).map((event) => event.id);
    await Promise.all(ids.map((id) => EVENTS().delete(`event/${id}`)));
    if (!ids.length) return error("No matching owned events were found.", 404);
    return json({ success: true, deleted_count: ids.length, message: `Deleted ${ids.length} event record(s).` });
  }
  const match = path.match(/^\/events\/(\d+)$/);
  if (match && req.method === "DELETE") {
    const id = Number(match[1]);
    const owned = await eventsForUser(user.id, 1000);
    if (!owned.some((event) => Number(event.id) === id)) return error("Event record not found.", 404);
    await EVENTS().delete(`event/${id}`);
    return json({ success: true, message: "Event record deleted." });
  }
  return methodNotAllowed();
}

async function handleConnections(req) {
  if (req.method !== "GET") return methodNotAllowed();
  const user = await currentUser(req, true);
  return json({ connections: await connectionsForUser(user.id) });
}

async function handleIdentity(req, uid) {
  if (req.method !== "GET") return methodNotAllowed();
  const user = await currentUser(req, true);
  const device = await ensureOwnedDevice(uid, user.id);
  const identity = {
    device_uid: device.device_uid,
    device_name: device.device_name,
    owner: device.owner,
    login_username: device.login_username,
  };
  return json(identity, 200, {
    "content-disposition": 'attachment; filename="usb_guardian.id"',
  });
}

async function handleDownloads(req, path) {
  if (path === "/downloads/status" && req.method === "GET") {
    let buildReady = false;
    try {
      const response = await fetch(new URL("/downloads/build-manifest.json", req.url), { cache: "no-store" });
      buildReady = response.ok;
    } catch {}
    return json({
      windows_client: buildReady,
      usb_monitor: buildReady,
      usb_monitor_installer: buildReady,
      android_app: buildReady,
      windows_package_note: "Download usb_guardian.id separately, then prepare a vault-only USB containing Open Secure USB.exe, usb_guardian.id, and secure_data.hc.",
    });
  }
  if (path === "/downloads/windows-client") return redirect(req, "/downloads/Open_Secure_USB.exe", "Open Secure USB.exe");
  if (path === "/downloads/usb-monitor") return redirect(req, "/downloads/USBMonitor.exe", "USBMonitor.exe");
  if (path === "/downloads/usb-monitor-installer") return redirect(req, "/downloads/Smart_USB_Guardian_One_Click_Setup.zip", "Smart_USB_Guardian_One_Click_Setup.zip");
  if (path === "/downloads/android-app") return redirect(req, "/downloads/USBGuardianMobile.apk", "USBGuardianMobile.apk");
  return null;
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });

  const path = normalizedPath(req);
  try {
    if ((path === "/" || path === "/health") && req.method === "GET") {
      return json({
        message: "Smart USB Guardian Netlify API running",
        version: "4.1.0-netlify",
        storage: "Netlify Blobs",
        realtime_mode: "polling-with-owner-alerts",
      });
    }


    if (path === "/admin/import") return await handleAdminImport(req);

    if (path.startsWith("/account")) return await handleAccount(req, path);
    if (path === "/device/register") return await handleDeviceRegister(req);
    if (path === "/device/login") return await handleDeviceLogin(req, context);
    if (path === "/device/opened") return await handleDeviceOpened(req, context);
    if (path === "/device/connection") return await handleConnection(req, context);

    const checkMatch = path.match(/^\/device\/check\/([^/]+)$/);
    if (checkMatch) return await handleDeviceCheck(req, decodeURIComponent(checkMatch[1]));

    const identityMatch = path.match(/^\/device\/([^/]+)\/identity$/);
    if (identityMatch) return await handleIdentity(req, decodeURIComponent(identityMatch[1]));

    const packageMatch = path.match(/^\/device\/([^/]+)\/windows-package$/);
    if (packageMatch) {
      const user = await currentUser(req, true);
      await ensureOwnedDevice(decodeURIComponent(packageMatch[1]), user.id);
      return redirect(req, "/downloads/Smart_USB_Guardian_Windows_Client.zip", "Smart_USB_Guardian_Windows_Client.zip");
    }


    if (path === "/dashboard/summary" && req.method === "GET") {
      const user = await currentUser(req, true);
      const limit = new URL(req.url).searchParams.get("limit") || "250";
      return json(await dashboardSummary(user.id, limit));
    }

    if (path === "/devices" || path.startsWith("/devices/")) return await handleDevices(req, path);
    if (path === "/events" || path.startsWith("/events/")) return await handleEvents(req, path);
    if (path === "/connections") return await handleConnections(req);

    const downloadResponse = await handleDownloads(req, path);
    if (downloadResponse) return downloadResponse;

    if (path === "/location" && req.method === "GET") {
      return json({
        latitude: null,
        longitude: null,
        city: context?.geo?.city || "Unknown",
        country: context?.geo?.country?.name || "Unknown",
        source: "netlify_request_geo",
      });
    }

    return error("Route not found.", 404);
  } catch (problem) {
    console.error(problem);
    return error(problem?.message || "Internal server error.", problem?.status || 500);
  }
};
