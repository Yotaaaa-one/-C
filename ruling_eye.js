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
    headquarters: "大会本部",
    chief: "競技委員長",
    officer: "競技委員",
  };

  const app = document.getElementById("app");

  const state = {
    route: "home",
    params: {},
    stack: [],
    rosterFilters: {
      category: "all",
      active: "active",
      query: "",
    },
    tournamentDraft: null,
    loginDraft: null,
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

  function readArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.warn(`localStorage read failed: ${key}`, error);
      return [];
    }
  }

  function writeArray(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function readOfficers() {
    return readArray(STORAGE_KEYS.officers);
  }

  function saveOfficers(officers) {
    writeArray(STORAGE_KEYS.officers, officers);
  }

  function readTournaments() {
    return readArray(STORAGE_KEYS.tournaments);
  }

  function saveTournaments(tournaments) {
    writeArray(STORAGE_KEYS.tournaments, tournaments);
  }

  function readLoginSessions() {
    return readArray(STORAGE_KEYS.loginSessions);
  }

  function saveLoginSessions(sessions) {
    writeArray(STORAGE_KEYS.loginSessions, sessions);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

  function categoryLabel(value) {
    return CATEGORY_OPTIONS.find((option) => option.value === value)?.label || value || "-";
  }

  function activeLabel(active) {
    return active ? "有効" : "無効";
  }

  function normalizeOfficer(officer) {
    return {
      officerId: officer.officerId,
      memberNo: officer.memberNo || "",
      kana: officer.kana || "",
      name: officer.name || officer.officerName || "",
      officerName: officer.officerName || officer.name || "",
      category: officer.category || "registered",
      categoryLabel: officer.categoryLabel || categoryLabel(officer.category || "registered"),
      active: officer.active !== false,
      note: officer.note || "",
      createdAt: officer.createdAt || nowIso(),
      updatedAt: officer.updatedAt || nowIso(),
    };
  }

  function getOfficerById(officerId) {
    return readOfficers().map(normalizeOfficer).find((officer) => officer.officerId === officerId) || null;
  }

  function getTournamentById(tournamentId) {
    return readTournaments().find((tournament) => tournament.tournamentId === tournamentId) || null;
  }

  function getActiveOfficers() {
    return readOfficers().map(normalizeOfficer).filter((officer) => officer.active);
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

  function setStatus(message, type = "") {
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.className = `status-message ${type}`.trim();
    el.textContent = message || "";
  }

  function getValue(id) {
    return document.getElementById(id)?.value.trim() || "";
  }

  function getSelectValue(id) {
    return document.getElementById(id)?.value || "";
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
    state.route = route;
    state.params = params;
    render();
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function goBack(fallback = "home") {
    const previous = state.stack.pop();
    if (previous) {
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

  function screenHeader(title, subtitle = "", backFallback = "home") {
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
        renderLoginStep1(state.params.year || "");
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
          <p>競技委員 映像裁定支援システム｜管理導線 Phase RE-1</p>
        </div>
        <div class="menu-grid">
          ${mainMenuButton("goRoster", "競技委員ロースター", "新規登録 / 一覧・修正")}
          ${mainMenuButton("goTournament", "大会設定", "新規登録 / 修正")}
          ${mainMenuButton("goLogin", "大会ログイン", "本部 / 委員長 / 競技委員")}
        </div>
        <div class="note-box">
          今回はlocalStorageで動作する管理フローです。カメラ映像、WebRTC、Firebase接続、認証はこの画面では実装していません。
        </div>
      </section>
    `;
    on("goRoster", "click", () => navigate("rosterMenu"));
    on("goTournament", "click", () => navigate("tournamentMenu"));
    on("goLogin", "click", () => navigate("loginStep1"));
  }

  function renderRosterMenu() {
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("競技委員ロースター", "新規登録、一覧確認、無効化を行います。")}
        <div class="menu-grid two">
          <button id="newOfficer" class="menu-button sub" type="button">新規登録</button>
          <button id="listOfficer" class="menu-button sub" type="button">一覧・修正</button>
        </div>
      </section>
    `;
    bindBack("home");
    on("newOfficer", "click", () => navigate("officerForm"));
    on("listOfficer", "click", () => navigate("rosterList"));
  }

  function renderOfficerForm(officerId) {
    const isEdit = Boolean(officerId);
    const officer = officerId ? getOfficerById(officerId) : null;
    const data = officer || {
      memberNo: "",
      kana: "",
      name: "",
      category: "specialist",
      active: true,
      note: "",
    };
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader(
          isEdit ? "競技委員ロースター｜修正" : "競技委員ロースター｜新規登録",
          "名前は必須、会員No.は未入力でも登録できます。",
          isEdit ? "rosterList" : "rosterMenu",
        )}
        <div class="form-grid">
          <div class="field">
            <label for="memberNo">会員No.</label>
            <input id="memberNo" type="text" inputmode="numeric" value="${escapeHtml(data.memberNo)}" placeholder="例: 12345">
            <span class="hint">未入力でも登録できます。</span>
          </div>
          <div class="field">
            <label for="kana">フリガナ</label>
            <input id="kana" type="text" value="${escapeHtml(data.kana)}" placeholder="例: ヤマダ タロウ">
          </div>
          <div class="field full">
            <label for="officerName">名前 <span class="badge red">必須</span></label>
            <input id="officerName" type="text" value="${escapeHtml(data.name)}" placeholder="例: 山田 太郎">
          </div>
          <div class="field">
            <label for="category">専門・登録区分</label>
            <select id="category">${optionsHtml(CATEGORY_OPTIONS, data.category)}</select>
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

  function saveOfficer(officerId) {
    const name = getValue("officerName");
    if (!name) {
      setStatus("名前を入力してください。", "error");
      return;
    }

    const officers = readOfficers().map(normalizeOfficer);
    const existingIndex = officerId ? officers.findIndex((officer) => officer.officerId === officerId) : -1;
    const now = nowIso();
    const category = getSelectValue("category") || "registered";
    const payload = {
      officerId: officerId || makeId("officer"),
      memberNo: getValue("memberNo"),
      kana: getValue("kana"),
      name,
      officerName: name,
      category,
      categoryLabel: categoryLabel(category),
      active: getSelectValue("active") !== "false",
      note: getValue("note"),
      createdAt: existingIndex >= 0 ? officers[existingIndex].createdAt : now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      officers[existingIndex] = payload;
    } else {
      officers.push(payload);
    }

    saveOfficers(officers);
    navigate("officerComplete", { officerId: payload.officerId, mode: existingIndex >= 0 ? "edit" : "new" });
  }

  function renderOfficerComplete(params) {
    const officer = getOfficerById(params.officerId);
    app.innerHTML = `
      <section class="completion-card">
        <div class="completion-icon">✓</div>
        <h2>${params.mode === "edit" ? "修正完了" : "登録完了"}</h2>
        <p>${escapeHtml(officer?.name || "")} を保存しました。</p>
        <div class="summary-grid">
          <dl class="summary-item">
            <dt>区分</dt>
            <dd>${escapeHtml(categoryLabel(officer?.category))}</dd>
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

  function renderRosterList() {
    const officers = readOfficers().map(normalizeOfficer);
    const filters = state.rosterFilters;
    const query = filters.query.toLowerCase();
    const filtered = officers.filter((officer) => {
      const categoryOk = filters.category === "all" || officer.category === filters.category;
      const activeOk =
        filters.active === "all" ||
        (filters.active === "active" && officer.active !== false) ||
        (filters.active === "inactive" && officer.active === false);
      const queryOk =
        !query ||
        [officer.name, officer.kana, officer.memberNo, officer.categoryLabel]
          .join(" ")
          .toLowerCase()
          .includes(query);
      return categoryOk && activeOk && queryOk;
    });

    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("競技委員ロースター｜一覧・修正", "名前をクリックすると修正画面へ移動します。", "rosterMenu")}
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
            <input id="filterQuery" type="search" value="${escapeHtml(filters.query)}" placeholder="名前、フリガナ、会員No.">
          </div>
        </div>
        ${
          filtered.length
            ? rosterTableHtml(filtered)
            : `<div class="empty-state">表示できる競技委員がいません。条件を変更するか、新規登録してください。</div>`
        }
        <div class="form-actions" style="margin-top:18px;">
          <button id="newOfficerFromList" class="primary-button" type="button">新規登録</button>
        </div>
      </section>
    `;
    bindBack("rosterMenu");
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
    onAll("[data-edit-officer]", "click", (event) => {
      navigate("officerForm", { officerId: event.currentTarget.dataset.editOfficer });
    });
  }

  function rosterTableHtml(officers) {
    return `
      <table class="list-table">
        <thead>
          <tr>
            <th>名前</th>
            <th>フリガナ</th>
            <th>会員No.</th>
            <th>区分</th>
            <th>有効/無効</th>
          </tr>
        </thead>
        <tbody>
          ${officers
            .map(
              (officer) => `
                <tr>
                  <td data-label="名前">
                    <button class="link-button" type="button" data-edit-officer="${escapeHtml(officer.officerId)}">${escapeHtml(officer.name)}</button>
                  </td>
                  <td data-label="フリガナ">${escapeHtml(officer.kana || "-")}</td>
                  <td data-label="会員No.">${escapeHtml(officer.memberNo || "-")}</td>
                  <td data-label="区分"><span class="badge">${escapeHtml(categoryLabel(officer.category))}</span></td>
                  <td data-label="有効/無効"><span class="badge ${officer.active !== false ? "green" : "gray"}">${escapeHtml(activeLabel(officer.active !== false))}</span></td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  function renderTournamentMenu() {
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会設定", "大会の年度、競技委員長、競技委員人数を設定します。")}
        <div class="menu-grid two">
          <button id="newTournament" class="menu-button sub" type="button">新規登録</button>
          <button id="editTournament" class="menu-button sub" type="button">修正</button>
        </div>
      </section>
    `;
    bindBack("home");
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
      tournamentName: tournament.tournamentName || "",
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
    const specialists = getActiveOfficers().filter((officer) => officer.category === "specialist");
    const chiefOptions = [
      ...specialists.map((officer) => ({ value: officer.officerId, label: `${officer.name}（専門）` })),
      { value: "other", label: "その他" },
    ];
    const chiefValue = draft.chiefOfficerId || "";
    const isOther = chiefValue === "other";
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader(
          `大会設定｜${mode === "edit" ? "修正" : "新規設定"} Step1`,
          "年度、大会名、人数、競技委員長を設定します。",
          "tournamentMenu",
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
          <div class="field full">
            <label for="chiefOfficerId">競技委員長 設定</label>
            <select id="chiefOfficerId">${optionsHtml(chiefOptions, chiefValue, "競技委員長を選択")}</select>
            <span class="hint">有効な「専門」競技委員を表示します。該当しない場合は「その他」を選択してください。</span>
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
      chiefOfficerName = officer?.name || "";
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
          "tournamentStep1",
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
        <strong>${escapeHtml(officer.name)}</strong>
        <span>${escapeHtml(categoryLabel(officer.category))}${locked ? "｜競技委員長（人数に含む）" : ""}</span>
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
        ${screenHeader(`大会設定｜${mode === "edit" ? "修正" : "新規設定"} 最終確認`, "内容を確認して保存してください。", "tournamentStep2")}
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
    const officers = readOfficers().map(normalizeOfficer);
    return Array.from(new Set(draft.selectedOfficerIds || []))
      .map((id) => officers.find((officer) => officer.officerId === id))
      .filter(Boolean)
      .map((officer) => ({
        officerId: officer.officerId,
        name: officer.name,
        category: officer.category,
        categoryLabel: categoryLabel(officer.category),
      }));
  }

  function tournamentSummaryHtml(draft, selectedOfficers, clickable = false) {
    const clickClass = clickable ? " clickable" : "";
    const attr = (target) => (clickable ? ` data-edit-target="${target}"` : "");
    return `
      <div class="summary-grid">
        <dl class="summary-item${clickClass}"${attr("step1")}>
          <dt>年度</dt>
          <dd>${escapeHtml(draft.year)}</dd>
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
          <dd>${selectedOfficers.length ? selectedOfficers.map((officer) => `${escapeHtml(officer.name)}（${escapeHtml(officer.categoryLabel)}）`).join("、") : "なし"}</dd>
        </dl>
      </div>
      ${
        clickable
          ? `<p class="hint" style="margin-top:12px;">クリックできる項目を選ぶと該当設定画面へ戻れます。修正後は再度確認画面に戻ります。</p>`
          : ""
      }
    `;
  }

  function saveTournament(mode) {
    const draft = state.tournamentDraft;
    if (!draft) return;
    const total = selectedTotalCount(draft);
    if (total !== Number(draft.officerCount)) {
      setStatus(`指定人数と選択済み人数が一致していません。現在 ${total}名 / 必要 ${draft.officerCount}名です。`, "error");
      return;
    }

    const tournaments = readTournaments();
    const existingIndex = draft.tournamentId
      ? tournaments.findIndex((tournament) => tournament.tournamentId === draft.tournamentId)
      : -1;
    const now = nowIso();
    const selectedOfficers = selectedOfficersFromDraft(draft);
    const payload = {
      tournamentId: draft.tournamentId || makeId("tournament"),
      year: draft.year,
      tournamentName: draft.tournamentName,
      officerCount: Number(draft.officerCount),
      chiefOfficerId: draft.chiefOfficerId === "other" ? "other" : draft.chiefOfficerId,
      chiefOfficerName: draft.chiefOfficerName,
      selectedOfficerIds: selectedOfficers.map((officer) => officer.officerId),
      selectedOfficers,
      active: true,
      createdAt: existingIndex >= 0 ? tournaments[existingIndex].createdAt : now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      tournaments[existingIndex] = payload;
    } else {
      tournaments.push(payload);
    }
    saveTournaments(tournaments);
    state.tournamentDraft = createTournamentDraft(payload);
    navigate("tournamentComplete", { tournamentId: payload.tournamentId, mode });
  }

  function renderTournamentComplete(params) {
    const tournament = getTournamentById(params.tournamentId);
    app.innerHTML = `
      <section class="completion-card">
        <div class="completion-icon">✓</div>
        <h2>設定完了</h2>
        <p>${escapeHtml(tournament?.tournamentName || "")} を保存しました。</p>
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
    const tournaments = readTournaments();
    const years = Array.from(new Set(tournaments.map((tournament) => tournament.year).filter(Boolean))).sort();
    const selectedYear = year || years[0] || "";
    const tournamentsInYear = tournaments.filter((tournament) => tournament.year === selectedYear);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会設定｜修正", "年度を選択すると登録済み大会が表示されます。", "tournamentMenu")}
        ${
          tournaments.length
            ? `
              <div class="form-grid">
                <div class="field">
                  <label for="editYear">年度</label>
                  <select id="editYear">${optionsHtml(years, selectedYear, "年度を選択")}</select>
                </div>
                <div class="field">
                  <label for="editTournamentId">大会名</label>
                  <select id="editTournamentId">${optionsHtml(
                    tournamentsInYear.map((tournament) => ({ value: tournament.tournamentId, label: tournament.tournamentName })),
                    "",
                    "大会を選択",
                  )}</select>
                </div>
              </div>
              <p id="statusMessage" class="status-message"></p>
              <div class="next-actions">
                <button id="loadTournamentEdit" class="primary-button" type="button">修正 ⇒</button>
              </div>
            `
            : `<div class="empty-state">登録済み大会がありません。先に大会設定の新規登録を行ってください。</div>`
        }
      </section>
    `;
    bindBack("tournamentMenu");
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
  }

  function renderTournamentEditReview() {
    const draft = state.tournamentDraft;
    if (!draft) {
      navigate("tournamentEditSelect", {}, false);
      return;
    }
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会設定｜修正 設定確認", "クリックできる項目から修正画面へ戻れます。", "tournamentEditSelect")}
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

  function renderLoginStep1(year = "") {
    const tournaments = readTournaments().filter((tournament) => tournament.active !== false);
    const years = Array.from(new Set(tournaments.map((tournament) => tournament.year).filter(Boolean))).sort();
    const selectedYear = year || years[0] || "";
    const tournamentsInYear = tournaments.filter((tournament) => tournament.year === selectedYear);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン", "年度と大会名を選択してログインに進みます。")}
        ${
          tournaments.length
            ? `
              <div class="form-grid">
                <div class="field">
                  <label for="loginYear">年度</label>
                  <select id="loginYear">${optionsHtml(years, selectedYear, "年度を選択")}</select>
                </div>
                <div class="field">
                  <label for="loginTournamentId">大会名</label>
                  <select id="loginTournamentId">${optionsHtml(
                    tournamentsInYear.map((tournament) => ({ value: tournament.tournamentId, label: tournament.tournamentName })),
                    "",
                    "大会を選択",
                  )}</select>
                </div>
              </div>
              <p id="statusMessage" class="status-message"></p>
              <div class="next-actions">
                <button id="loginTournament" class="primary-button" type="button">ログイン</button>
              </div>
            `
            : `<div class="empty-state">登録済み大会がありません。先に大会設定を行ってください。</div>`
        }
      </section>
    `;
    bindBack("home");
    on("loginYear", "change", () => navigate("loginStep1", { year: getSelectValue("loginYear") }, false));
    on("loginTournament", "click", () => {
      const tournamentId = getSelectValue("loginTournamentId");
      if (!tournamentId) {
        setStatus("大会名を選択してください。", "error");
        return;
      }
      state.loginDraft = { tournamentId };
      navigate("loginRole");
    });
  }

  function renderLoginRole() {
    const tournament = getTournamentById(state.loginDraft?.tournamentId);
    if (!tournament) {
      navigate("loginStep1", {}, false);
      return;
    }
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン｜ログイン者選択", tournament.tournamentName, "loginStep1")}
        <div class="choice-list">
          <button id="loginHeadquarters" class="choice-button" type="button">
            <strong>大会本部</strong>
            <span>iPhone No.1 固定</span>
          </button>
          <button id="loginChief" class="choice-button" type="button">
            <strong>競技委員長</strong>
            <span>${escapeHtml(tournament.chiefOfficerName || "未設定")}</span>
          </button>
          <button id="loginOfficer" class="choice-button" type="button">
            <strong>競技委員</strong>
            <span>設定済み競技委員から選択</span>
          </button>
        </div>
        <p id="statusMessage" class="status-message"></p>
      </section>
    `;
    bindBack("loginStep1");
    on("loginHeadquarters", "click", () => createLoginSession({
      tournament,
      role: "headquarters",
      officerId: null,
      officerName: "大会本部",
      iphoneNo: 1,
    }));
    on("loginChief", "click", () => createLoginSession({
      tournament,
      role: "chief",
      officerId: tournament.chiefOfficerId === "other" ? null : tournament.chiefOfficerId,
      officerName: tournament.chiefOfficerName,
      iphoneNo: null,
    }));
    on("loginOfficer", "click", () => navigate("loginOfficerSelect"));
  }

  function renderLoginOfficerSelect() {
    const tournament = getTournamentById(state.loginDraft?.tournamentId);
    if (!tournament) {
      navigate("loginStep1", {}, false);
      return;
    }
    const selectedOfficers = Array.isArray(tournament.selectedOfficers) ? tournament.selectedOfficers : [];
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン｜競技委員選択", tournament.tournamentName, "loginRole")}
        ${
          selectedOfficers.length
            ? `<div class="choice-list">
                ${selectedOfficers
                  .map(
                    (officer) => `
                      <button class="choice-button" type="button" data-login-officer="${escapeHtml(officer.officerId)}">
                        <strong>${escapeHtml(officer.name)}</strong>
                        <span>${escapeHtml(officer.categoryLabel || categoryLabel(officer.category))}</span>
                      </button>
                    `,
                  )
                  .join("")}
              </div>`
            : `<div class="empty-state">この大会に選択済みの競技委員がいません。大会設定を確認してください。</div>`
        }
      </section>
    `;
    bindBack("loginRole");
    onAll("[data-login-officer]", "click", (event) => {
      const officerId = event.currentTarget.dataset.loginOfficer;
      const officer = selectedOfficers.find((item) => item.officerId === officerId);
      state.loginDraft = {
        ...state.loginDraft,
        officerId,
        officerName: officer?.name || "",
      };
      navigate("loginPhoneSelect");
    });
  }

  function renderLoginPhoneSelect() {
    const tournament = getTournamentById(state.loginDraft?.tournamentId);
    if (!tournament || !state.loginDraft?.officerId) {
      navigate("loginStep1", {}, false);
      return;
    }
    const usedPhones = usedIphoneNumbers(tournament.tournamentId);
    app.innerHTML = `
      <section class="screen-card">
        ${screenHeader("大会ログイン｜iPhone No.選択", `${state.loginDraft.officerName}｜${tournament.tournamentName}`, "loginOfficerSelect")}
        <div class="phone-grid">
          ${[2, 3, 4, 5, 6, 7]
            .map((number) => {
              const used = usedPhones.has(number);
              return `
                <button class="phone-button ${used ? "disabled" : ""}" type="button" data-phone-no="${number}" ${used ? "disabled" : ""}>
                  <strong>iPhone No.${number}</strong>
                  <span>${used ? "使用中" : "選択可能"}</span>
                </button>
              `;
            })
            .join("")}
        </div>
        <p id="statusMessage" class="status-message"></p>
      </section>
    `;
    bindBack("loginOfficerSelect");
    onAll("[data-phone-no]", "click", (event) => {
      const iphoneNo = Number(event.currentTarget.dataset.phoneNo);
      if (usedIphoneNumbers(tournament.tournamentId).has(iphoneNo)) {
        setStatus(`iPhone No.${iphoneNo} は使用中です。別の番号を選択してください。`, "error");
        return;
      }
      createLoginSession({
        tournament,
        role: "officer",
        officerId: state.loginDraft.officerId,
        officerName: state.loginDraft.officerName,
        iphoneNo,
      });
    });
  }

  function usedIphoneNumbers(tournamentId) {
    return new Set(
      readLoginSessions()
        .filter((session) => session.tournamentId === tournamentId && session.iphoneNo !== null && session.iphoneNo !== undefined)
        .map((session) => Number(session.iphoneNo)),
    );
  }

  function createLoginSession({ tournament, role, officerId, officerName, iphoneNo }) {
    if (iphoneNo !== null && iphoneNo !== undefined && usedIphoneNumbers(tournament.tournamentId).has(Number(iphoneNo))) {
      setStatus(`iPhone No.${iphoneNo} は使用中です。`, "error");
      return;
    }

    const session = {
      sessionId: makeId("login"),
      tournamentId: tournament.tournamentId,
      tournamentName: tournament.tournamentName,
      role,
      roleLabel: ROLE_LABELS[role] || role,
      officerId,
      officerName,
      iphoneNo,
      loginAt: nowIso(),
    };
    const sessions = readLoginSessions();
    sessions.push(session);
    saveLoginSessions(sessions);
    navigate("loginComplete", { sessionId: session.sessionId });
  }

  function renderLoginComplete(sessionId) {
    const session = readLoginSessions().find((item) => item.sessionId === sessionId);
    if (!session) {
      navigate("loginStep1", {}, false);
      return;
    }
    const destination =
      session.role === "headquarters"
        ? "運営側カメラ画面へ接続予定"
        : session.role === "chief"
          ? "競技委員長画面へ接続予定"
          : "競技委員側カメラ画面へ接続予定";
    app.innerHTML = `
      <section class="completion-card">
        <div class="completion-icon">✓</div>
        <h2>${escapeHtml(session.roleLabel)}</h2>
        <p>${escapeHtml(destination)}</p>
        <div class="summary-grid">
          <dl class="summary-item">
            <dt>大会名</dt>
            <dd>${escapeHtml(session.tournamentName)}</dd>
          </dl>
          <dl class="summary-item">
            <dt>ログイン者</dt>
            <dd>${escapeHtml(session.officerName)}</dd>
          </dl>
          <dl class="summary-item">
            <dt>iPhone No.</dt>
            <dd>${session.iphoneNo ? `No.${escapeHtml(session.iphoneNo)}` : "-"}</dd>
          </dl>
          <dl class="summary-item">
            <dt>ログイン時刻</dt>
            <dd>${escapeHtml(formatDateTime(session.loginAt))}</dd>
          </dl>
        </div>
        <div class="note-box">Phase RE-1では仮画面です。実際のカメラ・WebRTC・Firebase接続は今後のフェーズで接続します。</div>
        <div class="form-actions" style="justify-content:center; margin-top:20px;">
          <button id="toLogin" class="secondary-button" type="button">大会ログインへ</button>
          <button id="toHome" class="primary-button" type="button">メインメニューへ戻る</button>
        </div>
      </section>
    `;
    on("toLogin", "click", () => navigate("loginStep1"));
    on("toHome", "click", () => navigate("home", {}, false));
  }

  render();
})();
