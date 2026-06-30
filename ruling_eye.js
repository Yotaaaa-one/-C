(() => {
  "use strict";

  const STORAGE_KEYS = {
    officers: "rulingEyeOfficers",
    tournaments: "rulingEyeTournaments",
    loginSessions: "rulingEyeLoginSessions",
  };

  const CATEGORY_OPTIONS = [
    { value: "specialist", label: "専門" },
    { value: "semiSpecialist", label: "準専門" },
    { value: "registered", label: "登録" },
    { value: "trainee", label: "見習い" },
  ];

  const ROLE_LABELS = {
    hq: "大会本部",
    headquarters: "大会本部",
    chief: "競技委員長",
    officer: "競技委員",
  };

  const app = document.getElementById("app");

  const dataCache = {
    officers: [],
    tournaments: [],
    loginSessions: [],
    assignmentsByTournament: new Map(),
  };

  let db = null;
  let firestoreReady = false;

  const state = {
    route: "home",
    params: {},
    stack: [],
    rosterFilters: {
      category: "all",
      active: "active",
      query: "",
    },
    rosterSort: {
      key: "officerKana",
      direction: "asc",
    },
    tournamentDraft: null,
    loginDraft: null,
    lastLoadedAt: null,
    lastAutoUpdatedAt: null,
    autoRefreshEnabled: true,
    watchedTournamentId: null,
    snapshotUnsubscribes: [],
    pendingExternalUpdate: false,
    operationBusy: false,
    globalMessage: null,
  };

  if (!app) {
    return;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function readLocalArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.warn(`localStorage read failed: ${key}`, error);
      return [];
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeDateValue(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (typeof value.seconds === "number") return new Date(value.seconds * 1000).toISOString();
    return String(value);
  }

  function firestoreErrorMessage(error) {
    const detail = error?.message || String(error || "");
    const permissionHint = /permission|PERMISSION_DENIED|Missing or insufficient permissions/i.test(detail)
      ? "\nFirestoreルールで読み書きが許可されていない可能性があります。"
      : "";
    return `${detail}${permissionHint}`;
  }

  function readFirebaseConfig() {
    return window.CAMERA_FIREBASE_CONFIG || window.FIREBASE_CONFIG || window.__firebase_config || window.firebaseConfig ||
      (typeof firebaseConfig !== "undefined" ? firebaseConfig : null);
  }

  function createFirestore() {
    if (!window.firebase) {
      throw new Error("Firebase SDKを読み込めませんでした。ネットワーク接続を確認してください。");
    }
    const config = readFirebaseConfig();
    if (!config && !firebase.apps.length) {
      throw new Error("Firebase設定が見つかりません。firebase-config.js を確認してください。");
    }
    if (!firebase.apps.length) firebase.initializeApp(config);
    return firebase.firestore();
  }

  function rosterRef(officerId) {
    return db.collection("camera_roster").doc(officerId);
  }

  function tournamentSettingsRef(tournamentId) {
    return db.collection("tournaments").doc(tournamentId).collection("ruling_eye_settings").doc("main");
  }

  function assignmentRef(tournamentId, assignmentId) {
    return db.collection("tournaments").doc(tournamentId).collection("camera_assignments").doc(assignmentId);
  }

  function assignmentCollectionRef(tournamentId) {
    return db.collection("tournaments").doc(tournamentId).collection("camera_assignments");
  }

  function loginSessionCollectionRef(tournamentId) {
    return db.collection("tournaments").doc(tournamentId).collection("ruling_eye_login_sessions");
  }

  function loginSessionRef(tournamentId, sessionId) {
    return db.collection("tournaments").doc(tournamentId).collection("ruling_eye_login_sessions").doc(sessionId);
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function parseTournamentId(tournamentId) {
    const match = String(tournamentId || "").trim().match(/^(\d{4})_(\d+)$/);
    if (!match) return null;
    const sequenceNo = Number(match[2]);
    if (!Number.isInteger(sequenceNo) || sequenceNo < 1) return null;
    return {
      year: match[1],
      sequenceNo,
    };
  }

  function formatTournamentId(year, sequenceNo) {
    const normalizedYear = String(year || "").trim();
    const normalizedSequence = Number(sequenceNo);
    if (!/^\d{4}$/.test(normalizedYear)) {
      throw new Error("大会年度は4桁で指定してください。");
    }
    if (!Number.isInteger(normalizedSequence) || normalizedSequence < 1) {
      throw new Error("大会連番を発行できませんでした。");
    }
    return `${normalizedYear}_${String(normalizedSequence).padStart(2, "0")}`;
  }

  function nextTournamentSequenceFromRecords(year, records) {
    const targetYear = String(year || "").trim();
    let maximum = 0;
    (records || []).forEach((record) => {
      const recordYear = String(record?.year || "").trim();
      const storedSequence = Number(record?.sequenceNo);
      if (recordYear === targetYear && Number.isInteger(storedSequence) && storedSequence > 0) {
        maximum = Math.max(maximum, storedSequence);
      }
      const parsedId = parseTournamentId(record?.tournamentId);
      if (parsedId?.year === targetYear) {
        maximum = Math.max(maximum, parsedId.sequenceNo);
      }
    });
    return maximum + 1;
  }

  function tournamentIdFromSettingsDoc(doc) {
    return doc?.ref?.parent?.parent?.id || doc?.data?.()?.tournamentId || "";
  }

  async function getNextTournamentSequence(year) {
    const snapshot = await db.collectionGroup("ruling_eye_settings").get();
    const records = snapshot.docs
      .filter((doc) => doc.id === "main")
      .map((doc) => ({
        ...doc.data(),
        tournamentId: tournamentIdFromSettingsDoc(doc),
      }));
    return nextTournamentSequenceFromRecords(year, records);
  }

  async function generateTournamentId(year) {
    let sequenceNo = await getNextTournamentSequence(year);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const tournamentId = formatTournamentId(year, sequenceNo);
      const existing = await tournamentSettingsRef(tournamentId).get();
      if (!existing.exists) {
        return { tournamentId, sequenceNo };
      }
      sequenceNo += 1;
    }
    throw new Error("大会IDの自動発行に失敗しました。もう一度お試しください。");
  }

  function tournamentDisplayName(tournament) {
    return String(tournament?.tournamentName || tournament?.tournamentId || "名称未登録");
  }

  function tournamentSequenceLabel(tournament) {
    const sequenceNo = Number(tournament?.sequenceNo);
    return Number.isInteger(sequenceNo) && sequenceNo > 0
      ? String(sequenceNo).padStart(2, "0")
      : "旧形式";
  }

  function tournamentOptionLabel(tournament) {
    const name = tournamentDisplayName(tournament);
    const legacySuffix = tournament.isLegacyId ? "（旧形式ID）" : "";
    return `${tournament.year || "-"} / ${tournamentSequenceLabel(tournament)} / ${tournament.tournamentId} / ${name}${legacySuffix}`;
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDateTimeWithSeconds(value) {
    if (!value) return "未読込";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未読込";
    return date.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function shortFirestoreError(action, error) {
    const detail = error?.message || String(error || "");
    const lines = [`${action}に失敗しました。`, "通信状況を確認してください。", "もう一度「最新データを取得」を押してください。"];
    if (/permission|PERMISSION_DENIED|Missing or insufficient permissions/i.test(detail)) {
      lines.splice(1, 0, "Firestoreルールで読み書きが許可されていない可能性があります。");
    }
    return lines.join("\n");
  }

  function setControlsDisabled(disabled) {
    app.querySelectorAll("button, input, select, textarea").forEach((element) => {
      element.disabled = disabled;
    });
  }

  function dataSummary() {
    const sessions = readLoginSessions();
    return {
      officers: readOfficers().length,
      tournaments: readTournaments().length,
      activeLogins: sessions.filter((session) => session.status !== "ended").length,
      endedLogins: sessions.filter((session) => session.status === "ended").length,
    };
  }

  function sortTournaments(tournaments) {
    return [...tournaments].sort((a, b) => {
      const yearDiff = String(b.year || "").localeCompare(String(a.year || ""), "ja", { numeric: true });
      if (yearDiff) return yearDiff;
      const createdDiff = String(a.createdAt || "").localeCompare(String(b.createdAt || ""), "ja", { numeric: true });
      if (createdDiff) return createdDiff;
      return tournamentDisplayName(a).localeCompare(tournamentDisplayName(b), "ja", { numeric: true, sensitivity: "base" });
    });
  }

  function statusDashboardHtml() {
    const summary = dataSummary();
    return `
      <div class="status-dashboard">
        <div class="status-tile"><span>最終読込</span><strong>${escapeHtml(formatDateTimeWithSeconds(state.lastLoadedAt))}</strong></div>
        <div class="status-tile"><span>ロースター</span><strong>${summary.officers}件</strong></div>
        <div class="status-tile"><span>大会設定</span><strong>${summary.tournaments}件</strong></div>
        <div class="status-tile"><span>activeログイン</span><strong>${summary.activeLogins}件</strong></div>
        <div class="status-tile"><span>endedログイン</span><strong>${summary.endedLogins}件</strong></div>
        <button id="refreshFirestoreButton" class="secondary-button refresh-button" type="button">最新データを取得</button>
      </div>
      ${state.globalMessage ? `<div id="globalMessage" class="status-message ${escapeHtml(state.globalMessage.type || "")}">${escapeHtml(state.globalMessage.message)}</div>` : ""}
    `;
  }

  function isLoginRoute(route = state.route) {
    return ["loginStep1", "loginRole", "loginOfficerSelect", "loginPhoneSelect", "loginComplete"].includes(route);
  }

  function activeInputIsBeingEdited() {
    const element = document.activeElement;
    if (!element || !app.contains(element)) return false;
    return ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName);
  }

  function currentRouteTournamentId() {
    if (state.route === "loginStep1") return state.params.tournamentId || state.watchedTournamentId || "";
    if (state.route === "loginComplete") {
      const sessionId = state.params.sessionId || "";
      const session = readLoginSessions().find((item) => item.sessionId === sessionId);
      return session?.tournamentId || state.loginDraft?.tournamentId || state.watchedTournamentId || "";
    }
    return state.loginDraft?.tournamentId || state.watchedTournamentId || "";
  }

  function autoRefreshPanelHtml(tournamentId) {
    if (!tournamentId) return "";
    const isWatching = state.autoRefreshEnabled && state.watchedTournamentId === tournamentId && state.snapshotUnsubscribes.length > 0;
    const statusText = state.autoRefreshEnabled ? (isWatching ? "自動更新中" : "自動更新待機中") : "自動更新OFF";
    const statusClass = state.autoRefreshEnabled ? "on" : "off";
    return `
      <div class="auto-refresh-panel ${statusClass}">
        <div>
          <span class="auto-refresh-kicker">Firestore自動更新</span>
          <strong id="autoRefreshStatusText">${escapeHtml(statusText)}</strong>
          <p id="autoRefreshTimeText">最終自動更新: ${escapeHtml(formatDateTimeWithSeconds(state.lastAutoUpdatedAt))}</p>
        </div>
        <button id="toggleAutoRefreshButton" class="${state.autoRefreshEnabled ? "secondary-button" : "primary-button"}" type="button">
          ${state.autoRefreshEnabled ? "自動更新 ON" : "自動更新 OFF"}
        </button>
      </div>
      ${
        state.pendingExternalUpdate
          ? `<div class="status-message warning auto-refresh-notice">別端末で更新がありました。編集中の入力値は自動では上書きしていません。必要に応じて「最新データを取得」を押してください。</div>`
          : ""
      }
    `;
  }

  function updateAutoRefreshDom() {
    const statusText = document.getElementById("autoRefreshStatusText");
    const timeText = document.getElementById("autoRefreshTimeText");
    if (statusText) {
      const isWatching = state.autoRefreshEnabled && state.snapshotUnsubscribes.length > 0;
      statusText.textContent = state.autoRefreshEnabled ? (isWatching ? "自動更新中" : "自動更新待機中") : "自動更新OFF";
    }
    if (timeText) {
      timeText.textContent = `最終自動更新: ${formatDateTimeWithSeconds(state.lastAutoUpdatedAt)}`;
    }
  }

  function unsubscribeAutoRefresh() {
    state.snapshotUnsubscribes.forEach((unsubscribe) => {
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (error) {
        console.warn("Firestore auto refresh unsubscribe failed", error);
      }
    });
    state.snapshotUnsubscribes = [];
    state.watchedTournamentId = null;
  }

  function upsertTournamentFromSnapshot(tournamentId, data) {
    const normalized = normalizeTournament({ ...data, tournamentId });
    const index = dataCache.tournaments.findIndex((tournament) => tournament.tournamentId === normalized.tournamentId);
    if (index >= 0) {
      dataCache.tournaments[index] = normalized;
    } else {
      dataCache.tournaments.push(normalized);
    }
  }

  function replaceTournamentSessionsFromSnapshot(tournamentId, snapshot) {
    const nextSessions = snapshot.docs.map((doc) => normalizeLoginSession({ tournamentId, sessionId: doc.id, ...doc.data() }));
    dataCache.loginSessions = [
      ...dataCache.loginSessions.filter((session) => session.tournamentId !== tournamentId),
      ...nextSessions,
    ];
  }

  function replaceTournamentAssignmentsFromSnapshot(tournamentId, snapshot) {
    dataCache.assignmentsByTournament.set(
      tournamentId,
      snapshot.docs.map((doc) => ({ assignmentId: doc.id, tournamentId, ...doc.data() })),
    );
  }

  function handleAutoSnapshot(tournamentId) {
    const updatedAt = nowIso();
    state.lastAutoUpdatedAt = updatedAt;
    state.lastLoadedAt = updatedAt;

    if (activeInputIsBeingEdited()) {
      state.pendingExternalUpdate = true;
      state.globalMessage = {
        type: "warning",
        message: "別端末で更新がありました。編集中の入力値は自動では上書きしていません。必要に応じて「最新データを取得」を押してください。",
      };
      updateAutoRefreshDom();
      const message = document.getElementById("globalMessage");
      if (message) {
        message.className = "status-message warning";
        message.textContent = state.globalMessage.message;
      }
      return;
    }

    state.pendingExternalUpdate = false;
    state.globalMessage = { type: "success", message: "自動更新で最新データを反映しました。" };
    if (isLoginRoute() && currentRouteTournamentId() === tournamentId) {
      render();
    } else {
      updateAutoRefreshDom();
    }
  }

  function handleAutoSnapshotError(error) {
    console.error("Firestore auto refresh failed", error);
    state.globalMessage = {
      type: "error",
      message: shortFirestoreError("Firestore自動更新", error),
    };
    setStatus(state.globalMessage.message, "error", firestoreErrorMessage(error));
  }

  function startAutoRefreshForTournament(tournamentId) {
    if (!state.autoRefreshEnabled || !firestoreReady || !db || !tournamentId) {
      unsubscribeAutoRefresh();
      updateAutoRefreshDom();
      return;
    }
    if (state.watchedTournamentId === tournamentId && state.snapshotUnsubscribes.length > 0) {
      updateAutoRefreshDom();
      return;
    }

    unsubscribeAutoRefresh();
    state.watchedTournamentId = tournamentId;
    state.snapshotUnsubscribes = [
      tournamentSettingsRef(tournamentId).onSnapshot(
        (doc) => {
          if (doc.exists) upsertTournamentFromSnapshot(tournamentId, doc.data());
          handleAutoSnapshot(tournamentId);
        },
        handleAutoSnapshotError,
      ),
      assignmentCollectionRef(tournamentId).onSnapshot(
        (snapshot) => {
          replaceTournamentAssignmentsFromSnapshot(tournamentId, snapshot);
          handleAutoSnapshot(tournamentId);
        },
        handleAutoSnapshotError,
      ),
      loginSessionCollectionRef(tournamentId).onSnapshot(
        (snapshot) => {
          replaceTournamentSessionsFromSnapshot(tournamentId, snapshot);
          handleAutoSnapshot(tournamentId);
        },
        handleAutoSnapshotError,
      ),
    ];
    updateAutoRefreshDom();
  }

  function syncAutoRefreshForLoginTournament(tournamentId) {
    if (!isLoginRoute() || !tournamentId || !state.autoRefreshEnabled) {
      unsubscribeAutoRefresh();
      updateAutoRefreshDom();
      return;
    }
    startAutoRefreshForTournament(tournamentId);
  }

  function bindAutoRefreshToggle(tournamentId) {
    on("toggleAutoRefreshButton", "click", () => {
      state.autoRefreshEnabled = !state.autoRefreshEnabled;
      state.pendingExternalUpdate = false;
      state.globalMessage = state.autoRefreshEnabled
        ? { type: "success", message: "自動更新をONにしました。" }
        : { type: "warning", message: "自動更新をOFFにしました。必要な場合は「最新データを取得」で手動更新してください。" };
      if (state.autoRefreshEnabled) {
        startAutoRefreshForTournament(tournamentId);
      } else {
        unsubscribeAutoRefresh();
      }
      render();
    });
  }

  function readOfficers() {
    return dataCache.officers.map(normalizeOfficer);
  }

  async function saveOfficers(officers) {
    const normalized = officers.map(normalizeOfficer);
    const batch = db.batch();
    normalized.forEach((officer) => batch.set(rosterRef(officer.officerId), toFirestoreOfficer(officer), { merge: true }));
    await batch.commit();
    dataCache.officers = normalized;
    state.lastLoadedAt = nowIso();
  }

  function readTournaments({ includeDeleted = false } = {}) {
    const tournaments = dataCache.tournaments.map(normalizeTournament);
    return includeDeleted ? tournaments : tournaments.filter((tournament) => tournament.deleted !== true);
  }

  async function saveTournaments(tournaments) {
    const normalized = tournaments.map(normalizeTournament);
    const batch = db.batch();
    normalized.forEach((tournament) => batch.set(tournamentSettingsRef(tournament.tournamentId), toFirestoreTournament(tournament), { merge: true }));
    await batch.commit();
    dataCache.tournaments = normalized;
    state.lastLoadedAt = nowIso();
  }

  function readLoginSessions() {
    return dataCache.loginSessions.map(normalizeLoginSession);
  }

  async function saveLoginSessions(sessions) {
    const normalized = sessions.map(normalizeLoginSession);
    const batch = db.batch();
    normalized.forEach((session) => batch.set(loginSessionRef(session.tournamentId, session.sessionId), toFirestoreLoginSession(session), { merge: true }));
    await batch.commit();
    dataCache.loginSessions = normalized;
    state.lastLoadedAt = nowIso();
  }

  function categoryLabel(value) {
    return CATEGORY_OPTIONS.find((option) => option.value === value)?.label || value || "-";
  }

  function categoriesLabel(categories) {
    const normalized = normalizeCategories(categories);
    return normalized.length ? normalized.map(categoryLabel).join("・") : "-";
  }

  function normalizeCategory(value) {
    const normalized = String(value || "").trim();
    const lower = normalized.toLowerCase();
    const map = {
      specialist: "specialist",
      "専門": "specialist",
      "専門競技委員": "specialist",
      semispecialist: "semiSpecialist",
      "semi-specialist": "semiSpecialist",
      "semi_specialist": "semiSpecialist",
      "準専門": "semiSpecialist",
      "準専門競技委員": "semiSpecialist",
      registered: "registered",
      "登録": "registered",
      "登録競技委員": "registered",
      trainee: "trainee",
      "見習い": "trainee",
      "見習": "trainee",
    };
    return map[lower] || map[normalized] || "";
  }

  function normalizeCategories(value) {
    const source = Array.isArray(value) ? value : String(value || "").split("|");
    const result = [];
    source.forEach((item) => {
      const normalized = normalizeCategory(item);
      if (normalized && !result.includes(normalized)) result.push(normalized);
    });
    return result;
  }

  function activeLabel(active) {
    return active ? "有効" : "無効";
  }

  function normalizeActive(value, defaultValue = true) {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "active", "有効"].includes(normalized)) return true;
    if (["false", "0", "inactive", "無効", "停止"].includes(normalized)) return false;
    return defaultValue;
  }

  function normalizeOfficer(officer) {
    const categories = normalizeCategories(
      Array.isArray(officer.categories) && officer.categories.length ? officer.categories : officer.category || "",
    );
    const officerName = officer.officerName || officer.name || "";
    const officerKana = officer.officerKana || officer.kana || "";
    const category = categories[0] || officer.category || "";
    return {
      officerId: officer.officerId || makeId("officer"),
      officerName,
      officerKana,
      memberNo: officer.memberNo || "",
      categories,
      category,
      categoryLabel: categoriesLabel(categories),
      active: normalizeActive(officer.active, true),
      note: officer.note || "",
      createdAt: normalizeDateValue(officer.createdAt) || nowIso(),
      updatedAt: normalizeDateValue(officer.updatedAt) || nowIso(),
      name: officerName,
      kana: officerKana,
    };
  }

  function normalizeTournamentRecord(tournament = {}) {
    const tournamentId = String(tournament.tournamentId || makeId("tournament")).trim();
    const parsedId = parseTournamentId(tournamentId);
    const year = String(tournament.year || parsedId?.year || new Date().getFullYear());
    const storedSequence = Number(tournament.sequenceNo);
    const sequenceNo = Number.isInteger(storedSequence) && storedSequence > 0
      ? storedSequence
      : parsedId?.sequenceNo || null;
    const standardId = parsedId && parsedId.year === year && tournamentId === formatTournamentId(parsedId.year, parsedId.sequenceNo);
    return {
      tournamentId,
      year,
      sequenceNo,
      tournamentName: tournament.tournamentName || tournament.name || tournamentId,
      isLegacyId: !standardId,
      officerCount: Number(tournament.officerCount || 5),
      chiefOfficerId: tournament.chiefOfficerId || "",
      chiefOfficerName: tournament.chiefOfficerName || "",
      selectedOfficerIds: Array.isArray(tournament.selectedOfficerIds) ? tournament.selectedOfficerIds : [],
      selectedOfficers: Array.isArray(tournament.selectedOfficers)
        ? tournament.selectedOfficers.map((officer) => ({
            officerId: officer.officerId,
            name: officer.name || officer.officerName || "",
            officerName: officer.officerName || officer.name || "",
            category: officer.category || "",
            categories: normalizeCategories(officer.categories || officer.category || ""),
            categoryLabel: officer.categoryLabel || categoriesLabel(officer.categories || officer.category || ""),
          }))
        : [],
      active: tournament.active !== false,
      deleted: tournament.deleted === true,
      deletedAt: normalizeDateValue(tournament.deletedAt),
      createdAt: normalizeDateValue(tournament.createdAt) || nowIso(),
      updatedAt: normalizeDateValue(tournament.updatedAt) || nowIso(),
    };
  }

  function normalizeTournament(tournament) {
    return normalizeTournamentRecord(tournament);
  }

  function normalizeLoginSession(session) {
    const role = session.loginRole || (session.role === "headquarters" ? "hq" : session.role || "");
    const deviceNo = session.deviceNo ?? (session.iphoneNo === null || session.iphoneNo === undefined ? null : String(session.iphoneNo));
    const status = session.status || (session.endedAt ? "ended" : "active");
    return {
      sessionId: session.sessionId || makeId("login"),
      tournamentId: session.tournamentId || "",
      tournamentName: session.tournamentName || "",
      loginRole: role,
      role: role,
      roleLabel: session.roleLabel || ROLE_LABELS[role] || role,
      officerId: session.officerId || null,
      officerName: session.officerName || "",
      deviceNo,
      iphoneNo: deviceNo ? Number(deviceNo) : null,
      status,
      loginAt: normalizeDateValue(session.loginAt) || nowIso(),
      endedAt: normalizeDateValue(session.endedAt),
      updatedAt: normalizeDateValue(session.updatedAt) || normalizeDateValue(session.loginAt) || nowIso(),
    };
  }

  function toFirestoreOfficer(officer) {
    const normalized = normalizeOfficer(officer);
    return {
      officerId: normalized.officerId,
      officerName: normalized.officerName,
      officerKana: normalized.officerKana,
      memberNo: normalized.memberNo,
      categories: normalized.categories,
      active: normalized.active,
      note: normalized.note,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    };
  }

  function toFirestoreTournament(tournament) {
    const normalized = normalizeTournament(tournament);
    return {
      tournamentId: normalized.tournamentId,
      year: normalized.year,
      sequenceNo: normalized.sequenceNo,
      tournamentName: normalized.tournamentName,
      officerCount: normalized.officerCount,
      chiefOfficerId: normalized.chiefOfficerId,
      chiefOfficerName: normalized.chiefOfficerName,
      chiefOfficerIsOther: normalized.chiefOfficerId === "other",
      selectedOfficerIds: normalized.selectedOfficerIds,
      selectedOfficers: normalized.selectedOfficers,
      deleted: normalized.deleted,
      deletedAt: normalized.deletedAt,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
    };
  }

  function toFirestoreLoginSession(session) {
    const normalized = normalizeLoginSession(session);
    return {
      sessionId: normalized.sessionId,
      tournamentId: normalized.tournamentId,
      tournamentName: normalized.tournamentName,
      loginRole: normalized.loginRole,
      roleLabel: normalized.roleLabel,
      officerId: normalized.officerId,
      officerName: normalized.officerName,
      deviceNo: normalized.deviceNo,
      deviceType: normalized.loginRole === "hq" ? "pc_or_ipad" : "iphone",
      status: normalized.status,
      loginAt: normalized.loginAt,
      endedAt: normalized.endedAt,
      updatedAt: normalized.updatedAt,
    };
  }

  function toFirestoreAssignment(tournament, officer, index = 0) {
    const normalizedOfficer = normalizeOfficer(officer);
    const isChief = tournament.chiefOfficerId !== "other" && normalizedOfficer.officerId === tournament.chiefOfficerId;
    const assignmentId = normalizedOfficer.officerId;
    const existingSession = activeLoginSessions(tournament.tournamentId).find((session) => session.officerId === normalizedOfficer.officerId);
    return {
      assignmentId,
      tournamentId: tournament.tournamentId,
      officerId: normalizedOfficer.officerId,
      officerName: normalizedOfficer.officerName,
      officerKana: normalizedOfficer.officerKana,
      memberNo: normalizedOfficer.memberNo,
      categories: normalizedOfficer.categories,
      categoryLabels: normalizedOfficer.categories.map(categoryLabel),
      deviceNo: isChief ? "1" : existingSession?.deviceNo || null,
      deviceId: null,
      status: existingSession?.status === "active" ? "online" : "assigned",
      currentSessionId: existingSession?.sessionId || null,
      qualityMode: "standard",
      qualityLabel: "標準",
      lastSeen: existingSession?.updatedAt || null,
      sortOrder: index,
      createdAt: tournament.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
  }

  async function updateAssignmentFromSession(session) {
    if (!session?.tournamentId || !session?.officerId) return;
    const tournament = getTournamentById(session.tournamentId, { includeDeleted: true });
    const officer = getOfficerById(session.officerId);
    if (!tournament || !officer) return;
    const assignment = toFirestoreAssignment(tournament, officer);
    await assignmentRef(session.tournamentId, assignment.assignmentId).set(assignment, { merge: true });
  }

  function getOfficerById(officerId) {
    return readOfficers().find((officer) => officer.officerId === officerId) || null;
  }

  function getTournamentById(tournamentId, { includeDeleted = false } = {}) {
    return readTournaments({ includeDeleted }).find((tournament) => tournament.tournamentId === tournamentId) || null;
  }

  function getActiveOfficers() {
    return readOfficers().filter((officer) => officer.active);
  }

  function activeLoginSessions(tournamentId) {
    return readLoginSessions().filter((session) => session.tournamentId === tournamentId && session.status !== "ended");
  }

  async function endSession(sessionId) {
    const sessions = readLoginSessions();
    const now = nowIso();
    const updated = sessions.map((session) =>
      session.sessionId === sessionId
        ? { ...session, status: "ended", endedAt: now, updatedAt: now }
        : session,
    );
    await saveLoginSessions(updated);
    const ended = updated.find((session) => session.sessionId === sessionId);
    if (ended?.officerId) await updateAssignmentFromSession(ended);
  }

  async function endAllSessions(tournamentId) {
    const now = nowIso();
    const updated = readLoginSessions().map((session) =>
      session.tournamentId === tournamentId && session.status !== "ended"
        ? { ...session, status: "ended", endedAt: now, updatedAt: now }
        : session,
    );
    await saveLoginSessions(updated);
    const tournament = getTournamentById(tournamentId, { includeDeleted: true });
    if (tournament) await saveAssignmentsForTournament(tournament);
  }

  function getYearOptions() {
    const current = new Date().getFullYear();
    const years = new Set([current - 1, current, current + 1, current + 2]);
    readTournaments().forEach((tournament) => {
      if (tournament.year) years.add(Number(tournament.year));
    });
    return Array.from(years)
      .filter((year) => Number.isFinite(year))
      .sort((a, b) => a - b)
      .map(String);
  }

  function optionsHtml(options, selectedValue, placeholder = "") {
    const placeholderHtml = placeholder
      ? `<option value="">${escapeHtml(placeholder)}</option>`
      : "";
    return `${placeholderHtml}${options
      .map((option) => {
        const value = typeof option === "string" ? option : option.value;
        const label = typeof option === "string" ? option : option.label;
        const selected = String(value) === String(selectedValue) ? " selected" : "";
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join("")}`;
  }

  function setStatus(message, type = "", detail = "") {
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.className = `status-message ${type}`.trim();
    if (detail) {
      el.innerHTML = `${escapeHtml(message || "").replaceAll("\n", "<br>")}<details class="error-detail"><summary>詳細表示</summary><pre>${escapeHtml(detail)}</pre></details>`;
    } else {
      el.textContent = message || "";
    }
  }

  function setCsvResult(message, type = "") {
    const el = document.getElementById("csvResult");
    if (!el) return;
    el.className = `csv-result ${type}`.trim();
    el.textContent = message || "";
  }

  async function runOperation(options, task) {
    const {
      workingMessage = "処理中です…",
      successMessage = "",
      actionName = "処理",
      rerender = false,
    } = options || {};
    if (state.operationBusy) return null;
    state.operationBusy = true;
    setControlsDisabled(true);
    setStatus(workingMessage, "warning");
    try {
      const result = await task();
      if (successMessage) {
        state.globalMessage = { type: "success", message: successMessage };
        setStatus(successMessage, "success");
      }
      if (rerender) render();
      return result;
    } catch (error) {
      console.error(`${actionName} failed`, error);
      const message = shortFirestoreError(actionName, error);
      state.globalMessage = { type: "error", message };
      setStatus(message, "error", firestoreErrorMessage(error));
      return null;
    } finally {
      state.operationBusy = false;
      setControlsDisabled(false);
    }
  }

  function getValue(id) {
    return document.getElementById(id)?.value.trim() || "";
  }

  function getSelectValue(id) {
    return document.getElementById(id)?.value || "";
  }

  function checkedValues(name) {
    return Array.from(app.querySelectorAll(`input[name="${name}"]:checked`)).map((input) => input.value);
  }

  function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  }

  function onAll(selector, event, handler) {
    app.querySelectorAll(selector).forEach((el) => el.addEventListener(event, handler));
  }

  function navigate(route, params = {}, push = true) {
    if (push && state.route) {
      state.stack.push({ route: state.route, params: state.params });
    }
    if (isLoginRoute(state.route) && !isLoginRoute(route)) {
      unsubscribeAutoRefresh();
    }
    state.route = route;
    state.params = params;
    render();
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function goBack(fallback = "home") {
    const previous = state.stack.pop();
    if (previous) {
      if (isLoginRoute(state.route) && !isLoginRoute(previous.route)) {
        unsubscribeAutoRefresh();
      }
      state.route = previous.route;
      state.params = previous.params || {};
      render();
      return;
    }
    navigate(fallback, {}, false);
  }

  function mainMenuButton(id, label, hint) {
    return `
      <button id="${id}" class="menu-button" type="button">
        <span>${escapeHtml(label)}</span>
        ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
      </button>
    `;
  }

  function screenHeader(title, subtitle = "") {
    return `
      <div class="screen-title">
        <div>
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
        </div>
        <button id="backButton" class="back-button" type="button">⇦ BACK</button>
      </div>
    `;
  }

  function bindBack(fallback = "home") {
    on("backButton", "click", () => goBack(fallback));
  }

  function renderLoading(message = "Firestoreからデータを読み込んでいます…") {
    app.innerHTML = `
      <section class="screen-card loading-card">
        <div class="screen-title">
          <div>
            <h2>Ruling Eye</h2>
            <p>Firestoreから読み込み中です</p>
          </div>
        </div>
        <div class="loading-indicator">
          <span class="loading-spinner" aria-hidden="true"></span>
          <strong>${escapeHtml(message)}</strong>
        </div>
        <div class="note-box">ロースター、大会設定、ログイン状態をFirestoreから取得しています。大会ログイン画面では自動更新を使用し、必要に応じて更新ボタンでも最新化できます。</div>
      </section>
    `;
  }

  function renderFirestoreError(error) {
    console.error("Firestore read failed", error);
    app.innerHTML = `
      <section class="screen-card">
        <div class="screen-title">
          <div>
            <h2>Firestore接続エラー</h2>
            <p>Ruling Eye管理データを読み込めませんでした。</p>
          </div>
        </div>
        <div class="status-message error" style="white-space:pre-wrap;">
          ${escapeHtml(shortFirestoreError("Firestoreの読み込み", error))}
          <details class="error-detail"><summary>詳細表示</summary><pre>${escapeHtml(firestoreErrorMessage(error))}</pre></details>
        </div>
        <div class="note-box">
          Firebase SDK、firebase-config.js、または Firestore ルールを確認してください。
          必要なパス: camera_roster / tournaments/{tournamentId}/ruling_eye_settings / camera_assignments / ruling_eye_login_sessions
        </div>
        <div class="next-actions">
          <button id="retryBootstrapButton" class="primary-button" type="button">最新データを取得</button>
        </div>
      </section>
    `;
    on("retryBootstrapButton", "click", bootstrap);
  }

  async function loadFirestoreData() {
    const [rosterSnapshot, settingsSnapshot, sessionsSnapshot] = await Promise.all([
      db.collection("camera_roster").get(),
      db.collectionGroup("ruling_eye_settings").get(),
      db.collectionGroup("ruling_eye_login_sessions").get(),
    ]);
    dataCache.officers = rosterSnapshot.docs.map((doc) => normalizeOfficer({ officerId: doc.id, ...doc.data() }));
    dataCache.tournaments = settingsSnapshot.docs
      .filter((doc) => doc.id === "main")
      .map((doc) => normalizeTournament({
        ...doc.data(),
        tournamentId: tournamentIdFromSettingsDoc(doc),
      }));
    dataCache.loginSessions = sessionsSnapshot.docs.map((doc) => normalizeLoginSession({ sessionId: doc.id, ...doc.data() }));
    state.lastLoadedAt = nowIso();
  }

  async function refreshFirestoreData({ silent = false } = {}) {
    if (!silent) renderLoading();
    await loadFirestoreData();
    state.pendingExternalUpdate = false;
    state.globalMessage = { type: "success", message: "最新データを取得しました。" };
    if (!silent) render();
  }

  async function bootstrap() {
    renderLoading();
    try {
      db = createFirestore();
      await loadFirestoreData();
      firestoreReady = true;
      state.globalMessage = { type: "success", message: "Firestoreから読み込みました。" };
      render();
    } catch (error) {
      console.error("Firestore initialization failed", error);
      renderFirestoreError(error);
    }
  }

  function bindRefreshButton() {
    on("refreshFirestoreButton", "click", async () => {
      await runOperation(
        { workingMessage: "更新中です…", successMessage: "最新データを取得しました。", actionName: "Firestoreの読み込み", rerender: true },
        async () => {
          await loadFirestoreData();
          state.pendingExternalUpdate = false;
        },
      );
    });
  }

  function render() {
    switch (state.route) {
      case "home":
        renderHome();
        break;
      case "rosterMenu":
        renderRosterMenu();
        break;
      case "officerForm":
        renderOfficerForm(state.params.officerId || null);
        break;
      case "officerComplete":
        renderOfficerComplete(state.params);
        break;
      case "rosterList":
        renderRosterList();
        break;
      case "tournamentMenu":
        renderTournamentMenu();
        break;
      case "tournamentStep1":
        renderTournamentStep1(state.params.mode || "new");
        break;
      case "tournamentStep2":
        renderTournamentStep2(state.params.mode || "new");
        break;
      case "tournamentConfirm":
        renderTournamentConfirm(state.params.mode || "new");
        break;
      case "tournamentComplete":
        renderTournamentComplete(state.params);
        break;
      case "tournamentEditSelect":
        renderTournamentEditSelect(state.params.year || "");
        break;
      case "tournamentEditReview":
        renderTournamentEditReview();
        break;
      case "loginStep1":
        renderLoginStep1(state.params.year || "", state.params.tournamentId || "");
        break;
      case "loginRole":
        renderLoginRole();
        break;
      case "loginOfficerSelect":
        renderLoginOfficerSelect();
        break;
      case "loginPhoneSelect":
        renderLoginPhoneSelect();
        break;
      case "loginComplete":
        renderLoginComplete(state.params.sessionId || "");
        break;
      default:
        renderHome();
        break;
    }
  }

  function renderHome() {
    state.stack = [];
    app.innerHTML = `
      <section class="screen">
        <div class="hero-card">
          <h2>Ruling Eye</h2>
          <p>競技委員 映像裁定支援システム｜Firestore管理導線 Phase RE-2.3</p>
        </div>
        ${statusDashboardHtml()}
        <div class="menu-grid">
          ${mainMenuButton("goRoster", "競技委員ロースター", "新規登録 / 一覧・修正 / CSV")}
          ${mainMenuButton("goTournament", "大会設定", "新規登録 / 修正 / 削除")}
          ${mainMenuButton("goLogin", "大会ログイン", "本部 / 委員長 / 競技委員")}
        </div>
        <div class="note-box">
          Firestore保存版です。大会ログイン画面ではログイン状態・iPhone No.使用状況を自動更新します。手動確認や通信復旧には「最新データを取得」を使用してください。
        </div>
        <div class="maintenance-card">
          <div class="screen-title">
            <div>
              <h2 style="font-size:1.35rem;">保守・移行メニュー</h2>
              <p>旧localStorage版で作成したデータをFirestoreへ移行します。通常運用では使用しません。</p>
            </div>
            <button id="migrateLocalStorage" class="secondary-button" type="button">localStorageデータをFirestoreへ移行</button>
          </div>
          <p id="statusMessage" class="status-message"></p>
        </div>
      </section>
    `;
    bindRefreshButton();
    on("goRoster", "click", () => navigate("rosterMenu"));
    on("goTournament", "click", () => navigate("tournamentMenu"));
    on("goLogin", "click", () => navigate("loginStep1"));
    on("migrateLocalStorage", "click", migrateLocalStorageToFirestore);
  }

  function renderRosterMenu() {
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("競技委員ロースター", "新規登録、一覧確認、CSV取込・取出しを行います。")}
        ${statusDashboardHtml()}
        <div class="menu-grid two">
          <button id="newOfficer" class="menu-button sub" type="button">新規登録</button>
          <button id="listOfficer" class="menu-button sub" type="button">一覧・修正</button>
        </div>
      </section>
    `;
    bindBack("home");
    bindRefreshButton();
    on("newOfficer", "click", () => navigate("officerForm"));
    on("listOfficer", "click", () => navigate("rosterList"));
  }

  function renderOfficerForm(officerId) {
    const isEdit = Boolean(officerId);
    const officer = officerId ? getOfficerById(officerId) : null;
    const data = officer || {
      officerName: "",
      officerKana: "",
      memberNo: "",
      categories: ["registered"],
      active: true,
      note: "",
    };
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader(
          isEdit ? "競技委員ロースター｜修正" : "競技委員ロースター｜新規登録",
          "入力順: 名前 → フリガナ → 会員No → 区分 → 有効状態 → 備考",
        )}
        <div class="form-grid">
          <div class="field full">
            <label for="officerName">名前 <span class="badge red">必須</span></label>
            <input id="officerName" type="text" value="${escapeHtml(data.officerName)}" placeholder="例: 山田 太郎">
          </div>
          <div class="field">
            <label for="officerKana">フリガナ</label>
            <input id="officerKana" type="text" value="${escapeHtml(data.officerKana)}" placeholder="例: ヤマダ タロウ">
          </div>
          <div class="field">
            <label for="memberNo">会員No</label>
            <input id="memberNo" type="text" inputmode="numeric" value="${escapeHtml(data.memberNo)}" placeholder="例: 12345">
          </div>
          <div class="field full">
            <label>専門・登録区分 <span class="badge red">1つ以上</span></label>
            <div class="checkbox-grid">
              ${CATEGORY_OPTIONS.map((option) => {
                const checked = data.categories.includes(option.value) ? " checked" : "";
                return `
                  <label class="check-card">
                    <input type="checkbox" name="categories" value="${escapeHtml(option.value)}"${checked}>
                    <span>${escapeHtml(option.label)}</span>
                  </label>
                `;
              }).join("")}
            </div>
          </div>
          <div class="field">
            <label for="active">有効状態</label>
            <select id="active">
              <option value="true"${data.active !== false ? " selected" : ""}>有効</option>
              <option value="false"${data.active === false ? " selected" : ""}>無効</option>
            </select>
          </div>
          <div class="field full">
            <label for="note">備考</label>
            <textarea id="note" placeholder="任意">${escapeHtml(data.note)}</textarea>
          </div>
        </div>
        <p id="statusMessage" class="status-message"></p>
        <div class="next-actions">
          <button id="saveOfficer" class="primary-button" type="button">${isEdit ? "修正保存" : "登録する"}</button>
        </div>
      </section>
    `;
    bindBack(isEdit ? "rosterList" : "rosterMenu");
    on("saveOfficer", "click", () => saveOfficer(officerId));
  }

  async function saveOfficer(officerId) {
    const officerName = getValue("officerName");
    if (!officerName) {
      setStatus("名前を入力してください。", "error");
      return;
    }
    const categories = checkedValues("categories");
    if (!categories.length) {
      setStatus("専門・登録区分を1つ以上選択してください。", "error");
      return;
    }

    const officers = readOfficers();
    const existingIndex = officerId ? officers.findIndex((officer) => officer.officerId === officerId) : -1;
    const now = nowIso();
    const payload = normalizeOfficer({
      officerId: officerId || makeId("officer"),
      officerName,
      officerKana: getValue("officerKana"),
      memberNo: getValue("memberNo"),
      categories,
      active: getSelectValue("active") !== "false",
      note: getValue("note"),
      createdAt: existingIndex >= 0 ? officers[existingIndex].createdAt : now,
      updatedAt: now,
    });

    if (existingIndex >= 0) {
      officers[existingIndex] = payload;
    } else {
      officers.push(payload);
    }

    await runOperation({ workingMessage: "保存中です…", actionName: "Firestoreへの保存" }, async () => {
      await rosterRef(payload.officerId).set(toFirestoreOfficer(payload), { merge: true });
      if (existingIndex >= 0) {
        dataCache.officers[existingIndex] = payload;
      } else {
        dataCache.officers.push(payload);
      }
      state.lastLoadedAt = nowIso();
      state.globalMessage = { type: "success", message: "保存しました。" };
      navigate("officerComplete", { officerId: payload.officerId, mode: existingIndex >= 0 ? "edit" : "new" });
    });
  }

  function renderOfficerComplete(params) {
    const officer = getOfficerById(params.officerId);
    app.innerHTML = `
      <section class="completion-card">
        <div class="completion-icon">✓</div>
        <h2>${params.mode === "edit" ? "修正完了" : "登録完了"}</h2>
        <p>${escapeHtml(officer?.officerName || "")} を保存しました。</p>
        <div class="summary-grid">
          <dl class="summary-item">
            <dt>区分</dt>
            <dd>${escapeHtml(categoriesLabel(officer?.categories || []))}</dd>
          </dl>
          <dl class="summary-item">
            <dt>有効状態</dt>
            <dd>${escapeHtml(activeLabel(officer?.active !== false))}</dd>
          </dl>
        </div>
        <div class="form-actions" style="justify-content:center; margin-top:20px;">
          <button id="toRosterList" class="secondary-button" type="button">一覧へ</button>
          <button id="toHome" class="primary-button" type="button">メインメニューへ戻る</button>
        </div>
      </section>
    `;
    on("toRosterList", "click", () => navigate("rosterList"));
    on("toHome", "click", () => navigate("home", {}, false));
  }

  function rosterSortValue(officer, key) {
    switch (key) {
      case "officerName":
        return officer.officerName;
      case "officerKana":
        return officer.officerKana;
      case "memberNo":
        return officer.memberNo;
      case "categories":
        return categoriesLabel(officer.categories);
      case "active":
        return activeLabel(officer.active);
      default:
        return "";
    }
  }

  function sortOfficers(officers) {
    const { key, direction } = state.rosterSort;
    const factor = direction === "desc" ? -1 : 1;
    return [...officers].sort((a, b) => {
      const av = rosterSortValue(a, key);
      const bv = rosterSortValue(b, key);
      return String(av).localeCompare(String(bv), "ja", { numeric: true, sensitivity: "base" }) * factor;
    });
  }

  function renderRosterList() {
    const officers = readOfficers();
    const filters = state.rosterFilters;
    const query = filters.query.toLowerCase();
    const filtered = sortOfficers(officers.filter((officer) => {
      const categoryOk = filters.category === "all" || officer.categories.includes(filters.category);
      const activeOk =
        filters.active === "all" ||
        (filters.active === "active" && officer.active !== false) ||
        (filters.active === "inactive" && officer.active === false);
      const queryOk =
        !query ||
        [officer.officerName, officer.officerKana, officer.memberNo, categoriesLabel(officer.categories)]
          .join(" ")
          .toLowerCase()
          .includes(query);
      return categoryOk && activeOk && queryOk;
    }));

    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("競技委員ロースター｜一覧・修正", "見出しクリックで昇順 / 降順を切り替えます。")}
        ${statusDashboardHtml()}
        <div class="filter-row">
          <div class="field">
            <label for="filterCategory">区分選択</label>
            <select id="filterCategory">
              <option value="all"${filters.category === "all" ? " selected" : ""}>全て</option>
              ${optionsHtml(CATEGORY_OPTIONS, filters.category)}
            </select>
          </div>
          <div class="field">
            <label for="filterActive">有効/無効</label>
            <select id="filterActive">
              <option value="active"${filters.active === "active" ? " selected" : ""}>有効のみ</option>
              <option value="inactive"${filters.active === "inactive" ? " selected" : ""}>無効のみ</option>
              <option value="all"${filters.active === "all" ? " selected" : ""}>全て</option>
            </select>
          </div>
          <div class="field">
            <label for="filterQuery">簡易検索</label>
            <input id="filterQuery" type="search" value="${escapeHtml(filters.query)}" placeholder="名前、フリガナ、会員No">
          </div>
        </div>
        <div class="csv-actions">
          <input id="rosterCsvInput" class="hidden" type="file" accept=".csv,text/csv">
          <button id="importCsv" class="secondary-button" type="button">CSVインポート</button>
          <button id="exportCsv" class="secondary-button" type="button">CSVエクスポート</button>
          <button id="newOfficerFromList" class="primary-button" type="button">新規登録</button>
        </div>
        <p id="statusMessage" class="status-message"></p>
        <div id="csvResult" class="csv-result hidden"></div>
        ${
          filtered.length
            ? rosterTableHtml(filtered)
            : officers.length
              ? `<div class="empty-state">条件に一致する競技委員がいません。フィルターを変更してください。</div>`
              : `<div class="empty-state">競技委員ロースターが未登録です。新規登録またはCSVインポートを行ってください。</div>`
        }
      </section>
    `;
    bindBack("rosterMenu");
    bindRefreshButton();
    on("filterCategory", "change", () => {
      state.rosterFilters.category = getSelectValue("filterCategory");
      renderRosterList();
    });
    on("filterActive", "change", () => {
      state.rosterFilters.active = getSelectValue("filterActive");
      renderRosterList();
    });
    on("filterQuery", "input", () => {
      state.rosterFilters.query = getValue("filterQuery");
      renderRosterList();
    });
    on("newOfficerFromList", "click", () => navigate("officerForm"));
    on("importCsv", "click", () => document.getElementById("rosterCsvInput")?.click());
    on("rosterCsvInput", "change", importRosterCsv);
    on("exportCsv", "click", exportRosterCsv);
    onAll("[data-edit-officer]", "click", (event) => {
      navigate("officerForm", { officerId: event.currentTarget.dataset.editOfficer });
    });
    onAll("[data-sort-key]", "click", (event) => {
      const key = event.currentTarget.dataset.sortKey;
      if (state.rosterSort.key === key) {
        state.rosterSort.direction = state.rosterSort.direction === "asc" ? "desc" : "asc";
      } else {
        state.rosterSort.key = key;
        state.rosterSort.direction = "asc";
      }
      renderRosterList();
    });
  }

  function sortHeader(key, label) {
    const active = state.rosterSort.key === key;
    const mark = active ? (state.rosterSort.direction === "asc" ? "▲" : "▼") : "↕";
    return `<button class="sort-button" type="button" data-sort-key="${escapeHtml(key)}">${escapeHtml(label)} <span class="sort-mark">${mark}</span></button>`;
  }

  function rosterTableHtml(officers) {
    return `
      <table class="list-table">
        <thead>
          <tr>
            <th>${sortHeader("officerName", "名前")}</th>
            <th>${sortHeader("officerKana", "フリガナ")}</th>
            <th>${sortHeader("memberNo", "会員No")}</th>
            <th>${sortHeader("categories", "区分")}</th>
            <th>${sortHeader("active", "有効状態")}</th>
          </tr>
        </thead>
        <tbody>
          ${officers
            .map(
              (officer) => `
                <tr>
                  <td data-label="名前">
                    <button class="link-button" type="button" data-edit-officer="${escapeHtml(officer.officerId)}">${escapeHtml(officer.officerName)}</button>
                  </td>
                  <td data-label="フリガナ">${escapeHtml(officer.officerKana || "-")}</td>
                  <td data-label="会員No">${escapeHtml(officer.memberNo || "-")}</td>
                  <td data-label="区分"><span class="badge">${escapeHtml(categoriesLabel(officer.categories))}</span></td>
                  <td data-label="有効状態"><span class="badge ${officer.active !== false ? "green" : "gray"}">${escapeHtml(activeLabel(officer.active !== false))}</span></td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const source = String(text || "").replace(/^\uFEFF/, "");
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (inQuotes) {
        if (char === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") {
        field += char;
      }
    }
    row.push(field);
    if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
    return rows;
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  function parseCsvActive(value) {
    if (String(value ?? "").trim() === "") return { ok: true, value: true };
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "有効", "active"].includes(normalized)) return { ok: true, value: true };
    if (["false", "0", "無効", "inactive"].includes(normalized)) return { ok: true, value: false };
    return { ok: false, value: true };
  }

  function makeSafeOfficerId(name, existingIds) {
    const base = String(name || "officer")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "officer";
    let candidate = `officer_${base}`;
    let index = 2;
    while (existingIds.has(candidate)) {
      candidate = `officer_${base}_${index}`;
      index += 1;
    }
    existingIds.add(candidate);
    return candidate;
  }

  async function importRosterCsv(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (!rows.length) {
      setCsvResult("CSVにデータがありません。", "error");
      document.getElementById("csvResult")?.classList.remove("hidden");
      return;
    }
    const header = rows[0].map((cell) => String(cell).trim());
    const indexOf = (name) => header.indexOf(name);
    const requiredHeaders = ["officerId", "officerName", "officerKana", "memberNo", "categories", "active", "note"];
    const missing = requiredHeaders.filter((name) => indexOf(name) < 0);
    if (missing.length) {
      setCsvResult(`CSVヘッダーが不足しています: ${missing.join(", ")}`, "error");
      document.getElementById("csvResult")?.classList.remove("hidden");
      return;
    }

    const officers = readOfficers();
    const existingIds = new Set(officers.map((officer) => officer.officerId));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];
    rows.slice(1).forEach((row, offset) => {
      const lineNo = offset + 2;
      const getCell = (name) => String(row[indexOf(name)] ?? "").trim();
      const officerName = getCell("officerName");
      if (!officerName) {
        errors.push(`${lineNo}行目: officerName が空です。`);
        skipped += 1;
        return;
      }
      const categories = normalizeCategories(getCell("categories"));
      if (!categories.length) {
        errors.push(`${lineNo}行目: categories が不正または空です。`);
        skipped += 1;
        return;
      }
      const active = parseCsvActive(getCell("active"));
      if (!active.ok) {
        errors.push(`${lineNo}行目: active が不正です。`);
        skipped += 1;
        return;
      }
      const inputId = getCell("officerId");
      const officerId = inputId || makeSafeOfficerId(officerName, existingIds);
      if (inputId) existingIds.add(inputId);
      const existingIndex = officers.findIndex((officer) => officer.officerId === officerId);
      const now = nowIso();
      const payload = normalizeOfficer({
        officerId,
        officerName,
        officerKana: getCell("officerKana"),
        memberNo: getCell("memberNo"),
        categories,
        active: active.value,
        note: getCell("note"),
        createdAt: existingIndex >= 0 ? officers[existingIndex].createdAt : now,
        updatedAt: now,
      });
      if (existingIndex >= 0) {
        officers[existingIndex] = payload;
        updated += 1;
      } else {
        officers.push(payload);
        added += 1;
      }
    });
    const message = [
      `CSVインポート結果`,
      `追加件数: ${added}件`,
      `更新件数: ${updated}件`,
      `スキップ件数: ${skipped}件`,
      `エラー件数: ${errors.length}件`,
      errors.length ? "エラー行一覧:" : "エラーなし",
      ...errors.slice(0, 12),
      errors.length > 12 ? `ほか ${errors.length - 12}件のエラーがあります。` : "",
    ].filter(Boolean).join("\n");
    await runOperation({ workingMessage: "CSVインポートを保存中です…", actionName: "CSVインポート" }, async () => {
      await saveOfficers(officers);
      renderRosterList();
      document.getElementById("csvResult")?.classList.remove("hidden");
      setCsvResult(message, errors.length ? "error" : "success");
    });
  }

  function exportRosterCsv() {
    const rows = [
      ["officerId", "officerName", "officerKana", "memberNo", "categories", "active", "note"],
      ...readOfficers().map((officer) => [
        officer.officerId,
        officer.officerName,
        officer.officerKana,
        officer.memberNo,
        officer.categories.join("|"),
        officer.active ? "true" : "false",
        officer.note,
      ]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const date = new Date();
    const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `ruling_eye_roster_${ymd}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function migrateLocalStorageToFirestore() {
    if (!window.confirm("現在のFirestoreデータに上書き・更新される可能性があります。移行しますか？")) {
      return;
    }
    await runOperation({ workingMessage: "localStorageデータをFirestoreへ移行中です…", actionName: "localStorageデータ移行" }, async () => {
      const localOfficers = readLocalArray(STORAGE_KEYS.officers).map(normalizeOfficer);
      const localTournaments = readLocalArray(STORAGE_KEYS.tournaments).map(normalizeTournament);
      const localSessions = readLocalArray(STORAGE_KEYS.loginSessions).map(normalizeLoginSession);

      if (localOfficers.length) await saveOfficers(mergeById(readOfficers(), localOfficers, "officerId"));
      for (const tournament of localTournaments) {
        await saveTournamentDocAndAssignments(tournament);
      }
      if (localSessions.length) await saveLoginSessions(mergeById(readLoginSessions(), localSessions, "sessionId"));
      await refreshFirestoreData({ silent: true });
      renderHome();
      setStatus(`Firestore移行完了: ロースター ${localOfficers.length}件 / 大会 ${localTournaments.length}件 / ログイン履歴 ${localSessions.length}件`, "success");
    });
  }

  function mergeById(currentItems, incomingItems, key) {
    const map = new Map(currentItems.map((item) => [item[key], item]));
    incomingItems.forEach((item) => map.set(item[key], item));
    return Array.from(map.values());
  }

  function renderTournamentMenu() {
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会設定", "大会の年度、競技委員長、競技委員人数を設定します。")}
        ${statusDashboardHtml()}
        <div class="menu-grid two">
          <button id="newTournament" class="menu-button sub" type="button">新規登録</button>
          <button id="editTournament" class="menu-button sub" type="button">修正・削除</button>
        </div>
      </section>
    `;
    bindBack("home");
    bindRefreshButton();
    on("newTournament", "click", () => {
      state.tournamentDraft = createTournamentDraft();
      navigate("tournamentStep1", { mode: "new" });
    });
    on("editTournament", "click", () => navigate("tournamentEditSelect"));
  }

  function createTournamentDraft(tournament = null) {
    const currentYear = String(new Date().getFullYear());
    if (!tournament) {
      return {
        tournamentId: null,
        year: currentYear,
        sequenceNo: null,
        tournamentName: "",
        officerCount: 5,
        chiefOfficerId: "",
        chiefOfficerName: "",
        selectedOfficerIds: [],
        active: true,
        createdAt: null,
      };
    }
    return {
      tournamentId: tournament.tournamentId,
      year: tournament.year || currentYear,
      sequenceNo: tournament.sequenceNo || null,
      tournamentName: tournamentDisplayName(tournament),
      isLegacyId: tournament.isLegacyId === true,
      officerCount: Number(tournament.officerCount || 5),
      chiefOfficerId: tournament.chiefOfficerId || "",
      chiefOfficerName: tournament.chiefOfficerName || "",
      selectedOfficerIds: Array.isArray(tournament.selectedOfficerIds) ? [...tournament.selectedOfficerIds] : [],
      active: tournament.active !== false,
      createdAt: tournament.createdAt || null,
    };
  }

  function renderTournamentStep1(mode = "new") {
    const draft = state.tournamentDraft || createTournamentDraft();
    state.tournamentDraft = draft;
    const isEdit = mode === "edit" && Boolean(draft.tournamentId);
    const plannedSequence = isEdit
      ? draft.sequenceNo
      : nextTournamentSequenceFromRecords(draft.year, readTournaments({ includeDeleted: true }));
    const plannedTournamentId = isEdit
      ? draft.tournamentId
      : formatTournamentId(draft.year, plannedSequence);
    const specialists = getActiveOfficers().filter((officer) => officer.categories.includes("specialist"));
    const chiefOptions = [
      ...specialists.map((officer) => ({ value: officer.officerId, label: `${officer.officerName}（${categoriesLabel(officer.categories)}）` })),
      { value: "other", label: "その他" },
    ];
    const chiefValue = draft.chiefOfficerId || "";
    const isOther = chiefValue === "other";
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader(
          `大会設定｜${mode === "edit" ? "修正" : "新規設定"} Step1`,
          "年度、大会名、人数、競技委員長を設定します。",
        )}
        <div class="form-grid">
          <div class="field">
            <label for="tournamentYear">年度</label>
            <select id="tournamentYear">${optionsHtml(getYearOptions(), draft.year)}</select>
          </div>
          <div class="field">
            <label for="officerCount">競技委員人数</label>
            <select id="officerCount">
              ${Array.from({ length: 7 }, (_, index) => index + 2)
                .map((count) => `<option value="${count}"${Number(draft.officerCount) === count ? " selected" : ""}>${count}名</option>`)
                .join("")}
            </select>
            <span class="hint">競技委員長を含む人数です。</span>
          </div>
          <div class="field full">
            <label for="tournamentName">大会名 <span class="badge red">必須</span></label>
            <input id="tournamentName" type="text" value="${escapeHtml(draft.tournamentName)}" placeholder="例: 日本プロゴルフ選手権">
          </div>
          <div class="field full tournament-id-preview${isEdit ? " is-fixed" : ""}">
            <span class="field-label">大会ID</span>
            <strong id="plannedTournamentId">${escapeHtml(plannedTournamentId)}</strong>
            <span id="plannedTournamentIdHint" class="hint">${
              isEdit
                ? `大会IDは変更できません。大会名を変更しても ${escapeHtml(draft.tournamentId)} のままです。`
                : "大会IDは保存時に年度＋年度内連番で自動発行されます。表示中のIDは予定値です。"
            }</span>
          </div>
          <div class="field full">
            <label for="chiefOfficerId">競技委員長 設定</label>
            <select id="chiefOfficerId">${optionsHtml(chiefOptions, chiefValue, "競技委員長を選択")}</select>
            <span class="hint">有効かつ categories に specialist を含む競技委員だけを候補表示します。</span>
          </div>
          <div id="chiefOtherField" class="field full${isOther ? "" : " hidden"}">
            <label for="chiefOfficerName">競技委員長名（その他）</label>
            <input id="chiefOfficerName" type="text" value="${escapeHtml(isOther ? draft.chiefOfficerName : "")}" placeholder="例: 佐藤 一郎">
          </div>
        </div>
        <p id="statusMessage" class="status-message"></p>
        <div class="next-actions">
          <button id="nextTournamentStep1" class="primary-button" type="button">NEXT ⇒</button>
        </div>
      </section>
    `;
    bindBack(mode === "edit" ? "tournamentEditReview" : "tournamentMenu");
    on("chiefOfficerId", "change", () => {
      document.getElementById("chiefOtherField")?.classList.toggle("hidden", getSelectValue("chiefOfficerId") !== "other");
    });
    on("tournamentYear", "change", () => {
      if (isEdit) return;
      const selectedYear = getSelectValue("tournamentYear");
      const sequenceNo = nextTournamentSequenceFromRecords(selectedYear, readTournaments({ includeDeleted: true }));
      const plannedId = document.getElementById("plannedTournamentId");
      if (plannedId) plannedId.textContent = formatTournamentId(selectedYear, sequenceNo);
    });
    on("nextTournamentStep1", "click", () => saveTournamentStep1(mode));
  }

  function saveTournamentStep1(mode) {
    const tournamentName = getValue("tournamentName");
    if (!tournamentName) {
      setStatus("大会名を入力してください。", "error");
      return;
    }
    const chiefOfficerId = getSelectValue("chiefOfficerId");
    if (!chiefOfficerId) {
      setStatus("競技委員長を選択してください。", "error");
      return;
    }
    let chiefOfficerName = "";
    if (chiefOfficerId === "other") {
      chiefOfficerName = getValue("chiefOfficerName");
      if (!chiefOfficerName) {
        setStatus("「その他」を選択した場合は競技委員長名を入力してください。", "error");
        return;
      }
    } else {
      const officer = getOfficerById(chiefOfficerId);
      chiefOfficerName = officer?.officerName || "";
      if (!chiefOfficerName) {
        setStatus("競技委員長候補が見つかりません。ロースターを確認してください。", "error");
        return;
      }
    }
    const draft = state.tournamentDraft || createTournamentDraft();
    draft.year = getSelectValue("tournamentYear");
    draft.tournamentName = tournamentName;
    draft.officerCount = Number(getSelectValue("officerCount"));
    draft.chiefOfficerId = chiefOfficerId;
    draft.chiefOfficerName = chiefOfficerName;

    if (chiefOfficerId !== "other") {
      const selected = new Set(draft.selectedOfficerIds);
      selected.add(chiefOfficerId);
      draft.selectedOfficerIds = Array.from(selected);
    }
    state.tournamentDraft = draft;
    navigate("tournamentStep2", { mode });
  }

  function selectedTotalCount(draft) {
    const selectedCount = new Set(draft.selectedOfficerIds || []).size;
    return selectedCount + (draft.chiefOfficerId === "other" ? 1 : 0);
  }

  function selectableRosterLimit(draft) {
    return Number(draft.officerCount || 0) - (draft.chiefOfficerId === "other" ? 1 : 0);
  }

  function renderTournamentStep2(mode = "new") {
    const draft = state.tournamentDraft || createTournamentDraft();
    if (draft.chiefOfficerId && draft.chiefOfficerId !== "other") {
      const selected = new Set(draft.selectedOfficerIds);
      selected.add(draft.chiefOfficerId);
      draft.selectedOfficerIds = Array.from(selected);
    }
    state.tournamentDraft = draft;
    const activeOfficers = getActiveOfficers();
    const selected = new Set(draft.selectedOfficerIds || []);
    const total = selectedTotalCount(draft);
    const remaining = Number(draft.officerCount) - total;
    const lockedChiefId = draft.chiefOfficerId !== "other" ? draft.chiefOfficerId : "";
    const chiefOtherNote = draft.chiefOfficerId === "other"
      ? `<div class="note-box">競技委員長「${escapeHtml(draft.chiefOfficerName)}」を1名として人数に含めています。</div>`
      : "";
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader(
          `大会設定｜${mode === "edit" ? "修正" : "新規設定"} Step2`,
          "競技委員を選択します。クリックまたはタップで選択/解除できます。",
        )}
        <div class="note-box">競技委員長を含む人数です。競技委員長がロースター内の場合は選択済みとして固定表示します。</div>
        ${chiefOtherNote}
        <div class="selected-counter">
          <span class="counter-pill">競技委員人数 ${Number(draft.officerCount)}名</span>
          <span class="counter-pill">選択済み ${total}名</span>
          <span class="counter-pill">残り ${Math.max(remaining, 0)}名</span>
        </div>
        ${
          activeOfficers.length
            ? `<div class="choice-list">
                ${activeOfficers.map((officer) => officerChoiceHtml(officer, selected.has(officer.officerId), officer.officerId === lockedChiefId)).join("")}
              </div>`
            : `<div class="empty-state">有効な競技委員が登録されていません。先にロースター登録を行ってください。</div>`
        }
        <p id="statusMessage" class="status-message">${remaining < 0 ? "指定人数を超えています。選択を解除してください。" : ""}</p>
        <div class="next-actions">
          <button id="nextTournamentStep2" class="primary-button" type="button">NEXT ⇒</button>
        </div>
      </section>
    `;
    bindBack("tournamentStep1");
    onAll("[data-toggle-officer]", "click", (event) => {
      toggleTournamentOfficer(event.currentTarget.dataset.toggleOfficer, mode);
    });
    on("nextTournamentStep2", "click", () => {
      const currentTotal = selectedTotalCount(state.tournamentDraft);
      if (currentTotal !== Number(state.tournamentDraft.officerCount)) {
        setStatus(`指定人数と選択済み人数が一致していません。現在 ${currentTotal}名 / 必要 ${state.tournamentDraft.officerCount}名です。`, "error");
        return;
      }
      navigate("tournamentConfirm", { mode });
    });
  }

  function officerChoiceHtml(officer, selected, locked) {
    const classes = ["choice-button"];
    if (selected) classes.push("selected");
    if (locked) classes.push("locked");
    return `
      <button class="${classes.join(" ")}" type="button" data-toggle-officer="${escapeHtml(officer.officerId)}">
        <strong>${escapeHtml(officer.officerName)}</strong>
        <span>${escapeHtml(categoriesLabel(officer.categories))}${locked ? "｜競技委員長（人数に含む）" : ""}</span>
      </button>
    `;
  }

  function toggleTournamentOfficer(officerId, mode) {
    const draft = state.tournamentDraft;
    if (!draft) return;
    if (draft.chiefOfficerId === officerId) {
      setStatus("競技委員長は人数に含めています。変更する場合はBACKで委員長を変更してください。", "warning");
      return;
    }
    const selected = new Set(draft.selectedOfficerIds || []);
    if (selected.has(officerId)) {
      selected.delete(officerId);
    } else {
      const rosterLimit = selectableRosterLimit(draft);
      if (selected.size >= rosterLimit) {
        setStatus(`選択可能人数は最大 ${rosterLimit}名です。`, "error");
        return;
      }
      selected.add(officerId);
    }
    draft.selectedOfficerIds = Array.from(selected);
    state.tournamentDraft = draft;
    renderTournamentStep2(mode);
  }

  function renderTournamentConfirm(mode = "new") {
    const draft = state.tournamentDraft;
    if (!draft) {
      navigate("tournamentMenu", {}, false);
      return;
    }
    const selectedOfficers = selectedOfficersFromDraft(draft);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader(`大会設定｜${mode === "edit" ? "修正" : "新規設定"} 最終確認`, "内容を確認して保存してください。")}
        ${tournamentSummaryHtml(draft, selectedOfficers)}
        <div class="next-actions">
          <button id="saveTournament" class="primary-button" type="button">${mode === "edit" ? "修正保存" : "設定完了"}</button>
        </div>
      </section>
    `;
    bindBack("tournamentStep2");
    on("saveTournament", "click", () => saveTournament(mode));
  }

  function selectedOfficersFromDraft(draft) {
    const officers = readOfficers();
    return Array.from(new Set(draft.selectedOfficerIds || []))
      .map((id) => officers.find((officer) => officer.officerId === id))
      .filter(Boolean)
      .map((officer) => ({
        officerId: officer.officerId,
        name: officer.officerName,
        officerName: officer.officerName,
        category: officer.category,
        categories: officer.categories,
        categoryLabel: categoriesLabel(officer.categories),
      }));
  }

  async function saveAssignmentsForTournament(tournament) {
    const selectedOfficers = Array.isArray(tournament.selectedOfficers) ? tournament.selectedOfficers : [];
    const batch = db.batch();
    const selectedIds = new Set(selectedOfficers.map((selected) => selected.officerId));
    const existing = await db.collection("tournaments").doc(tournament.tournamentId).collection("camera_assignments").get();
    existing.docs.forEach((doc) => {
      if (!selectedIds.has(doc.id)) batch.delete(doc.ref);
    });
    selectedOfficers.forEach((selected, index) => {
      const officer = getOfficerById(selected.officerId) || selected;
      const assignment = toFirestoreAssignment(tournament, officer, index);
      batch.set(assignmentRef(tournament.tournamentId, assignment.assignmentId), assignment, { merge: true });
    });
    await batch.commit();
  }

  async function saveTournamentDocAndAssignments(tournament) {
    const normalized = normalizeTournament(tournament);
    await tournamentSettingsRef(normalized.tournamentId).set(toFirestoreTournament(normalized), { merge: true });
    const existingIndex = dataCache.tournaments.findIndex((item) => item.tournamentId === normalized.tournamentId);
    if (existingIndex >= 0) {
      dataCache.tournaments[existingIndex] = normalized;
    } else {
      dataCache.tournaments.push(normalized);
    }
    await saveAssignmentsForTournament(normalized);
    state.lastLoadedAt = nowIso();
  }

  function tournamentSummaryHtml(draft, selectedOfficers, clickable = false) {
    const clickClass = clickable ? " clickable" : "";
    const attr = (target) => (clickable ? ` data-edit-target="${target}"` : "");
    const isExisting = Boolean(draft.tournamentId);
    const plannedSequence = isExisting
      ? draft.sequenceNo
      : nextTournamentSequenceFromRecords(draft.year, readTournaments({ includeDeleted: true }));
    const displayTournamentId = isExisting
      ? draft.tournamentId
      : formatTournamentId(draft.year, plannedSequence);
    const sequenceLabel = isExisting
      ? tournamentSequenceLabel(draft)
      : String(plannedSequence).padStart(2, "0");
    return `
      <div class="summary-grid">
        <dl class="summary-item">
          <dt>大会ID（変更不可）</dt>
          <dd>${escapeHtml(displayTournamentId)}${isExisting && draft.isLegacyId ? ' <span class="badge gray">旧形式ID</span>' : ""}</dd>
        </dl>
        <dl class="summary-item${clickClass}"${attr("step1")}>
          <dt>年度</dt>
          <dd>${escapeHtml(draft.year)}</dd>
        </dl>
        <dl class="summary-item">
          <dt>年度内連番</dt>
          <dd>${escapeHtml(sequenceLabel)}</dd>
        </dl>
        <dl class="summary-item${clickClass}"${attr("step1")}>
          <dt>大会名</dt>
          <dd>${escapeHtml(draft.tournamentName)}</dd>
        </dl>
        <dl class="summary-item${clickClass}"${attr("step1")}>
          <dt>競技委員長</dt>
          <dd>${escapeHtml(draft.chiefOfficerName)}${draft.chiefOfficerId === "other" ? "（その他）" : ""}</dd>
        </dl>
        <dl class="summary-item${clickClass}"${attr("step1")}>
          <dt>競技委員人数</dt>
          <dd>${escapeHtml(draft.officerCount)}名</dd>
        </dl>
        <dl class="summary-item${clickClass}"${attr("step2")} style="grid-column:1 / -1;">
          <dt>選択された競技委員一覧</dt>
          <dd>${selectedOfficers.length ? selectedOfficers.map((officer) => `${escapeHtml(officer.officerName)}（${escapeHtml(officer.categoryLabel)}）`).join("、") : "なし"}</dd>
        </dl>
      </div>
      ${
        clickable
          ? `<p class="hint" style="margin-top:12px;">クリックできる項目を選ぶと該当設定画面へ戻れます。修正後は再度確認画面に戻ります。</p>`
          : ""
      }
    `;
  }

  async function saveTournament(mode) {
    const draft = state.tournamentDraft;
    if (!draft) return;
    const total = selectedTotalCount(draft);
    if (total !== Number(draft.officerCount)) {
      setStatus(`指定人数と選択済み人数が一致していません。現在 ${total}名 / 必要 ${draft.officerCount}名です。`, "error");
      return;
    }
    await runOperation({ workingMessage: "大会設定を保存中です…", actionName: "大会設定の保存" }, async () => {
      const tournaments = readTournaments({ includeDeleted: true });
      const existingIndex = draft.tournamentId
        ? tournaments.findIndex((tournament) => tournament.tournamentId === draft.tournamentId)
        : -1;
      const now = nowIso();
      const selectedOfficers = selectedOfficersFromDraft(draft);
      const generated = draft.tournamentId
        ? { tournamentId: draft.tournamentId, sequenceNo: draft.sequenceNo }
        : await generateTournamentId(draft.year);
      const payload = normalizeTournament({
        tournamentId: generated.tournamentId,
        year: draft.year,
        sequenceNo: generated.sequenceNo,
        tournamentName: draft.tournamentName,
        officerCount: Number(draft.officerCount),
        chiefOfficerId: draft.chiefOfficerId === "other" ? "other" : draft.chiefOfficerId,
        chiefOfficerName: draft.chiefOfficerName,
        selectedOfficerIds: selectedOfficers.map((officer) => officer.officerId),
        selectedOfficers,
        active: true,
        deleted: false,
        createdAt: existingIndex >= 0 ? tournaments[existingIndex].createdAt : now,
        updatedAt: now,
      });
      await saveTournamentDocAndAssignments(payload);
      state.tournamentDraft = createTournamentDraft(payload);
      state.globalMessage = { type: "success", message: "大会設定を保存しました。" };
      navigate("tournamentComplete", { tournamentId: payload.tournamentId, mode });
    });
  }

  function renderTournamentComplete(params) {
    const tournament = getTournamentById(params.tournamentId, { includeDeleted: true });
    app.innerHTML = `
      <section class="completion-card">
        <div class="completion-icon">✓</div>
        <h2>設定完了</h2>
        <p>${escapeHtml(tournamentDisplayName(tournament))} を保存しました。</p>
        <div class="summary-grid">
          <dl class="summary-item">
            <dt>大会ID</dt>
            <dd>${escapeHtml(tournament?.tournamentId || "-")}</dd>
          </dl>
          <dl class="summary-item">
            <dt>大会名</dt>
            <dd>${escapeHtml(tournamentDisplayName(tournament))}</dd>
          </dl>
        </div>
        <div class="form-actions" style="justify-content:center; margin-top:20px;">
          <button id="toTournamentMenu" class="secondary-button" type="button">大会設定へ</button>
          <button id="toHome" class="primary-button" type="button">メインメニューへ戻る</button>
        </div>
      </section>
    `;
    on("toTournamentMenu", "click", () => navigate("tournamentMenu"));
    on("toHome", "click", () => navigate("home", {}, false));
  }

  function renderTournamentEditSelect(year = "") {
    const tournaments = sortTournaments(readTournaments());
    const years = Array.from(new Set(tournaments.map((tournament) => tournament.year).filter(Boolean))).sort((a, b) => String(b).localeCompare(String(a), "ja", { numeric: true }));
    const selectedYear = year || years[0] || "";
    const tournamentsInYear = tournaments.filter((tournament) => tournament.year === selectedYear);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会設定｜修正・削除", "年度を選択すると登録済み大会が表示されます。削除は論理削除です。")}
        ${statusDashboardHtml()}
        ${
          tournaments.length
            ? `
              <div class="form-grid">
                <div class="field">
                  <label for="editYear">年度</label>
                  <select id="editYear">${optionsHtml(years, selectedYear, "年度を選択")}</select>
                </div>
                <div class="field">
                  <label for="editTournamentId">大会名 / 大会ID</label>
                  <select id="editTournamentId">${optionsHtml(
                    tournamentsInYear.map((tournament) => ({ value: tournament.tournamentId, label: tournamentOptionLabel(tournament) })),
                    "",
                    "大会を選択",
                  )}</select>
                </div>
              </div>
              <p id="statusMessage" class="status-message"></p>
              <div class="next-actions">
                <button id="deleteTournament" class="danger-button" type="button">大会削除</button>
                <button id="loadTournamentEdit" class="primary-button" type="button">修正 ⇒</button>
              </div>
              ${tournamentTableHtml(tournaments)}
            `
            : `<div class="empty-state">大会設定が未登録です。大会設定から新規登録してください。</div>`
        }
      </section>
    `;
    bindBack("tournamentMenu");
    bindRefreshButton();
    on("editYear", "change", () => navigate("tournamentEditSelect", { year: getSelectValue("editYear") }, false));
    on("loadTournamentEdit", "click", () => {
      const tournamentId = getSelectValue("editTournamentId");
      if (!tournamentId) {
        setStatus("修正する大会を選択してください。", "error");
        return;
      }
      const tournament = getTournamentById(tournamentId);
      state.tournamentDraft = createTournamentDraft(tournament);
      navigate("tournamentEditReview");
    });
    on("deleteTournament", "click", () => softDeleteTournamentFromSelect());
  }

  function tournamentTableHtml(tournaments) {
    return `
      <div class="tournament-list-block">
        <h3>大会設定一覧</h3>
        <table class="list-table tournament-list-table">
          <thead>
            <tr>
              <th>年度</th>
              <th>連番</th>
              <th>大会ID</th>
              <th>大会名</th>
              <th>競技委員長</th>
              <th>削除状態</th>
            </tr>
          </thead>
          <tbody>
            ${tournaments.map((tournament) => `
              <tr>
                <td data-label="年度">${escapeHtml(tournament.year || "-")}</td>
                <td data-label="連番">${escapeHtml(tournamentSequenceLabel(tournament))}</td>
                <td data-label="大会ID">
                  <code>${escapeHtml(tournament.tournamentId)}</code>
                  ${tournament.isLegacyId ? '<span class="badge gray">旧形式ID</span>' : ""}
                </td>
                <td data-label="大会名">${escapeHtml(tournamentDisplayName(tournament))}</td>
                <td data-label="競技委員長">${escapeHtml(tournament.chiefOfficerName || "-")}</td>
                <td data-label="削除状態"><span class="badge green">有効</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  async function softDeleteTournamentFromSelect() {
    const tournamentId = getSelectValue("editTournamentId");
    if (!tournamentId) {
      setStatus("削除する大会を選択してください。", "error");
      return;
    }
    if (!window.confirm("この大会設定を削除しますか？削除後はログイン候補に表示されません。")) {
      return;
    }
    const now = nowIso();
    const tournaments = readTournaments({ includeDeleted: true }).map((tournament) =>
      tournament.tournamentId === tournamentId
        ? { ...tournament, deleted: true, deletedAt: now, updatedAt: now }
        : tournament,
    );
    await runOperation({ workingMessage: "大会設定を削除中です…", actionName: "大会削除" }, async () => {
      await saveTournaments(tournaments);
      await endAllSessions(tournamentId);
      setStatus("大会設定を削除しました。削除済み大会は通常一覧・ログイン候補に表示されません。", "success");
      setTimeout(() => navigate("tournamentEditSelect", {}, false), 400);
    });
  }

  function renderTournamentEditReview() {
    const draft = state.tournamentDraft;
    if (!draft) {
      navigate("tournamentEditSelect", {}, false);
      return;
    }
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会設定｜修正 設定確認", "クリックできる項目から修正画面へ戻れます。")}
        ${tournamentSummaryHtml(draft, selectedOfficersFromDraft(draft), true)}
        <p id="statusMessage" class="status-message"></p>
        <div class="next-actions">
          <button id="saveTournamentReview" class="primary-button" type="button">修正保存</button>
        </div>
      </section>
    `;
    bindBack("tournamentEditSelect");
    onAll("[data-edit-target]", "click", (event) => {
      const target = event.currentTarget.dataset.editTarget;
      navigate(target === "step2" ? "tournamentStep2" : "tournamentStep1", { mode: "edit" });
    });
    on("saveTournamentReview", "click", () => saveTournament("edit"));
  }

  function renderLoginStep1(year = "", tournamentId = "") {
    const tournaments = sortTournaments(readTournaments().filter((tournament) => tournament.active !== false));
    const years = Array.from(new Set(tournaments.map((tournament) => tournament.year).filter(Boolean))).sort((a, b) => String(b).localeCompare(String(a), "ja", { numeric: true }));
    const selectedYear = year || years[0] || "";
    const tournamentsInYear = tournaments.filter((tournament) => tournament.year === selectedYear);
    const selectedTournamentId = tournamentId || tournamentsInYear[0]?.tournamentId || "";
    const selectedTournament = selectedTournamentId ? getTournamentById(selectedTournamentId) : null;
    const autoRefreshPanel = selectedTournament ? autoRefreshPanelHtml(selectedTournament.tournamentId) : "";
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン", "年度・大会ID・大会名を確認してログインに進みます。ログイン状態の個別解除 / 全解除もできます。")}
        ${statusDashboardHtml()}
        ${
          tournaments.length
            ? `
              <div class="form-grid">
                <div class="field">
                  <label for="loginYear">年度</label>
                  <select id="loginYear">${optionsHtml(years, selectedYear, "年度を選択")}</select>
                </div>
                <div class="field">
                  <label for="loginTournamentId">大会名 / 大会ID</label>
                  <select id="loginTournamentId">${optionsHtml(
                    tournamentsInYear.map((tournament) => ({ value: tournament.tournamentId, label: tournamentOptionLabel(tournament) })),
                    selectedTournamentId,
                    "大会を選択",
                  )}</select>
                </div>
              </div>
              ${selectedTournament ? `
                <div class="tournament-selection-summary">
                  <span>大会ID <strong>${escapeHtml(selectedTournament.tournamentId)}</strong></span>
                  <span>大会名 <strong>${escapeHtml(tournamentDisplayName(selectedTournament))}</strong></span>
                </div>
              ` : ""}
              <p id="statusMessage" class="status-message"></p>
              <div class="next-actions">
                <button id="loginTournament" class="primary-button" type="button">ログイン</button>
              </div>
              ${autoRefreshPanel}
              ${selectedTournament ? phoneUsagePanelHtml(selectedTournament) : ""}
              ${selectedTournament ? loginStatusPanelHtml(selectedTournament.tournamentId) : ""}
            `
            : `<div class="empty-state">大会設定が未登録です。大会設定から新規登録してください。</div>`
        }
      </section>
    `;
    bindBack("home");
    bindRefreshButton();
    if (selectedTournamentId) {
      bindAutoRefreshToggle(selectedTournamentId);
      syncAutoRefreshForLoginTournament(selectedTournamentId);
    } else {
      syncAutoRefreshForLoginTournament("");
    }
    on("loginYear", "change", () => navigate("loginStep1", { year: getSelectValue("loginYear") }, false));
    on("loginTournamentId", "change", () => navigate("loginStep1", { year: selectedYear, tournamentId: getSelectValue("loginTournamentId") }, false));
    on("loginTournament", "click", () => {
      const selectedId = getSelectValue("loginTournamentId");
      if (!selectedId) {
        setStatus("大会を選択してください。", "error");
        return;
      }
      state.loginDraft = { tournamentId: selectedId };
      navigate("loginRole");
    });
    bindLoginStatusActions(selectedTournamentId, () => navigate("loginStep1", { year: selectedYear, tournamentId: selectedTournamentId }, false));
  }

  function loginStatusPanelHtml(tournamentId) {
    const sessions = readLoginSessions()
      .filter((session) => session.tournamentId === tournamentId)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return String(b.loginAt || "").localeCompare(String(a.loginAt || ""));
      });
    const activeCount = sessions.filter((session) => session.status !== "ended").length;
    return `
      <div class="screen-card login-status-panel" style="box-shadow:none; margin-top:18px;">
        <div class="screen-title">
          <div>
            <h2 style="font-size:1.35rem;">この大会のログイン状態を確認</h2>
            <p>active / ended の状態、ログイン時刻、終了時刻を確認できます。</p>
          </div>
          <button id="endAllSessions" class="danger-button" type="button"${activeCount ? "" : " disabled"}>全解除</button>
        </div>
        ${
          sessions.length
            ? `<div class="login-status-list">
                ${sessions.map((session) => `
                  <div class="login-status-row ${session.status === "ended" ? "is-ended" : "is-active"}">
                    <strong>${escapeHtml(session.roleLabel)}</strong>
                    <span>${escapeHtml(session.officerName || "-")}</span>
                    <span>${session.deviceNo ? `iPhone No.${escapeHtml(session.deviceNo)}` : "iPhone No.なし"}</span>
                    <span><span class="state-badge ${session.status === "ended" ? "ended" : "active"}">${escapeHtml(session.status)}</span></span>
                    <span>${escapeHtml(formatDateTime(session.loginAt))}</span>
                    <span>${escapeHtml(session.endedAt ? formatDateTime(session.endedAt) : "-")}</span>
                    <button class="danger-button" type="button" data-end-session="${escapeHtml(session.sessionId)}"${session.status === "ended" ? " disabled" : ""}>個別解除</button>
                  </div>
                `).join("")}
              </div>`
            : `<div class="empty-state">現在、この大会のログイン状態はありません。</div>`
        }
      </div>
    `;
  }

  function phoneUsagePanelHtml(tournament) {
    const activeByDevice = new Map(activeLoginSessions(tournament.tournamentId).filter((session) => session.deviceNo).map((session) => [String(session.deviceNo), session]));
    return `
      <div class="phone-usage-panel">
        <h3>iPhone No.使用状況</h3>
        <div class="phone-usage-grid">
          ${["1", "2", "3", "4", "5", "6", "7"].map((number) => {
            const session = activeByDevice.get(number);
            const isChiefNo = number === "1";
            const displayName = session ? (session.officerName || session.roleLabel) : isChiefNo ? (tournament.chiefOfficerName || "競技委員長未設定") : "未使用";
            const displayState = session ? "使用中" : isChiefNo ? "未ログイン" : "未使用";
            return `
              <div class="phone-usage-card ${session ? "in-use" : "unused"} ${isChiefNo ? "chief-fixed" : ""}">
                <strong>No.${number}</strong>
                <span>${isChiefNo ? "競技委員長固定" : "通常競技委員"}</span>
                <b>${escapeHtml(displayName)}</b>
                <em>${escapeHtml(displayState)}</em>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function assignmentSummaryPanelHtml(tournament) {
    const { mapByOfficer } = assignmentMap(tournament.tournamentId);
    const officers = Array.isArray(tournament.selectedOfficers) ? tournament.selectedOfficers : [];
    return `
      <div class="phone-usage-panel">
        <h3>競技委員ごとの割当状況</h3>
        <div class="login-status-list">
          ${officers.length ? officers.map((officer) => {
            const isChief = tournament.chiefOfficerId !== "other" && officer.officerId === tournament.chiefOfficerId;
            const assigned = mapByOfficer.get(officer.officerId);
            return `
              <div class="assignment-row ${assigned ? "is-active" : ""}">
                <strong>${escapeHtml(officer.name || officer.officerName)}</strong>
                <span>${isChief ? "競技委員長 / No.1" : assigned?.deviceNo ? `No.${escapeHtml(assigned.deviceNo)} 使用中` : "未割当"}</span>
              </div>
            `;
          }).join("") : `<div class="empty-state">選択済み競技委員がありません。</div>`}
        </div>
      </div>
    `;
  }

  function bindLoginStatusActions(tournamentId, afterUpdate) {
    if (!tournamentId) return;
    on("endAllSessions", "click", async () => {
      if (!window.confirm("この大会のactiveログインをすべて解除しますか？")) return;
      await runOperation({ workingMessage: "全解除を実行中です…", actionName: "全解除" }, async () => {
        await endAllSessions(tournamentId);
        afterUpdate();
      });
    });
    onAll("[data-end-session]", "click", async (event) => {
      await runOperation({ workingMessage: "個別解除を実行中です…", actionName: "個別解除" }, async () => {
        await endSession(event.currentTarget.dataset.endSession);
        afterUpdate();
      });
    });
  }

  function renderLoginRole() {
    const tournament = getTournamentById(state.loginDraft?.tournamentId);
    if (!tournament) {
      navigate("loginStep1", {}, false);
      return;
    }
    const autoRefreshPanel = autoRefreshPanelHtml(tournament.tournamentId);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン｜ログイン者選択", `${tournamentDisplayName(tournament)}｜${tournament.tournamentId}`)}
        ${autoRefreshPanel}
        <div class="choice-list">
          <button id="loginHeadquarters" class="choice-button" type="button">
            <strong>大会本部</strong>
            <span>iPhone No.割当なし / PC・iPad想定</span>
          </button>
          <button id="loginChief" class="choice-button" type="button">
            <strong>競技委員長</strong>
            <span>${escapeHtml(tournament.chiefOfficerName || "未設定")}｜iPhone No.1（競技委員長固定）</span>
          </button>
          <button id="loginOfficer" class="choice-button" type="button">
            <strong>競技委員</strong>
            <span>委員長を除く競技委員から選択 / iPhone No.2〜No.7</span>
          </button>
        </div>
        <p id="statusMessage" class="status-message"></p>
        ${phoneUsagePanelHtml(tournament)}
        ${loginStatusPanelHtml(tournament.tournamentId)}
      </section>
    `;
    bindBack("loginStep1");
    bindAutoRefreshToggle(tournament.tournamentId);
    syncAutoRefreshForLoginTournament(tournament.tournamentId);
    on("loginHeadquarters", "click", () => createLoginSession({
      tournament,
      loginRole: "hq",
      officerId: null,
      officerName: "大会本部",
      deviceNo: null,
    }));
    on("loginChief", "click", () => createLoginSession({
      tournament,
      loginRole: "chief",
      officerId: tournament.chiefOfficerId === "other" ? null : tournament.chiefOfficerId,
      officerName: tournament.chiefOfficerName,
      deviceNo: "1",
    }));
    on("loginOfficer", "click", () => navigate("loginOfficerSelect"));
    bindLoginStatusActions(tournament.tournamentId, () => renderLoginRole());
  }

  function assignmentMap(tournamentId) {
    const mapByOfficer = new Map();
    const mapByDevice = new Map();
    activeLoginSessions(tournamentId).forEach((session) => {
      if (session.officerId) mapByOfficer.set(session.officerId, session);
      if (session.deviceNo) mapByDevice.set(String(session.deviceNo), session);
    });
    return { mapByOfficer, mapByDevice };
  }

  function renderLoginOfficerSelect() {
    const tournament = getTournamentById(state.loginDraft?.tournamentId);
    if (!tournament) {
      navigate("loginStep1", {}, false);
      return;
    }
    const autoRefreshPanel = autoRefreshPanelHtml(tournament.tournamentId);
    const { mapByOfficer } = assignmentMap(tournament.tournamentId);
    const selectedOfficers = (Array.isArray(tournament.selectedOfficers) ? tournament.selectedOfficers : [])
      .filter((officer) => !(tournament.chiefOfficerId && tournament.chiefOfficerId !== "other" && officer.officerId === tournament.chiefOfficerId));
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン｜競技委員選択", `${tournamentDisplayName(tournament)}｜${tournament.tournamentId}｜委員長は通常競技委員の選択肢から除外しています。`)}
        ${autoRefreshPanel}
        ${assignmentSummaryPanelHtml(tournament)}
        ${
          selectedOfficers.length
            ? `<div class="choice-list">
                ${selectedOfficers
                  .map((officer) => {
                    const assigned = mapByOfficer.get(officer.officerId);
                    return `
                      <button class="choice-button" type="button" data-login-officer="${escapeHtml(officer.officerId)}">
                        <strong>${escapeHtml(officer.name || officer.officerName)}</strong>
                        <span>${assigned?.deviceNo ? `iPhone No.${escapeHtml(assigned.deviceNo)} 使用中` : "未割当"}｜${escapeHtml(officer.categoryLabel || categoriesLabel(officer.categories || officer.category || ""))}</span>
                      </button>
                    `;
                  })
                  .join("")}
              </div>`
            : `<div class="empty-state">委員長を除く競技委員がいません。大会設定を確認してください。</div>`
        }
        ${phoneUsagePanelHtml(tournament)}
        ${loginStatusPanelHtml(tournament.tournamentId)}
      </section>
    `;
    bindBack("loginRole");
    bindAutoRefreshToggle(tournament.tournamentId);
    syncAutoRefreshForLoginTournament(tournament.tournamentId);
    onAll("[data-login-officer]", "click", (event) => {
      const officerId = event.currentTarget.dataset.loginOfficer;
      const officer = selectedOfficers.find((item) => item.officerId === officerId);
      state.loginDraft = {
        ...state.loginDraft,
        officerId,
        officerName: officer?.name || officer?.officerName || "",
      };
      navigate("loginPhoneSelect");
    });
    bindLoginStatusActions(tournament.tournamentId, () => renderLoginOfficerSelect());
  }

  function renderLoginPhoneSelect() {
    const tournament = getTournamentById(state.loginDraft?.tournamentId);
    if (!tournament || !state.loginDraft?.officerId) {
      navigate("loginStep1", {}, false);
      return;
    }
    const autoRefreshPanel = autoRefreshPanelHtml(tournament.tournamentId);
    const { mapByDevice, mapByOfficer } = assignmentMap(tournament.tournamentId);
    const currentOfficerSession = mapByOfficer.get(state.loginDraft.officerId);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン｜iPhone No.選択", `${state.loginDraft.officerName}｜通常競技委員は No.2〜No.7 のみ選択できます。`)}
        ${currentOfficerSession?.deviceNo ? `<div class="note-box">この競技委員は既に iPhone No.${escapeHtml(currentOfficerSession.deviceNo)} でログイン済みです。別番号を選ぶと変更確認を出します。</div>` : ""}
        ${autoRefreshPanel}
        ${phoneUsagePanelHtml(tournament)}
        <div class="phone-grid">
          ${["2", "3", "4", "5", "6", "7"]
            .map((number) => {
              const assigned = mapByDevice.get(number);
              return `
                <button class="phone-button ${assigned ? "in-use" : ""}" type="button" data-phone-no="${number}">
                  <strong>iPhone No.${number}</strong>
                  <span>${assigned ? `使用中: ${escapeHtml(assigned.officerName || assigned.roleLabel)}` : "未使用"}</span>
                </button>
              `;
            })
            .join("")}
        </div>
        <p id="statusMessage" class="status-message"></p>
        ${loginStatusPanelHtml(tournament.tournamentId)}
      </section>
    `;
    bindBack("loginOfficerSelect");
    bindAutoRefreshToggle(tournament.tournamentId);
    syncAutoRefreshForLoginTournament(tournament.tournamentId);
    onAll("[data-phone-no]", "click", (event) => {
      createLoginSession({
        tournament,
        loginRole: "officer",
        officerId: state.loginDraft.officerId,
        officerName: state.loginDraft.officerName,
        deviceNo: event.currentTarget.dataset.phoneNo,
      });
    });
    bindLoginStatusActions(tournament.tournamentId, () => renderLoginPhoneSelect());
  }

  async function createLoginSession({ tournament, loginRole, officerId, officerName, deviceNo }) {
    const roleLabel = ROLE_LABELS[loginRole] || loginRole;
    const sessions = readLoginSessions();
    const activeSessions = sessions.filter((session) => session.tournamentId === tournament.tournamentId && session.status !== "ended");
    const sameOfficer = officerId ? activeSessions.find((session) => session.officerId === officerId) : null;
    const sameDevice = deviceNo ? activeSessions.find((session) => session.deviceNo === String(deviceNo)) : null;
    const now = nowIso();

    if (sameOfficer && sameOfficer.deviceNo !== String(deviceNo || "")) {
      const ok = window.confirm(`この競技委員は既に iPhone No.${sameOfficer.deviceNo} でログイン済みです。iPhone No.${deviceNo} に変更しますか？`);
      if (!ok) return;
    } else if (sameOfficer && sameOfficer.deviceNo === String(deviceNo || "")) {
      navigate("loginComplete", { sessionId: sameOfficer.sessionId });
      return;
    }

    if (sameDevice && (!sameOfficer || sameDevice.sessionId !== sameOfficer.sessionId)) {
      const ok = window.confirm(`iPhone No.${deviceNo} は ${sameDevice.officerName || sameDevice.roleLabel} が使用中です。割当を変更しますか？`);
      if (!ok) return;
    }

    const updatedSessions = sessions.map((session) => {
      const conflictByOfficer = officerId && session.tournamentId === tournament.tournamentId && session.status !== "ended" && session.officerId === officerId;
      const conflictByDevice = deviceNo && session.tournamentId === tournament.tournamentId && session.status !== "ended" && session.deviceNo === String(deviceNo);
      return conflictByOfficer || conflictByDevice
        ? { ...session, status: "ended", endedAt: now, updatedAt: now }
        : session;
    });

    const session = normalizeLoginSession({
      sessionId: makeId("login"),
      tournamentId: tournament.tournamentId,
      tournamentName: tournamentDisplayName(tournament),
      loginRole,
      roleLabel,
      officerId,
      officerName,
      deviceNo: deviceNo === undefined ? null : deviceNo,
      status: "active",
      loginAt: now,
      updatedAt: now,
    });
    updatedSessions.push(session);
    await runOperation({ workingMessage: "ログイン状態を保存中です…", actionName: "ログイン状態の保存" }, async () => {
      await saveLoginSessions(updatedSessions);
      await saveAssignmentsForTournament(tournament);
      state.globalMessage = { type: "success", message: "ログイン状態を保存しました。" };
      navigate("loginComplete", { sessionId: session.sessionId });
    });
  }

  function renderLoginComplete(sessionId) {
    const session = readLoginSessions().find((item) => item.sessionId === sessionId);
    if (!session) {
      navigate("loginStep1", {}, false);
      return;
    }
    const tournament = getTournamentById(session.tournamentId, { includeDeleted: true });
    const autoRefreshPanel = autoRefreshPanelHtml(session.tournamentId);
    const destination =
      session.loginRole === "hq"
        ? "大会本部としてログイン"
        : session.loginRole === "chief"
          ? "競技委員長としてログイン｜iPhone No.1（競技委員長固定）"
          : "競技委員としてログイン｜競技委員側カメラ画面へ接続予定";
    app.innerHTML = `
      <section class="completion-card">
        <div class="completion-icon">✓</div>
        <h2>${escapeHtml(session.roleLabel)}</h2>
        <p>${escapeHtml(destination)}</p>
        ${autoRefreshPanel}
        <div class="summary-grid">
          <dl class="summary-item">
            <dt>大会ID</dt>
            <dd>${escapeHtml(session.tournamentId)}</dd>
          </dl>
          <dl class="summary-item">
            <dt>大会名</dt>
            <dd>${escapeHtml(tournament ? tournamentDisplayName(tournament) : session.tournamentName || session.tournamentId)}</dd>
          </dl>
          <dl class="summary-item">
            <dt>ログイン者</dt>
            <dd>${escapeHtml(session.officerName)}</dd>
          </dl>
          <dl class="summary-item">
            <dt>iPhone No.</dt>
            <dd>${session.deviceNo ? `No.${escapeHtml(session.deviceNo)}${session.loginRole === "chief" ? "（競技委員長固定）" : ""}` : "割当なし"}</dd>
          </dl>
          <dl class="summary-item">
            <dt>ログイン時刻</dt>
            <dd>${escapeHtml(formatDateTime(session.loginAt))}</dd>
          </dl>
        </div>
        <div class="note-box">この画面は大会ログイン状態をFirestoreへ保存します。カメラ画面では同じ大会IDを入力して大会名と担当情報を読み取れます。</div>
        <div class="form-actions" style="justify-content:center; margin-top:20px;">
          <button id="toLogin" class="secondary-button" type="button">大会ログインへ</button>
          <button id="toHome" class="primary-button" type="button">メインメニューへ戻る</button>
        </div>
      </section>
    `;
    bindAutoRefreshToggle(session.tournamentId);
    syncAutoRefreshForLoginTournament(session.tournamentId);
    on("toLogin", "click", () => navigate("loginStep1"));
    on("toHome", "click", () => navigate("home", {}, false));
  }

  window.addEventListener("pagehide", unsubscribeAutoRefresh);

  bootstrap();
})();
