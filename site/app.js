(() => {
  "use strict";

  const CONFIG = window.SMART_USB_CONFIG || {};
  const compactRuntime = window.matchMedia("(max-width: 900px), (hover: none), (pointer: coarse)").matches;
  const pollingIntervalMs = compactRuntime
    ? Math.max(Number(CONFIG.AUTO_REFRESH_MS || 5000), 8000)
    : Number(CONFIG.AUTO_REFRESH_MS || 5000);
  const dashboardEventsLimit = compactRuntime
    ? Math.min(Number(CONFIG.EVENTS_LIMIT || 250), 120)
    : Number(CONFIG.EVENTS_LIMIT || 250);

  const state = {
    apiUrl:
      CONFIG.DEFAULT_API_URL || `${window.location.origin}/api`,
    token: localStorage.getItem("smartUsbOwnerToken") || "",
    account: null,
    autoRefresh: localStorage.getItem("smartUsbAutoRefresh") !== "false",
    activationNotifications:
      localStorage.getItem("smartUsbActivationNotifications") !== "false",
    devices: [],
    events: [],
    connections: [],
    selectedEventIds: new Set(),
    refreshTimer: null,
    statusTimer: null,
    selectedDevice: null,
    restOnline: false,
    pollingOnline: false,
    lastRefresh: null,
    lastConnectionSignature: "",
    lastDashboardSignature: "",
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];
  const esc = (value) =>
    String(value ?? "-").replace(
      /[&<>'"]/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[c],
    );
  const upper = (value) =>
    String(value || "")
      .trim()
      .toUpperCase();

  const elements = {
    authScreen: $("#authScreen"),
    appShell: $("#appShell"),
    loginForm: $("#loginForm"),
    signupForm: $("#signupForm"),
    sidebar: $("#sidebar"),
    backdrop: $("#sidebarBackdrop"),
    pageTitle: $("#pageTitle"),
    liveIndicator: $("#liveIndicator"),
    sidebarConnection: $("#sidebarConnection"),
    systemStatus: $("#systemStatus"),
    restStatus: $("#restStatus"),
    websocketStatus: $("#websocketStatus"),
    lastRefreshStatus: $("#lastRefreshStatus"),
    metricDevices: $("#metricDevices"),
    metricConnected: $("#metricConnected"),
    metricGranted: $("#metricGranted"),
    metricDenied: $("#metricDenied"),
    metricAlerts: $("#metricAlerts"),
    connectedList: $("#connectedList"),
    recentEventsBody: $("#recentEventsBody"),
    activityChart: $("#activityChart"),
    devicesBody: $("#devicesBody"),
    logsBody: $("#logsBody"),
    alertsList: $("#alertsList"),
    navAlertCount: $("#navAlertCount"),
    criticalAlertCount: $("#criticalAlertCount"),
    warningAlertCount: $("#warningAlertCount"),
    infoAlertCount: $("#infoAlertCount"),
    apiUrlInput: $("#apiUrlInput"),
    autoRefreshInput: $("#autoRefreshInput"),
    activationNotificationsInput: $("#activationNotificationsInput"),
    enableBrowserNotificationsButton: $("#enableBrowserNotificationsButton"),
    notificationPermissionStatus: $("#notificationPermissionStatus"),
    registrationResult: $("#registrationResult"),
    deviceModal: $("#deviceModal"),
    modalDeviceTitle: $("#modalDeviceTitle"),
    modalDeviceDetails: $("#modalDeviceDetails"),
    deleteAccountModal: $("#deleteAccountModal"),
    toastContainer: $("#toastContainer"),
  };

  function normalizedApiUrl(value) {
    return String(value || "")
      .trim()
      .replace(/\/+$/, "");
  }

  function authorizationHeaders(headers = {}) {
    return state.token
      ? { Authorization: `Bearer ${state.token}`, ...headers }
      : headers;
  }


  async function api(path, options = {}, authRequired = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    const response = await fetch(`${state.apiUrl}${path}`, {
      ...options,
      headers: authRequired ? authorizationHeaders(headers) : headers,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const detail =
        typeof data.detail === "string"
          ? data.detail
          : data.reason || data.message || `HTTP ${response.status}`;
      const error = new Error(detail);
      error.status = response.status;
      error.data = data;
      if (response.status === 401 && authRequired) clearSession(true);
      throw error;
    }
    return data;
  }

  function toast(title, message, type = "info") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.innerHTML = `<span>${type === "success" ? "✓" : type === "error" ? "×" : "i"}</span><div><strong>${esc(title)}</strong><small>${esc(message)}</small></div>`;
    elements.toastContainer.appendChild(node);
    setTimeout(() => node.remove(), 4800);
  }

  function notificationCursorKey() {
    return `smartUsbLastActivationEventId:${state.account?.id || "owner"}`;
  }

  function updateNotificationPermissionStatus() {
    const status = elements.notificationPermissionStatus;
    const button = elements.enableBrowserNotificationsButton;
    if (!status || !button) return;

    if (!("Notification" in window)) {
      status.textContent = "This browser does not support system notifications.";
      button.disabled = true;
      button.textContent = "Not supported";
      return;
    }

    if (Notification.permission === "granted") {
      status.textContent = "System activation alerts are enabled on this device.";
      button.disabled = true;
      button.textContent = "Notifications enabled";
    } else if (Notification.permission === "denied") {
      status.textContent = "Notifications are blocked. Enable them in your browser site settings.";
      button.disabled = true;
      button.textContent = "Notifications blocked";
    } else {
      status.textContent = "Enable browser permission for desktop activation alerts.";
      button.disabled = false;
      button.textContent = "Enable device notifications";
    }
  }

  async function requestBrowserNotifications() {
    if (!("Notification" in window)) {
      toast("Notifications unavailable", "This browser does not support system notifications.", "error");
      return;
    }
    const permission = await Notification.requestPermission();
    updateNotificationPermissionStatus();
    if (permission === "granted") {
      toast("Activation alerts enabled", "This device can now display pendrive activation notifications.", "success");
    } else {
      toast("Permission not enabled", "In-dashboard alerts will still appear while the owner portal is open.", "info");
    }
  }

  function activationNotificationTitle(event) {
    return event.notification_kind === "APPLICATION_OPENED" ||
      event.access_status === "APPLICATION_OPENED"
      ? `${event.device_name} application opened`
      : `${event.device_name} activated`;
  }

  function activationNotificationMessage(event) {
    const host = event.host_device || "Unknown device";
    const place = locationText(event);
    return `${host} • ${place} • ${formatDate(event.time)}`;
  }

  function showSystemActivationNotification(event) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const title = activationNotificationTitle(event);
    const options = {
      body: activationNotificationMessage(event),
      icon: "./assets/apple-touch-icon.png",
      badge: "./assets/apple-touch-icon.png",
      tag: `smart-usb-activation-${event.device_uid}`,
      renotify: true,
      data: { url: `${window.location.origin}/#logs` },
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        .then((registration) => registration.showNotification(title, options))
        .catch(() => new Notification(title, options));
    } else {
      new Notification(title, options);
    }
  }

  function notifyOwnerOfActivation(event) {
    const tampered = !["OK", "NORMAL", "UNKNOWN", "-"].includes(event.tamper_status);
    toast(
      activationNotificationTitle(event),
      activationNotificationMessage(event),
      tampered ? "error" : "success",
    );
    showSystemActivationNotification(event);
  }

  function processActivationNotifications(events) {
    if (!state.account) return;
    const key = notificationCursorKey();
    const stored = localStorage.getItem(key);
    const validIds = events.map((event) => Number(event.id)).filter(Number.isFinite);

    if (!validIds.length) {
      if (stored === null) localStorage.setItem(key, "0");
      return;
    }

    const newestId = Math.max(...validIds);
    if (stored === null) {
      localStorage.setItem(key, String(newestId));
      return;
    }

    const cursor = Number(stored) || 0;
    const activations = events
      .filter((event) => Number(event.id) > cursor && event.notify_owner === true)
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (state.activationNotifications) {
      activations.slice(-5).forEach(notifyOwnerOfActivation);
    }
    localStorage.setItem(key, String(Math.max(cursor, newestId)));
  }

  function showAuth(mode = "login") {
    elements.authScreen.classList.remove("hidden");
    elements.appShell.classList.add("hidden");
    toggleAuthTab(mode);
  }

  function showApp() {
    elements.authScreen.classList.add("hidden");
    elements.appShell.classList.remove("hidden");
  }

  function toggleAuthTab(mode) {
    const login = mode === "login";
    $("#showLoginTab").classList.toggle("active", login);
    $("#showSignupTab").classList.toggle("active", !login);
    elements.loginForm.classList.toggle("active", login);
    elements.signupForm.classList.toggle("active", !login);
  }

  function storeSession(result) {
    state.token = result.access_token;
    state.account = result.user;
    localStorage.setItem("smartUsbOwnerToken", state.token);
  }

  function clearSession(showLogin = true) {
    state.token = "";
    state.account = null;
    state.devices = [];
    state.events = [];
    state.connections = [];
    state.selectedEventIds.clear();
    localStorage.removeItem("smartUsbOwnerToken");
    clearInterval(state.refreshTimer);
    clearInterval(state.statusTimer);
    if (showLogin) showAuth("login");
  }

  async function authenticateExistingSession() {
    if (!state.token) return false;
    try {
      const result = await api("/account/me");
      state.account = result.user;
      return true;
    } catch {
      clearSession(false);
      return false;
    }
  }

  async function loginAccount(event) {
    event.preventDefault();
    const button = $("#loginButton");
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      const result = await api(
        "/account/login",
        {
          method: "POST",
          body: JSON.stringify({
            email: $("#loginEmail").value.trim(),
            password: $("#loginPassword").value,
          }),
        },
        false,
      );
      storeSession(result);
      elements.loginForm.reset();
      await startAuthenticatedApp();
      toast(
        "Login successful",
        `Welcome back, ${result.user.name}.`,
        "success",
      );
    } catch (error) {
      toast("Login failed", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Login";
    }
  }

  async function signupAccount(event) {
    event.preventDefault();
    const password = $("#signupPassword").value;
    if (password !== $("#signupConfirmPassword").value) {
      toast(
        "Passwords do not match",
        "Enter the same password in both fields.",
        "error",
      );
      return;
    }
    const button = $("#signupButton");
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const result = await api(
        "/account/signup",
        {
          method: "POST",
          body: JSON.stringify({
            name: $("#signupName").value.trim(),
            email: $("#signupEmail").value.trim(),
            password,
          }),
        },
        false,
      );
      storeSession(result);
      elements.signupForm.reset();
      await startAuthenticatedApp();
      toast("Account created", "Your owner account is ready.", "success");
    } catch (error) {
      toast("Sign-up failed", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Create account";
    }
  }

  async function logoutAccount() {
    try {
      if (state.token) await api("/account/logout", { method: "POST" });
    } catch {}
    clearSession(true);
    toast("Signed out", "Your local owner session was cleared.", "success");
  }

  async function deleteAccount(event) {
    event.preventDefault();
    const button = $("#confirmDeleteAccountButton");
    button.disabled = true;
    button.textContent = "Deleting…";
    try {
      await api("/account", {
        method: "DELETE",
        body: JSON.stringify({ password: $("#deleteAccountPassword").value }),
      });
      elements.deleteAccountModal.close();
      clearSession(true);
      toast(
        "Account deleted",
        "The account and its USB records were permanently deleted.",
        "success",
      );
    } catch (error) {
      toast("Account deletion failed", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Delete permanently";
    }
  }

  function pickArray(payload, key) {
    if (Array.isArray(payload)) return payload;
    return Array.isArray(payload?.[key]) ? payload[key] : [];
  }

  function normalizeLocation(event) {
    const raw = event.location;
    if (raw && typeof raw === "object") {
      return {
        city: raw.city || raw.town || raw.region || "Unknown",
        country: raw.country || "Unknown",
        latitude: event.latitude ?? raw.latitude ?? raw.lat ?? null,
        longitude: event.longitude ?? raw.longitude ?? raw.lon ?? null,
      };
    }
    const text = typeof raw === "string" && raw ? raw : event.city || "Unknown";
    const parts = text.split(",").map((item) => item.trim());
    return {
      city: parts[0] || "Unknown",
      country: parts.slice(1).join(", ") || event.country || "Unknown",
      latitude: event.latitude ?? null,
      longitude: event.longitude ?? null,
    };
  }

  function normalizeEvent(raw = {}) {
    const access = upper(raw.access_status || raw.status || "UNKNOWN");
    const explicitType = upper(raw.event_type || "");
    const legacyConnectionEvent = ["CONNECTED", "DISCONNECTED"].includes(
      access,
    );
    const eventType = legacyConnectionEvent
      ? "CONNECTION"
      : ["CONNECTION", "ACCESS", "ACTIVATION"].includes(explicitType)
        ? explicitType
        : "ACCESS";
    const hostDevice = raw.host_device || raw.computer_name || "Unknown host";
    return {
      id: Number(raw.id),
      device_uid: raw.device_uid || "Unknown",
      device_name: raw.device_name || raw.usb_name || "Unknown USB",
      owner: raw.owner || "Unknown",
      login_username: raw.login_username || raw.username || "-",
      host_user: raw.host_user || raw.windows_user || "Unknown",
      host_device: hostDevice,
      host_platform:
        raw.host_platform ||
        (String(hostDevice).toLowerCase().includes("android")
          ? "Android"
          : "Windows"),
      location: normalizeLocation(raw),
      time: raw.time || raw.timestamp || raw.last_seen || "-",
      event_type: eventType,
      connection: upper(raw.connection || raw.connection_status || "UNKNOWN"),
      access_status: eventType === "CONNECTION" ? "NOT_ATTEMPTED" : access,
      tamper_status: upper(raw.tamper_status || "OK"),
      notify_owner: raw.notify_owner === true || raw.notify_owner === "true",
      notification_kind: upper(raw.notification_kind || ""),
    };
  }

  function normalizeConnection(raw = {}) {
    const item = normalizeEvent(raw);
    return {
      ...item,
      last_seen: raw.last_seen || raw.time || raw.timestamp || item.time,
      connection: upper(raw.connection || raw.connection_status || "UNKNOWN"),
    };
  }

  function normalizeDevice(raw = {}) {
    return {
      device_uid: raw.device_uid || raw.uid || "Unknown",
      device_name: raw.device_name || raw.usb_name || "Unknown USB",
      owner: raw.owner || "Unknown",
      login_username: raw.login_username || raw.username || "-",
      registered_at: raw.registered_at || raw.created_at || "-",
    };
  }

  function connectionTimeoutMs(connection) {
    const base = Number(CONFIG.CONNECTION_STALE_MS || 20000);
    return upper(connection?.host_platform).includes("ANDROID")
      ? Math.max(base, 90000)
      : base;
  }

  function effectiveConnectionStatus(connection) {
    if (!connection) return "DISCONNECTED";
    const reported = upper(connection.connection || "UNKNOWN");
    if (reported !== "CONNECTED") return reported || "DISCONNECTED";
    const seen = new Date(connection.last_seen || connection.time || "");
    if (Number.isNaN(seen.getTime())) return "DISCONNECTED";
    return Date.now() - seen.getTime() <= connectionTimeoutMs(connection)
      ? "CONNECTED"
      : "DISCONNECTED";
  }

  function connectionFor(uid) {
    const connection = state.connections.find(
      (item) => item.device_uid === uid,
    );
    return connection
      ? { ...connection, connection: effectiveConnectionStatus(connection) }
      : null;
  }

  function currentConnectionForEvent(event) {
    return connectionFor(event.device_uid)?.connection || "DISCONNECTED";
  }

  function eventConnectionForDisplay(event) {
    const reported = upper(event?.connection || event?.connection_status || "");
    if (["CONNECTED", "DISCONNECTED"].includes(reported)) return reported;
    return currentConnectionForEvent(event);
  }

  function accessStatusForDisplay(event) {
    const status = upper(event?.access_status || "UNKNOWN");
    if (event?.event_type === "CONNECTION" && status === "NOT_ATTEMPTED") {
      return "NO LOGIN ATTEMPT";
    }
    return status.replaceAll("_", " ");
  }

  function formatDate(value) {
    if (!value || value === "-") return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function locationText(event) {
    const city = String(event.location?.city || "Unknown").trim();
    const country = String(event.location?.country || "Unknown").trim();
    const cityKnown = city && city.toLowerCase() !== "unknown";
    const countryKnown = country && country.toLowerCase() !== "unknown";

    if (cityKnown && countryKnown && !city.includes(country)) {
      return `${city}, ${country}`;
    }
    if (cityKnown) return city;
    if (countryKnown) return country;

    const latitude = event.location?.latitude;
    const longitude = event.location?.longitude;
    if (latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined) {
      return `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
    }
    return "Location unavailable";
  }

  function coordinateText(event) {
    const latitude = event.location?.latitude;
    const longitude = event.location?.longitude;
    if (
      latitude === null ||
      latitude === undefined ||
      longitude === null ||
      longitude === undefined
    )
      return "Coordinates unavailable";
    return `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`;
  }

  function badge(value) {
    const status = upper(value) || "UNKNOWN";
    let cls = "info";
    if (status === "CONNECTED") cls = "connected";
    else if (status === "DISCONNECTED" || status === "UNKNOWN")
      cls = "disconnected";
    else if (status.includes("GRANTED")) cls = "granted";
    else if (status.includes("DENIED") || status.includes("FAILED"))
      cls = "denied";
    else if (status === "OK" || status === "NORMAL") cls = "ok";
    else if (
      status.includes("TAMPER") ||
      status.includes("MISSING") ||
      status.includes("MODIFIED")
    )
      cls = "warning";
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }

  function alertsFromEvents() {
    const alerts = [];
    state.events.forEach((event) => {
      if (!["OK", "NORMAL", "UNKNOWN", "-"].includes(event.tamper_status))
        alerts.push({
          severity: "critical",
          title: event.tamper_status.replaceAll("_", " "),
          description: `${event.device_name} reported a tamper condition on ${event.host_device}.`,
          time: event.time,
        });
      if (event.access_status.includes("DENIED"))
        alerts.push({
          severity: "warning",
          title: "Access denied",
          description: `${event.login_username} was denied access to ${event.device_name} from ${event.host_device}.`,
          time: event.time,
        });
      if (event.event_type === "ACTIVATION" && event.notify_owner)
        alerts.push({
          severity: "info",
          title: event.access_status === "APPLICATION_OPENED" ? "Guardian opened" : "Pendrive activated",
          description: `${event.device_name} became active on ${event.host_device}.`,
          time: event.time,
        });
    });
    return alerts.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  }

  function setOnline(restOnline, pollingOnline = restOnline) {
    state.restOnline = restOnline;
    state.pollingOnline = pollingOnline;
    elements.sidebarConnection.innerHTML = `<span class="status-dot ${restOnline ? "online" : "offline"}"></span><div><strong>${restOnline ? "Protection active" : "Protection unavailable"}</strong><small>${restOnline ? "Secure monitoring ready" : "Check your internet connection"}</small></div>`;
    elements.liveIndicator?.classList.toggle("offline", !pollingOnline);
    if (elements.liveIndicator)
      elements.liveIndicator.innerHTML = `<span></span>${pollingOnline ? "Live monitoring" : "Monitoring paused"}`;
    if (elements.systemStatus)
      elements.systemStatus.innerHTML = `<span class="status-dot ${restOnline ? "online" : "offline"}"></span><div><strong>${restOnline ? "Ready" : "Unavailable"}</strong><small>${restOnline ? "Secure services are active" : "Secure services could not be reached"}</small></div>`;
    if (elements.restStatus)
      elements.restStatus.textContent = restOnline ? "Online" : "Offline";
    if (elements.websocketStatus)
      elements.websocketStatus.textContent = pollingOnline
        ? `${Math.round(pollingIntervalMs / 1000)}-second polling`
        : "Stopped";
  }

  async function loadDevices() {
    state.devices = pickArray(await api("/devices"), "devices").map(
      normalizeDevice,
    );
  }
  async function loadEvents() {
    state.events = pickArray(
      await api(`/events?limit=${dashboardEventsLimit}`),
      "events",
    ).map(normalizeEvent);
  }
  async function loadConnections() {
    state.connections = pickArray(await api("/connections"), "connections").map(
      normalizeConnection,
    );
  }

  function dashboardSignature(devices, events, connections) {
    return JSON.stringify({
      devices: devices.map((item) => [item.device_uid, item.device_name, item.registered_at]),
      events: events.map((item) => [
        item.id,
        item.time,
        item.event_type,
        item.access_status,
        item.connection,
        item.tamper_status,
      ]),
      connections: connections.map((item) => [
        item.device_uid,
        item.connection,
        item.last_seen || item.time,
      ]),
    });
  }

  async function refreshAll(showToast = false) {
    if (!state.token) return;
    try {
      const summary = await api(`/dashboard/summary?limit=${dashboardEventsLimit}`);
      const nextDevices = pickArray(summary, "devices").map(normalizeDevice);
      const nextEvents = pickArray(summary, "events").map(normalizeEvent);
      const nextConnections = pickArray(summary, "connections").map(normalizeConnection);
      const nextSignature = dashboardSignature(nextDevices, nextEvents, nextConnections);
      const dashboardChanged = nextSignature !== state.lastDashboardSignature;

      state.devices = nextDevices;
      state.events = nextEvents;
      state.connections = nextConnections;
      state.lastDashboardSignature = nextSignature;
      processActivationNotifications(state.events);
      state.lastRefresh = new Date();
      state.selectedEventIds = new Set(
        [...state.selectedEventIds].filter((id) =>
          state.events.some((event) => event.id === id),
        ),
      );
      setOnline(true, true);
      if (dashboardChanged) {
        renderAll();
      } else if (elements.lastRefreshStatus) {
        elements.lastRefreshStatus.textContent = state.lastRefresh.toLocaleString();
      }
      if (showToast)
        toast(
          "Dashboard refreshed",
          dashboardChanged ? "Latest owner records were loaded." : "Dashboard is already up to date.",
          "success",
        );
    } catch (error) {
      setOnline(false, false);
      if (error.status !== 401 && showToast)
        toast("Refresh failed", error.message, "error");
    }
  }

  function renderAccount() {
    if (!state.account) return;
    const initials =
      state.account.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "U";
    $("#profileAvatar").textContent = initials;
    $("#profileName").textContent = state.account.name;
    $("#profileEmail").textContent = state.account.email;
    $("#accountName").textContent = state.account.name;
    $("#accountEmail").textContent = state.account.email;
    $("#accountCreatedAt").textContent = formatDate(state.account.created_at);
    $("#accountDeviceCount").textContent = state.devices.length;
    $("#ownerInput").value ||= state.account.name;
  }

  function renderMetrics() {
    const connected = state.connections.filter(
      (item) => effectiveConnectionStatus(item) === "CONNECTED",
    ).length;
    const granted = state.events.filter(
      (item) =>
        item.event_type === "ACCESS" && item.access_status.includes("GRANTED"),
    ).length;
    const denied = state.events.filter(
      (item) =>
        item.event_type === "ACCESS" &&
        (item.access_status.includes("DENIED") ||
          item.access_status.includes("FAILED")),
    ).length;
    const alerts = alertsFromEvents();
    elements.metricDevices.textContent = state.devices.length;
    elements.metricConnected.textContent = connected;
    elements.metricGranted.textContent = granted;
    elements.metricDenied.textContent = denied;
    elements.metricAlerts.textContent = alerts.length;
    $("#metricDevicesHint").textContent =
      `${state.devices.length} device${state.devices.length === 1 ? "" : "s"} owned`;
    $("#metricConnectedHint").textContent = connected
      ? `${connected} active host${connected === 1 ? "" : "s"}`
      : "No active hosts";
  }

  function renderConnected() {
    const rows = state.connections
      .filter((item) => effectiveConnectionStatus(item) === "CONNECTED")
      .slice(0, 6);
    elements.connectedList.innerHTML = rows.length
      ? rows
          .map(
            (item) =>
              `<article class="device-status-item"><div class="usb-avatar">U</div><div class="device-status-copy"><strong>${esc(item.device_name)}</strong><small>${esc(item.host_device)} • ${esc(locationText(item))}</small><small>Lat/Lng: ${esc(coordinateText(item))}</small></div>${badge("CONNECTED")}</article>`,
          )
          .join("")
      : `<div class="empty-state compact">No connected USB devices.</div>`;
  }

  function renderRecentEvents() {
    const rows = state.events
      .filter((event) => event.event_type === "ACCESS")
      .slice(0, 8);
    elements.recentEventsBody.innerHTML = rows.length
      ? rows
          .map(
            (event) =>
              `<tr><td><strong>${esc(event.device_name)}</strong><small>${esc(event.device_uid)}</small></td><td>${esc(event.host_device)}</td><td>${esc(event.host_platform)}</td><td>${esc(locationText(event))}</td><td>${esc(event.location.latitude ?? "-")}</td><td>${esc(event.location.longitude ?? "-")}</td><td>${esc(formatDate(event.time))}</td><td>${badge(eventConnectionForDisplay(event))}</td><td>${badge(accessStatusForDisplay(event))}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="9"><div class="empty-state">No login access attempts yet.</div></td></tr>`;
  }

  function renderChart() {
    const count = Number($("#trendRange").value || 12);
    const rows = state.events.slice(0, count).reverse();
    elements.activityChart.innerHTML = rows.length
      ? rows
          .map((event, index) => {
            const kind =
              event.event_type === "CONNECTION"
                ? "connection"
                : event.access_status.includes("GRANTED")
                  ? "granted"
                  : "denied";
            const height =
              32 +
              ((index * 17 +
                (kind === "denied" ? 28 : kind === "granted" ? 18 : 8)) %
                165);
            return `<div class="chart-column" title="${esc(event.device_name)} • ${esc(event.access_status)}"><div class="chart-bar ${kind}" style="height:${height}px"></div></div>`;
          })
          .join("")
      : `<div class="empty-state">No events available.</div>`;
  }

  function renderDevices() {
    const query = upper($("#deviceSearch").value);
    const filter = $("#deviceStatusFilter").value;
    const rows = state.devices.filter((device) => {
      const status =
        connectionFor(device.device_uid)?.connection || "DISCONNECTED";
      return (
        (!query ||
          upper(
            `${device.device_uid} ${device.device_name} ${device.owner} ${device.login_username}`,
          ).includes(query)) &&
        (filter === "all" || filter === status)
      );
    });
    elements.devicesBody.innerHTML = rows.length
      ? rows
          .map((device) => {
            const connection = connectionFor(device.device_uid);
            return `<tr><td><strong>${esc(device.device_uid)}</strong></td><td>${esc(device.device_name)}</td><td>${esc(device.owner)}</td><td>${esc(device.login_username)}</td><td>${esc(formatDate(device.registered_at))}</td><td>${badge(connection?.connection || "DISCONNECTED")}</td><td>${esc(formatDate(connection?.last_seen || "-"))}</td><td>${esc(connection?.host_device || "-")}</td><td><div class="row-actions"><button class="row-action" data-device-uid="${esc(device.device_uid)}">Details</button><button class="row-action danger" data-delete-device-uid="${esc(device.device_uid)}">Delete</button></div></td></tr>`;
          })
          .join("")
      : `<tr><td colspan="9"><div class="empty-state">No devices match the filter.</div></td></tr>`;
  }

  function filteredEvents() {
    const query = upper($("#logSearch").value);
    const access = $("#accessFilter").value;
    const platform = $("#platformFilter").value;
    const connection = $("#connectionFilter").value;
    return state.events.filter((event) => {
      const currentConnection = eventConnectionForDisplay(event);
      const text = upper(
        `${event.device_uid} ${event.device_name} ${event.owner} ${event.login_username} ${event.host_user} ${event.host_device} ${event.host_platform} ${locationText(event)} ${event.access_status} ${currentConnection} ${event.tamper_status}`,
      );
      const accessMatch =
        access === "all" ||
        (access === "GRANTED" &&
          event.event_type === "ACCESS" &&
          event.access_status.includes("GRANTED")) ||
        (access === "DENIED" &&
          event.event_type === "ACCESS" &&
          (event.access_status.includes("DENIED") ||
            event.access_status.includes("FAILED"))) ||
        (access === "CONNECTION" && event.event_type === "CONNECTION") ||
        (access === "ACTIVATION" && event.event_type === "ACTIVATION");
      return (
        (!query || text.includes(query)) &&
        accessMatch &&
        (platform === "all" ||
          upper(event.host_platform).includes(upper(platform))) &&
        (connection === "all" || currentConnection === connection)
      );
    });
  }

  function updateDeleteSelectionButton() {
    const button = $("#deleteSelectedEventsButton");
    button.disabled = state.selectedEventIds.size === 0;
    button.textContent = state.selectedEventIds.size
      ? `Delete selected (${state.selectedEventIds.size})`
      : "Delete selected";
    const visible = filteredEvents();
    $("#selectAllEvents").checked =
      visible.length > 0 &&
      visible.every((event) => state.selectedEventIds.has(event.id));
  }

  function renderLogs() {
    const rows = filteredEvents();
    elements.logsBody.innerHTML = rows.length
      ? rows
          .map(
            (event) =>
              `<tr><td><input class="table-checkbox event-checkbox" type="checkbox" data-event-id="${event.id}" ${state.selectedEventIds.has(event.id) ? "checked" : ""}></td><td>${esc(event.device_uid)}</td><td>${esc(event.device_name)}</td><td>${esc(event.owner)}</td><td>${esc(event.login_username)}</td><td>${esc(event.host_user)}</td><td>${esc(event.host_device)}</td><td>${esc(event.host_platform)}</td><td>${esc(locationText(event))}</td><td>${esc(event.location.latitude ?? "-")}</td><td>${esc(event.location.longitude ?? "-")}</td><td>${esc(formatDate(event.time))}</td><td>${badge(eventConnectionForDisplay(event))}</td><td>${badge(accessStatusForDisplay(event))}</td><td>${badge(event.tamper_status || "OK")}</td><td><button class="row-action danger" data-delete-event-id="${event.id}">Delete</button></td></tr>`,
          )
          .join("")
      : `<tr><td colspan="16"><div class="empty-state">No access events match the filters.</div></td></tr>`;
    updateDeleteSelectionButton();
  }

  function renderAlerts() {
    const alerts = alertsFromEvents();
    const counts = { critical: 0, warning: 0, info: 0 };
    alerts.forEach((alert) => counts[alert.severity]++);
    elements.criticalAlertCount.textContent = counts.critical;
    elements.warningAlertCount.textContent = counts.warning;
    elements.infoAlertCount.textContent = counts.info;
    elements.navAlertCount.textContent = alerts.length;
    elements.alertsList.innerHTML = alerts.length
      ? alerts
          .map(
            (alert) =>
              `<article class="alert-card ${alert.severity}"><div class="alert-card-icon">${alert.severity === "critical" ? "!" : "△"}</div><div><h4>${esc(alert.title)}</h4><p>${esc(alert.description)}</p></div><time>${esc(formatDate(alert.time))}</time></article>`,
          )
          .join("")
      : `<div class="empty-state">No security alerts detected.</div>`;
  }

  function renderSettings() {
    if (elements.apiUrlInput) elements.apiUrlInput.value = state.apiUrl;
    elements.autoRefreshInput.checked = state.autoRefresh;
    if (elements.activationNotificationsInput)
      elements.activationNotificationsInput.checked = state.activationNotifications;
    updateNotificationPermissionStatus();
    elements.lastRefreshStatus.textContent = state.lastRefresh
      ? state.lastRefresh.toLocaleString()
      : "Never";
  }

  function renderAll() {
    renderAccount();
    renderMetrics();
    renderConnected();
    renderRecentEvents();
    renderChart();
    renderDevices();
    renderLogs();
    renderAlerts();
    renderSettings();
  }

  function identityFromRegistration(payload, submitted) {
    return (
      payload.usb_guardian_id ||
      payload.device || {
        device_uid: payload.device_uid,
        device_name: submitted.device_name,
        owner: submitted.owner,
        login_username: submitted.login_username,
      }
    );
  }

  function staticDownloadTarget(path) {
    if (path === "/downloads/usb-monitor-installer")
      return "/downloads/Smart_USB_Guardian_One_Click_Setup.zip";
    if (path === "/downloads/usb-monitor")
      return "/downloads/USBMonitor.exe";
    if (path === "/downloads/android-app")
      return "/downloads/USBGuardianMobile.apk";
    if (path === "/downloads/windows-client")
      return "/downloads/Open_Secure_USB.exe";
    if (/^\/device\/[^/]+\/windows-package$/.test(path))
      return "/downloads/Smart_USB_Guardian_Windows_Client.zip";
    return null;
  }

  function triggerNativeDownload(relativePath, filename) {
    const link = document.createElement("a");
    link.href = new URL(relativePath, window.location.origin).href;
    link.download = filename || "";
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function authenticatedDownload(path, filenameFallback) {
    const staticTarget = staticDownloadTarget(path);
    if (staticTarget) {
      // Stream large EXE/APK/ZIP files directly through the browser download
      // manager. Creating an in-memory Blob caused lag and intermittent broken
      // downloads on Android and lower-memory Windows systems.
      triggerNativeDownload(staticTarget, filenameFallback);
      return;
    }

    try {
      const response = await fetch(`${state.apiUrl}${path}`, {
        headers: authorizationHeaders(),
        cache: "no-store",
      });
      if (!response.ok) {
        let message = `Download failed: HTTP ${response.status}`;
        try {
          const data = await response.json();
          message = data.detail || message;
        } catch {}
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = match?.[1] || filenameFallback;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      toast("Download failed", error.message, "error");
    }
  }

  function renderRegistrationResult(identity) {
    const uid = encodeURIComponent(identity.device_uid);
    elements.registrationResult.innerHTML = `<div class="identity-result"><p class="eyebrow">REGISTRATION COMPLETE</p><h3>${esc(identity.device_name)}</h3><div class="identity-fields"><div class="identity-field"><span>Device UID</span><strong>${esc(identity.device_uid)}</strong></div><div class="identity-field"><span>USB Name</span><strong>${esc(identity.device_name)}</strong></div><div class="identity-field"><span>Owner</span><strong>${esc(identity.owner)}</strong></div><div class="identity-field"><span>Login Username</span><strong>${esc(identity.login_username)}</strong></div></div><div class="form-note"><strong>Vault-only USB:</strong> Keep only <code>Open Secure USB.exe</code>, <code>usb_guardian.id</code>, and <code>secure_data.hc</code> in the pendrive root. Store every private file inside the encrypted vault. The owner is alerted when the registered pendrive is activated or the Guardian application is opened.</div><div class="result-actions"><button class="primary-button" id="downloadUsbMonitorInstallerResult" type="button">1. One-click monitor setup</button><button class="primary-button" id="downloadWindowsPackage" type="button">2. Windows USB package</button><button class="secondary-button" id="downloadRegisteredIdentity" type="button">usb_guardian.id</button><button class="secondary-button" id="downloadAndroidApp" type="button">Android app</button><button class="secondary-button" id="copyRegisteredIdentity" type="button">Copy JSON</button></div></div>`;
    $("#downloadUsbMonitorInstallerResult").addEventListener("click", () =>
      authenticatedDownload(
        "/downloads/usb-monitor-installer",
        "Smart_USB_Guardian_One_Click_Setup.zip",
      ),
    );
    $("#downloadWindowsPackage").addEventListener("click", () =>
      authenticatedDownload(
        `/device/${uid}/windows-package`,
        `${identity.device_name}_Windows_USB_Package.zip`,
      ),
    );
    $("#downloadRegisteredIdentity").addEventListener("click", () =>
      authenticatedDownload(`/device/${uid}/identity`, "usb_guardian.id"),
    );
    $("#downloadAndroidApp").addEventListener("click", () =>
      authenticatedDownload("/downloads/android-app", "USBGuardianMobile.apk"),
    );
    $("#copyRegisteredIdentity").addEventListener("click", async () => {
      await navigator.clipboard.writeText(JSON.stringify(identity, null, 2));
      toast("Identity copied", "usb_guardian.id JSON copied.", "success");
    });
  }

  async function registerDevice(event) {
    event.preventDefault();
    const password = $("#passwordInput").value;
    if (password !== $("#confirmPasswordInput").value) {
      toast("Passwords do not match", "Repeat the same USB password.", "error");
      return;
    }
    const payload = {
      device_name: $("#deviceNameInput").value.trim(),
      owner: $("#ownerInput").value.trim(),
      login_username: $("#usernameInput").value.trim(),
      password,
    };
    const button = $("#registerSubmitButton");
    button.disabled = true;
    button.textContent = "Registering…";
    try {
      const result = await api("/device/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const identity = identityFromRegistration(result, payload);
      renderRegistrationResult(identity);
      event.target.reset();
      $("#ownerInput").value = state.account?.name || "";
      await refreshAll(false);
      toast(
        "USB registered",
        `${identity.device_name} was assigned to your account.`,
        "success",
      );
    } catch (error) {
      toast("Registration failed", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Register USB";
    }
  }

  function showDevice(uid) {
    const device = state.devices.find((item) => item.device_uid === uid);
    if (!device) return;
    const connection = connectionFor(uid);
    state.selectedDevice = device;
    elements.modalDeviceTitle.textContent = device.device_name;
    const details = [
      ["Device UID", device.device_uid],
      ["USB Name", device.device_name],
      ["Owner", device.owner],
      ["Login Username", device.login_username],
      ["Registered At", formatDate(device.registered_at)],
      ["Connection", connection?.connection || "DISCONNECTED"],
      ["Last Seen", formatDate(connection?.last_seen || "-")],
      ["Host Device", connection?.host_device || "-"],
      ["Host User", connection?.host_user || "-"],
      ["Location", connection ? locationText(connection) : "-"],
    ];
    elements.modalDeviceDetails.innerHTML = details
      .map(
        ([label, value]) =>
          `<div class="detail-item"><span>${esc(label)}</span><strong>${label === "Connection" ? badge(value) : esc(value)}</strong></div>`,
      )
      .join("");
    elements.deviceModal.showModal();
  }

  async function deleteDevice(uid) {
    const device = state.devices.find((item) => item.device_uid === uid);
    if (
      !device ||
      !confirm(
        `Delete ${device.device_name}?\n\nThis also deletes all of its access logs and connection state.`,
      )
    )
      return;
    try {
      await api(`/devices/${encodeURIComponent(uid)}`, { method: "DELETE" });
      if (elements.deviceModal.open) elements.deviceModal.close();
      state.selectedDevice = null;
      await refreshAll(false);
      toast(
        "Device deleted",
        `${device.device_name} and its records were removed.`,
        "success",
      );
    } catch (error) {
      toast("Delete failed", error.message, "error");
    }
  }

  async function deleteSingleEvent(id) {
    if (!confirm(`Delete access-log record #${id}?`)) return;
    try {
      await api(`/events/${id}`, { method: "DELETE" });
      state.selectedEventIds.delete(id);
      await refreshAll(false);
      toast(
        "Record deleted",
        `Event #${id} was removed from secure records.`,
        "success",
      );
    } catch (error) {
      toast("Delete failed", error.message, "error");
    }
  }

  async function deleteSelectedEvents() {
    const ids = [...state.selectedEventIds];
    if (
      !ids.length ||
      !confirm(`Delete ${ids.length} selected access-log record(s)?`)
    )
      return;
    try {
      const result = await api("/events/delete-selected", {
        method: "POST",
        body: JSON.stringify({ event_ids: ids }),
      });
      state.selectedEventIds.clear();
      await refreshAll(false);
      toast("Records deleted", result.message, "success");
    } catch (error) {
      toast("Delete failed", error.message, "error");
    }
  }

  function exportCsv() {
    const rows = filteredEvents();
    if (!rows.length) {
      toast("Nothing to export", "No logs match the filters.", "error");
      return;
    }
    const headers = [
      "Device UID",
      "USB Name",
      "Owner",
      "Login Username",
      "Host User",
      "Host Device",
      "Platform",
      "Location",
      "Latitude",
      "Longitude",
      "Time",
      "Connection",
      "Access Status",
      "Tamper Status",
    ];
    const csv = [
      headers,
      ...rows.map((event) => [
        event.device_uid,
        event.device_name,
        event.owner,
        event.login_username,
        event.host_user,
        event.host_device,
        event.host_platform,
        locationText(event),
        event.location.latitude ?? "",
        event.location.longitude ?? "",
        event.time,
        eventConnectionForDisplay(event),
        accessStatusForDisplay(event),
        event.tamper_status || "OK",
      ]),
    ]
      .map((row) =>
        row
          .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = `smart-usb-guardian-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function showPage(pageName) {
    $$(".nav-item").forEach((item) =>
      item.classList.toggle("active", item.dataset.page === pageName),
    );
    $$(".page").forEach((page) =>
      page.classList.toggle("active", page.id === `page-${pageName}`),
    );
    elements.pageTitle.textContent =
      $(`#page-${pageName}`)?.dataset.title || "Smart USB Guardian";
    location.hash = pageName;
    elements.sidebar.classList.remove("open");
    elements.backdrop.classList.remove("show");
  }

  function startPollingUpdates() {
    // Netlify Functions are request-based. The former persistent WebSocket
    // channel is intentionally replaced with regular dashboard polling.
    setOnline(state.restOnline, Boolean(state.token));
  }

  function scheduleRefresh() {
    clearInterval(state.refreshTimer);
    if (state.autoRefresh && state.token)
      state.refreshTimer = setInterval(
        () => refreshAll(false),
        pollingIntervalMs,
      );
  }

  function scheduleConnectionClock() {
    clearInterval(state.statusTimer);
    state.statusTimer = setInterval(() => {
      if (!state.token || document.hidden) return;
      // Connection status can flip from CONNECTED to DISCONNECTED purely from
      // elapsed time (see effectiveConnectionStatus), so we still need to
      // poll — but rebuilding 4 tables via innerHTML every 3s regardless of
      // whether anything changed is expensive on mobile. Skip the rebuild
      // unless a status actually flipped.
      const signature = state.connections
        .map((item) => `${item.device_uid}:${effectiveConnectionStatus(item)}`)
        .join("|");
      if (signature === state.lastConnectionSignature) return;
      state.lastConnectionSignature = signature;
      renderMetrics();
      renderConnected();
      renderDevices();
      renderLogs();
    }, 3000);
  }

  // Pause polling/re-rendering entirely while the app is backgrounded
  // (screen off, switched tab/app on Android) — no point doing the work
  // when nothing is visible, and it avoids a backlog of work hitting the
  // main thread all at once when the user returns.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(state.refreshTimer);
      clearInterval(state.statusTimer);
    } else if (state.token) {
      scheduleRefresh();
      scheduleConnectionClock();
    }
  });

  async function saveSettings(event) {
    event.preventDefault();
    state.apiUrl = CONFIG.DEFAULT_API_URL || `${window.location.origin}/api`;
    state.autoRefresh = elements.autoRefreshInput.checked;
    state.activationNotifications = elements.activationNotificationsInput
      ? elements.activationNotificationsInput.checked
      : true;
    localStorage.removeItem("smartUsbApiUrl");
    localStorage.setItem("smartUsbAutoRefresh", String(state.autoRefresh));
    localStorage.setItem(
      "smartUsbActivationNotifications",
      String(state.activationNotifications),
    );
    if (elements.apiUrlInput) elements.apiUrlInput.value = state.apiUrl;
    scheduleRefresh();
    startPollingUpdates();
    await refreshAll(true);
  }

  function bindEvents() {
    $("#showLoginTab").addEventListener("click", () => toggleAuthTab("login"));
    $("#showSignupTab").addEventListener("click", () =>
      toggleAuthTab("signup"),
    );
    elements.loginForm.addEventListener("submit", loginAccount);
    elements.signupForm.addEventListener("submit", signupAccount);
    $$("[data-toggle-password]").forEach((button) =>
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.togglePassword);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.textContent = show ? "Hide" : "Show";
      }),
    );
    $$(".nav-item").forEach((button) =>
      button.addEventListener("click", () => showPage(button.dataset.page)),
    );
    $$("[data-go]").forEach((button) =>
      button.addEventListener("click", () => showPage(button.dataset.go)),
    );
    $("#menuButton").addEventListener("click", () => {
      elements.sidebar.classList.add("open");
      elements.backdrop.classList.add("show");
    });
    elements.backdrop.addEventListener("click", () => {
      elements.sidebar.classList.remove("open");
      elements.backdrop.classList.remove("show");
    });
    $("#refreshButton").addEventListener("click", () => refreshAll(true));
    $("#registrationForm").addEventListener("submit", registerDevice);
    $("#deviceSearch").addEventListener("input", renderDevices);
    $("#deviceStatusFilter").addEventListener("change", renderDevices);
    [
      "#logSearch",
      "#accessFilter",
      "#platformFilter",
      "#connectionFilter",
    ].forEach((selector) => $(selector).addEventListener("input", renderLogs));
    $("#trendRange").addEventListener("change", renderChart);
    $("#exportCsvButton").addEventListener("click", exportCsv);
    $("#deleteSelectedEventsButton").addEventListener(
      "click",
      deleteSelectedEvents,
    );
    $("#selectAllEvents").addEventListener("change", (event) => {
      filteredEvents().forEach((item) =>
        event.target.checked
          ? state.selectedEventIds.add(item.id)
          : state.selectedEventIds.delete(item.id),
      );
      renderLogs();
    });
    elements.logsBody.addEventListener("change", (event) => {
      const box = event.target.closest(".event-checkbox");
      if (!box) return;
      const id = Number(box.dataset.eventId);
      box.checked
        ? state.selectedEventIds.add(id)
        : state.selectedEventIds.delete(id);
      updateDeleteSelectionButton();
    });
    elements.logsBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-event-id]");
      if (button) deleteSingleEvent(Number(button.dataset.deleteEventId));
    });
    elements.devicesBody.addEventListener("click", (event) => {
      const details = event.target.closest("[data-device-uid]");
      const remove = event.target.closest("[data-delete-device-uid]");
      if (details) showDevice(details.dataset.deviceUid);
      if (remove) deleteDevice(remove.dataset.deleteDeviceUid);
    });
    $("#settingsForm").addEventListener("submit", saveSettings);
    elements.enableBrowserNotificationsButton?.addEventListener(
      "click",
      requestBrowserNotifications,
    );
    $("#testConnectionButton")?.addEventListener("click", () =>
      refreshAll(true),
    );
    $("#downloadUsbMonitorInstallerButton")?.addEventListener("click", () =>
      authenticatedDownload(
        "/downloads/usb-monitor-installer",
        "Smart_USB_Guardian_One_Click_Setup.zip",
      ),
    );
    $("#downloadUsbMonitorExeButton")?.addEventListener("click", () =>
      authenticatedDownload("/downloads/usb-monitor", "USBMonitor.exe"),
    );
    $("#logoutButton").addEventListener("click", logoutAccount);
    $("#openDeleteAccountButton").addEventListener("click", () => {
      $("#deleteAccountForm").reset();
      elements.deleteAccountModal.showModal();
    });
    $("#closeDeleteAccountModal").addEventListener("click", () =>
      elements.deleteAccountModal.close(),
    );
    $("#cancelDeleteAccountButton").addEventListener("click", () =>
      elements.deleteAccountModal.close(),
    );
    $("#deleteAccountForm").addEventListener("submit", deleteAccount);
    $("#closeDeviceModal").addEventListener("click", () =>
      elements.deviceModal.close(),
    );
    $("#deleteDeviceButton").addEventListener(
      "click",
      () =>
        state.selectedDevice && deleteDevice(state.selectedDevice.device_uid),
    );
    $("#downloadDeviceWindowsPackage").addEventListener(
      "click",
      () =>
        state.selectedDevice &&
        authenticatedDownload(
          `/device/${encodeURIComponent(state.selectedDevice.device_uid)}/windows-package`,
          `${state.selectedDevice.device_name}_Windows_USB_Package.zip`,
        ),
    );
    $("#downloadIdentityButton").addEventListener(
      "click",
      () =>
        state.selectedDevice &&
        authenticatedDownload(
          `/device/${encodeURIComponent(state.selectedDevice.device_uid)}/identity`,
          "usb_guardian.id",
        ),
    );
    $("#copyIdentityButton").addEventListener("click", async () => {
      if (!state.selectedDevice) return;
      const identity = {
        device_uid: state.selectedDevice.device_uid,
        device_name: state.selectedDevice.device_name,
        owner: state.selectedDevice.owner,
        login_username: state.selectedDevice.login_username,
      };
      await navigator.clipboard.writeText(JSON.stringify(identity, null, 2));
      toast("Identity copied", "Device identity copied.", "success");
    });
  }

  async function startAuthenticatedApp() {
    showApp();
    renderAccount();
    const initialPage = location.hash.replace("#", "") || "dashboard";
    showPage($(`#page-${initialPage}`) ? initialPage : "dashboard");
    scheduleRefresh();
    scheduleConnectionClock();
    startPollingUpdates();
    await refreshAll(false);
  }

  async function init() {
    localStorage.removeItem("smartUsbApiUrl");
    bindEvents();
    if (elements.apiUrlInput) elements.apiUrlInput.value = state.apiUrl;
    elements.autoRefreshInput.checked = state.autoRefresh;
    if (elements.activationNotificationsInput)
      elements.activationNotificationsInput.checked = state.activationNotifications;
    updateNotificationPermissionStatus();
    if (await authenticateExistingSession()) await startAuthenticatedApp();
    else showAuth("login");
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker
        .register("/service-worker.js", { updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch(() => {});
    }
  }

  init();
})();
