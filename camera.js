/* global firebase */
(() => {
  'use strict';

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const QUALITY_MODES = {
    low: { label: '通信優先', width: 640, height: 360, frameRate: 15 },
    standard: { label: '標準', width: 854, height: 480, frameRate: 20 },
    high: { label: '高画質', width: 1280, height: 720, frameRate: 24 }
  };
  const $ = (id) => document.getElementById(id);
  const isOfficerPage = document.body.classList.contains('camera-officer-page');
  const serverTime = () => firebase.firestore.FieldValue.serverTimestamp();

  function readFirebaseConfig() {
    // firebase-config.js 側は window.CAMERA_FIREBASE_CONFIG / window.firebaseConfig のどちらでも利用可能です。
    // 既存ファイルがトップレベル const firebaseConfig を使う構成にも対応します。
    return window.CAMERA_FIREBASE_CONFIG || window.FIREBASE_CONFIG || window.__firebase_config || window.firebaseConfig ||
      (typeof firebaseConfig !== 'undefined' ? firebaseConfig : null);
  }

  function createFirebase() {
    if (!window.firebase) throw new Error('Firebase SDKを読み込めませんでした。ネットワーク接続を確認してください。');
    const config = readFirebaseConfig();
    if (!config && !firebase.apps.length) {
      throw new Error('Firebase設定が見つかりません。既存の firebase-config.js で window.CAMERA_FIREBASE_CONFIG（または firebaseConfig）を公開してください。');
    }
    if (!firebase.apps.length) firebase.initializeApp(config);
    return firebase.firestore();
  }

  function cleanTournamentId(value) { return value.trim().replaceAll('/', '-'); }
  function qualityText(mode) {
    const quality = QUALITY_MODES[mode] || QUALITY_MODES.standard;
    return `${quality.label} ${quality.width}×${quality.height} / ${quality.frameRate}fps`;
  }
  function qualityConstraints(mode, { fallback = false } = {}) {
    if (fallback) return { video: true, audio: true };
    const quality = QUALITY_MODES[mode] || QUALITY_MODES.standard;
    return {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: quality.width, max: quality.width },
        height: { ideal: quality.height, max: quality.height },
        frameRate: { ideal: quality.frameRate, max: quality.frameRate }
      },
      audio: true
    };
  }
  function getPersistentOfficerId() {
    const key = 'ruling-eye-officer-id';
    try {
      let officerId = localStorage.getItem(key);
      if (!officerId) {
        const randomPart = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        officerId = `officer-${randomPart}`;
        localStorage.setItem(key, officerId);
      }
      return officerId;
    } catch (_) {
      return `officer-${window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    }
  }
  function deviceType() { return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'iOS' : 'web'; }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
  function formatTime(timestamp) {
    if (!timestamp) return '時刻を取得中';
    const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  }
  function formatDateTime(timestamp) {
    if (!timestamp) return '-';
    const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date);
  }
  function roleLabel(role) {
    return { hq: '大会本部', headquarters: '大会本部', chief: '競技委員長', officer: '競技委員' }[role] || role || '-';
  }
  function activeLoginSessions(sessions) {
    return sessions.filter((session) => session.status === 'active');
  }
  function rulingEyeReadErrorMessage(error) {
    const detail = error?.message || String(error || '');
    const permissionHint = /permission|PERMISSION_DENIED|Missing or insufficient permissions/i.test(detail)
      ? ' Firestoreルールで読み取りが許可されていない可能性があります。'
      : '';
    return `Ruling Eye管理情報の読み込みに失敗しました。大会IDとFirestoreルールを確認してください。${permissionHint}`;
  }
  function sessionRef(db, tournamentId, sessionId) { return db.collection('tournaments').doc(tournamentId).collection('camera_sessions').doc(sessionId); }
  function closePeer(peer) { if (peer) { peer.onicecandidate = null; peer.ontrack = null; peer.close(); } }

  function showError(element, message) { element.textContent = message; element.hidden = !message; }
  function setStatus(element, message, tone = 'idle') { element.textContent = message; element.dataset.tone = tone; }
  function setPlaceholderVisible(placeholder, visible, message) {
    if (message) placeholder.textContent = message;
    placeholder.hidden = !visible;
    placeholder.classList.toggle('is-hidden', !visible);
  }
  function createDebugReporter(element) {
    const states = new Map();
    return (key, message) => {
      states.set(key, message);
      element.replaceChildren();
      states.forEach((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        element.append(item);
      });
    };
  }
  function requestVideoPlayback(video, { mutedFallback = false } = {}) {
    const play = async () => {
      try {
        await video.play();
        return true;
      } catch (error) {
        if (!mutedFallback || video.muted) return false;
        video.muted = true;
        try { await video.play(); return true; } catch (_) { return false; }
      }
    };
    // iPhone Safari は srcObject 設定直後より metadata 読込後の play() が安定します。
    video.addEventListener('loadedmetadata', () => { play(); }, { once: true });
    return play();
  }

  async function startOfficer() {
    const tournamentInput = $('tournamentId');
    const nameInput = $('officerName');
    const holeInput = $('hole');
    const groupInput = $('groupNo');
    const startButton = $('startCallButton');
    const endButton = $('endCallButton');
    const micButton = $('micButton');
    const retryCameraButton = $('retryCameraButton');
    const qualitySummary = $('qualitySummary');
    const qualityButtons = [...document.querySelectorAll('[data-quality-mode]')];
    const startWaitingButton = $('startWaitingButton');
    const stopWaitingButton = $('stopWaitingButton');
    const waitingState = $('waitingState');
    const incomingCallPanel = $('incomingCallPanel');
    const incomingCallTournament = $('incomingCallTournament');
    const incomingCallTarget = $('incomingCallTarget');
    const incomingCallLocation = $('incomingCallLocation');
    const incomingCallReason = $('incomingCallReason');
    const acceptCallButton = $('acceptCallButton');
    const declineCallButton = $('declineCallButton');
    const deviceNoSelect = $('deviceNoSelect');
    const saveDeviceButton = $('saveDeviceButton');
    const checkAssignmentButton = $('checkAssignmentButton');
    const assignmentDisplay = $('assignmentDisplay');
    const loadRulingEyeDeviceButton = $('loadRulingEyeDeviceButton');
    const rulingEyeDeviceStatus = $('rulingEyeDeviceStatus');
    const rulingEyeDeviceSummary = $('rulingEyeDeviceSummary');
    const status = $('connectionStatus');
    const error = $('cameraError');
    const video = $('localVideo');
    const placeholder = $('previewPlaceholder');
    const debug = createDebugReporter($('officerDebug'));
    let db;
    let localStream;
    let peer;
    let activeSession;
    let unsubscribeSession;
    let unsubscribeAnswerCandidates;
    let qualityMode = 'standard';
    let usedCameraFallback = false;
    const officerId = getPersistentOfficerId();
    let officerRef;
    let waitingTournamentId = '';
    let waitingHeartbeat;
    let waitingActive = false;
    let unsubscribeIncomingCalls;
    let incomingCall;
    let activeCallRef;
    let assignmentRef;
    let assignmentData;
    let currentRulingEyeDevice = null;
    let deviceNo = (() => {
      try {
        return localStorage.getItem('rulingEyeCameraDeviceNo') || localStorage.getItem('ruling-eye-device-no') || '1';
      } catch (_) {
        return '1';
      }
    })();
    if (!['1', '2', '3', '4', '5', '6', '7'].includes(String(deviceNo))) deviceNo = '1';
    const launchParams = new URLSearchParams(window.location.search);
    const launchTournamentId = cleanTournamentId(launchParams.get('tournamentId') || '');
    const launchDeviceNo = String(launchParams.get('deviceNo') || '');
    if (launchTournamentId) tournamentInput.value = launchTournamentId;
    if (['1', '2', '3', '4', '5', '6', '7'].includes(launchDeviceNo)) {
      deviceNo = launchDeviceNo;
      try {
        localStorage.setItem('rulingEyeCameraDeviceNo', deviceNo);
        localStorage.setItem('ruling-eye-device-no', deviceNo);
      } catch (_) { /* private mode fallback */ }
    }
    debug('camera', 'カメラ取得待機中');
    debug('hq', '本部未接続');

    function setQualityModeUi() {
      qualitySummary.textContent = qualityText(qualityMode);
      qualityButtons.forEach((button) => {
        const selected = button.dataset.qualityMode === qualityMode;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      debug('quality', `使用中画質モード: ${qualityText(qualityMode)}`);
    }
    function setQualityButtonsDisabled(disabled) {
      qualityButtons.forEach((button) => { button.disabled = disabled; });
    }
    function setWaitingUi(state) {
      const online = state === 'online';
      const busy = state === 'busy';
      waitingState.textContent = busy ? '映像共有中' : online ? '本部からの映像依頼を待機中' : '待機停止中';
      waitingState.dataset.state = busy ? 'calling' : online ? 'connected' : 'idle';
      startWaitingButton.disabled = online || busy;
      stopWaitingButton.disabled = !online;
      const deviceHero = rulingEyeDeviceSummary?.querySelector('.ruling-eye-device-hero');
      const deviceHeroState = deviceHero?.querySelector('em');
      if (deviceHero && deviceHeroState && currentRulingEyeDevice) {
        deviceHero.dataset.state = 'ready';
        deviceHeroState.textContent = busy
          ? '状態: 映像共有中'
          : online
            ? '状態: 本部呼出待機中'
            : '状態: 待機可能';
      }
    }
    function usableOfficerId(value) {
      const normalized = String(value || '').trim();
      return normalized && normalized.toLowerCase() !== 'other' ? normalized : '';
    }
    function stableRulingEyeOfficerId() {
      const currentId = usableOfficerId(currentRulingEyeDevice?.officerId);
      if (currentId) return currentId;
      const sessionId = String(currentRulingEyeDevice?.sessionId || '').trim().replaceAll('/', '-');
      if (sessionId) return `session_${sessionId}`;
      return `device_${String(currentRulingEyeDevice?.deviceNo || deviceNo || 'unknown')}`;
    }
    function assignedOfficerId() {
      return currentRulingEyeDevice ? stableRulingEyeOfficerId() : assignmentData?.officerId || officerId;
    }
    function assignedOfficerName() {
      return currentRulingEyeDevice?.officerName || assignmentData?.officerName || nameInput.value.trim();
    }
    function currentAssignmentId() {
      return currentRulingEyeDevice?.assignmentId || assignmentData?.id || '';
    }
    function currentLoginIdentity() {
      if (!currentRulingEyeDevice) {
        return {
          tournamentName: '',
          loginRole: '',
          roleLabel: '',
          loginSessionId: '',
          assignmentId: assignmentData?.id || '',
          source: 'manual'
        };
      }
      return {
        tournamentName: currentRulingEyeDevice.tournamentName,
        loginRole: currentRulingEyeDevice.loginRole,
        roleLabel: currentRulingEyeDevice.roleLabel,
        loginSessionId: currentRulingEyeDevice.sessionId,
        assignmentId: currentRulingEyeDevice.assignmentId,
        source: 'ruling_eye_login'
      };
    }
    function assignmentStatusDisplay(message, tone = '') {
      assignmentDisplay.textContent = message;
      assignmentDisplay.dataset.tone = tone;
    }
    function setRulingEyeDeviceStatus(message, tone = '') {
      if (!rulingEyeDeviceStatus) return;
      rulingEyeDeviceStatus.textContent = message;
      rulingEyeDeviceStatus.dataset.tone = tone;
    }
    function renderRulingEyeDeviceIdle(message = '端末情報未読込', state = 'idle') {
      if (!rulingEyeDeviceSummary) return;
      rulingEyeDeviceSummary.innerHTML = `
        <div class="ruling-eye-device-hero" data-state="${escapeHtml(state)}">
          <span>この端末: iPhone No.${escapeHtml(deviceNo)}</span>
          <strong>担当: ${escapeHtml(message)}</strong>
          <small>役割: ${String(deviceNo) === '1' ? '競技委員長' : '競技委員'}</small>
          <em>状態: 読込待ち</em>
        </div>
      `;
    }
    function renderRulingEyeDeviceSummary(data) {
      if (!rulingEyeDeviceSummary) return;
      const setting = data.setting || {};
      const loadedAt = formatDateTime(data.loadedAt);
      if (!data.settingExists) {
        currentRulingEyeDevice = null;
        setRulingEyeDeviceStatus('この大会IDのRuling Eye大会設定が見つかりません。ruling_eye.html で大会設定を作成してください。', 'error');
        rulingEyeDeviceSummary.innerHTML = `
          <div class="ruling-eye-device-hero" data-state="error">
            <span>この端末: iPhone No.${escapeHtml(deviceNo)}</span>
            <strong>担当: 未設定</strong>
            <small>役割: ${String(deviceNo) === '1' ? '競技委員長' : '競技委員'}</small>
            <em>状態: 大会設定なし</em>
          </div>
        `;
        return;
      }
      if (setting.deleted === true) {
        currentRulingEyeDevice = null;
        setRulingEyeDeviceStatus('この大会設定は削除済みです。', 'warning');
        rulingEyeDeviceSummary.innerHTML = `
          <div class="ruling-eye-device-hero" data-state="error">
            <span>この端末: iPhone No.${escapeHtml(deviceNo)}</span>
            <strong>担当: 未設定</strong>
            <small>役割: ${String(deviceNo) === '1' ? '競技委員長' : '競技委員'}</small>
            <em>状態: 大会削除済み</em>
          </div>
        `;
        return;
      }
      const login = data.loginSession || null;
      if (login) {
        const assignment = data.assignment || null;
        const currentRoleLabel = String(deviceNo) === '1' ? '競技委員長' : roleLabel(login.loginRole);
        currentRulingEyeDevice = {
          tournamentId: data.tournamentId,
          tournamentName: setting.tournamentName || login.tournamentName || data.tournamentId,
          deviceNo: String(deviceNo),
          loginRole: login.loginRole || '',
          roleLabel: currentRoleLabel,
          officerId: login.officerId || '',
          officerName: login.officerName || '',
          sessionId: login.sessionId || login.id || '',
          assignmentId: login.assignmentId || assignment?.assignmentId || assignment?.id || ''
        };
        nameInput.value = currentRulingEyeDevice.officerName || nameInput.value;
        setRulingEyeDeviceStatus('Ruling Eye端末情報を読み込みました。待機開始できます。', 'success');
      } else {
        currentRulingEyeDevice = null;
        const guidance = String(deviceNo) === '1'
          ? 'このiPhone No.1 は競技委員長ログインがまだ行われていません。ruling_eye.html の大会ログインで競技委員長ログインを行ってください。'
          : 'このiPhone No.は本大会でログインされていません。ruling_eye.html の大会ログインから設定してください。';
        setRulingEyeDeviceStatus(guidance, 'warning');
      }
      const officerName = currentRulingEyeDevice?.officerName || '-';
      const loginKind = currentRulingEyeDevice?.roleLabel || (String(deviceNo) === '1' ? '競技委員長' : '競技委員');
      const loginState = login ? 'ログイン済み' : '未ログイン';
      rulingEyeDeviceSummary.innerHTML = `
        <div class="ruling-eye-device-hero" data-state="${login ? 'ready' : 'offline'}">
          <span>この端末: iPhone No.${escapeHtml(deviceNo)}</span>
          <strong>担当: ${escapeHtml(officerName)}</strong>
          <small>役割: ${escapeHtml(loginKind)}</small>
          <em>状態: ${login ? '待機可能' : '未ログイン'}</em>
        </div>
        <div class="ruling-eye-info-card"><span>大会ID</span><strong>${escapeHtml(data.tournamentId)}</strong></div>
        <div class="ruling-eye-info-card"><span>大会名</span><strong>${escapeHtml(setting.tournamentName || data.tournamentId)}</strong></div>
        <div class="ruling-eye-info-card"><span>この端末</span><strong>iPhone No.${escapeHtml(deviceNo)}</strong></div>
        <div class="ruling-eye-info-card"><span>担当者</span><strong>${escapeHtml(officerName)}</strong></div>
        <div class="ruling-eye-info-card"><span>ログイン種別</span><strong>${escapeHtml(loginKind)}</strong></div>
        <div class="ruling-eye-info-card"><span>読込状態</span><strong>${escapeHtml(loginState)}</strong></div>
        <div class="ruling-eye-info-card"><span>最終読込</span><strong>${escapeHtml(loadedAt)}</strong></div>
      `;
    }
    async function loadRulingEyeCameraOfficerData() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      const selectedDeviceNo = String(deviceNoSelect.value || deviceNo || '1');
      deviceNo = selectedDeviceNo;
      try {
        localStorage.setItem('rulingEyeCameraDeviceNo', deviceNo);
        localStorage.setItem('ruling-eye-device-no', deviceNo);
      } catch (_) { /* private mode fallback */ }
      showError(error, '');
      if (!tournamentId) {
        setRulingEyeDeviceStatus('大会IDを入力してください。', 'error');
        return null;
      }
      try {
        db = db || createFirebase();
        if (loadRulingEyeDeviceButton) loadRulingEyeDeviceButton.disabled = true;
        setRulingEyeDeviceStatus('Ruling Eye端末情報を読み込み中です…');
        const tournamentRef = db.collection('tournaments').doc(tournamentId);
        const [settingsDoc, sessionsSnapshot, assignmentsSnapshot] = await Promise.all([
          tournamentRef.collection('ruling_eye_settings').doc('main').get(),
          tournamentRef.collection('ruling_eye_login_sessions').get(),
          tournamentRef.collection('camera_assignments').get()
        ]);
        const sessions = sessionsSnapshot.docs.map((doc) => ({ id: doc.id, sessionId: doc.id, ...doc.data() }));
        const assignments = assignmentsSnapshot.docs.map((doc) => ({
          id: doc.id,
          assignmentId: doc.id,
          ref: doc.ref,
          ...doc.data()
        }));
        const loginSession = activeLoginSessions(sessions)
          .filter((session) => String(session.deviceNo || '') === String(deviceNo))
          .filter((session) => ['chief', 'officer'].includes(session.loginRole))
          .sort((a, b) => {
            const aTime = a.loginAt?.toMillis?.() || new Date(a.loginAt || 0).getTime() || 0;
            const bTime = b.loginAt?.toMillis?.() || new Date(b.loginAt || 0).getTime() || 0;
            return bTime - aTime;
          })[0] || null;
        const assignment = assignments.find((item) => loginSession?.officerId && item.officerId === loginSession.officerId)
          || assignments.find((item) => String(item.deviceNo || '') === String(deviceNo))
          || null;
        assignmentData = assignment ? { ...assignment } : null;
        assignmentRef = assignment?.ref || null;
        const data = {
          tournamentId,
          settingExists: settingsDoc.exists,
          setting: settingsDoc.exists ? settingsDoc.data() : null,
          loginSessions: sessions,
          loginSession,
          assignment,
          loadedAt: new Date()
        };
        renderRulingEyeDeviceSummary(data);
        return data;
      } catch (readError) {
        console.error('Ruling Eye officer data read failed', readError);
        currentRulingEyeDevice = null;
        renderRulingEyeDeviceIdle('読込失敗', 'error');
        const message = rulingEyeReadErrorMessage(readError);
        setRulingEyeDeviceStatus(message, 'error');
        showError(error, message);
        return null;
      } finally {
        if (loadRulingEyeDeviceButton) loadRulingEyeDeviceButton.disabled = false;
      }
    }
    async function loadAssignment() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      assignmentData = null;
      assignmentRef = null;
      if (!tournamentId) { assignmentStatusDisplay('大会IDを入力して割当確認してください。'); return null; }
      try {
        db = db || createFirebase();
        const snapshot = await db.collection('tournaments').doc(tournamentId).collection('camera_assignments').where('deviceNo', '==', String(deviceNo)).get();
        const assignmentDoc = snapshot.docs[0];
        if (!assignmentDoc) {
          assignmentStatusDisplay(`この端末（iPhone No.${deviceNo}）は本大会に割り当てられていません。`, 'error');
          return null;
        }
        assignmentRef = assignmentDoc.ref;
        assignmentData = { id: assignmentDoc.id, ...assignmentDoc.data() };
        nameInput.value = assignmentData.officerName || nameInput.value;
        assignmentStatusDisplay(`この端末: iPhone No.${deviceNo} / 本日の担当: ${assignmentData.officerName || '未設定'}（${assignmentData.category === 'specialist' ? '専門競技委員' : '登録競技委員'}）`);
        return assignmentData;
      } catch (assignmentError) {
        showError(error, `大会割当を確認できませんでした: ${assignmentError.message}`);
        return null;
      }
    }
    async function updateOfficerStatus(status, extra = {}) {
      if (!officerRef) return;
      await officerRef.set({ status, lastSeen: serverTime(), updatedAt: serverTime(), ...extra }, { merge: true });
      if (assignmentRef) {
        const assignmentStatus = {
          status,
          lastSeen: serverTime(),
          updatedAt: serverTime()
        };
        ['currentSessionId', 'qualityMode', 'qualityLabel', 'deviceNo'].forEach((key) => {
          if (extra[key] !== undefined) assignmentStatus[key] = extra[key];
        });
        await assignmentRef.set(assignmentStatus, { merge: true });
      }
      setWaitingUi(status);
    }
    function hideIncomingCall() {
      incomingCallPanel.hidden = true;
      incomingCall = null;
    }
    function showIncomingCall(call) {
      if (activeSession) return;
      incomingCall = call;
      if (incomingCallTournament) {
        incomingCallTournament.textContent = `大会名: ${call.tournamentName || currentRulingEyeDevice?.tournamentName || waitingTournamentId || '-'}`;
      }
      if (incomingCallTarget) {
        incomingCallTarget.textContent = `対象: No.${call.deviceNo || currentRulingEyeDevice?.deviceNo || deviceNo} ${call.targetOfficerName || currentRulingEyeDevice?.officerName || assignedOfficerName() || '-'}`;
      }
      incomingCallLocation.textContent = `${call.hole || '-'}H / ${call.groupNo || '-'}組`;
      incomingCallReason.textContent = `理由: ${call.reason || '本部確認'}`;
      incomingCallPanel.hidden = false;
    }
    function requestedCallMatches(call, effectiveOfficerId, effectiveOfficerName) {
      if (call.status !== 'requested') return false;
      const current = currentRulingEyeDevice;
      const matches = (left, right) => Boolean(String(left || '').trim() && String(right || '').trim() && String(left) === String(right));
      const rulingEyeMatch = current && (
        matches(call.targetOfficerId, current.officerId)
        || matches(call.deviceNo, current.deviceNo)
        || matches(call.loginSessionId, current.sessionId)
        || matches(call.assignmentId, current.assignmentId)
      );
      const manualMatch = matches(call.targetOfficerId, effectiveOfficerId)
        || matches(call.deviceNo, deviceNo)
        || matches(call.targetOfficerName, effectiveOfficerName);
      return Boolean(rulingEyeMatch || manualMatch);
    }
    async function startWaiting() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      deviceNo = String(deviceNoSelect.value || deviceNo || '1');
      if (!currentRulingEyeDevice
          || currentRulingEyeDevice.tournamentId !== tournamentId
          || currentRulingEyeDevice.deviceNo !== deviceNo) {
        await loadRulingEyeCameraOfficerData();
      }
      if (!currentRulingEyeDevice && !assignmentData) await loadAssignment();
      const officerName = assignedOfficerName();
      const effectiveOfficerId = assignedOfficerId();
      const identity = currentLoginIdentity();
      showError(error, '');
      if (!tournamentId || !officerName) {
        showError(error, '待機開始には大会IDと競技委員名を入力してください。');
        return;
      }
      try {
        db = db || createFirebase();
        if (unsubscribeIncomingCalls) unsubscribeIncomingCalls();
        if (waitingHeartbeat) clearInterval(waitingHeartbeat);
        waitingTournamentId = tournamentId;
        officerRef = db.collection('tournaments').doc(tournamentId).collection('camera_officers').doc(effectiveOfficerId);
        const existingOfficer = await officerRef.get();
        const officerData = {
          officerId: effectiveOfficerId,
          officerName,
          tournamentId,
          tournamentName: identity.tournamentName || tournamentId,
          deviceNo: String(deviceNo),
          loginRole: identity.loginRole,
          roleLabel: identity.roleLabel,
          loginSessionId: identity.loginSessionId,
          assignmentId: identity.assignmentId || currentAssignmentId(),
          source: identity.source,
          status: activeSession ? 'busy' : 'online',
          currentSessionId: activeSession?.id || '',
          qualityMode, qualityLabel: QUALITY_MODES[qualityMode].label, lastSeen: serverTime(),
          updatedAt: serverTime(), deviceType: deviceType()
        };
        if (!existingOfficer.exists) officerData.createdAt = serverTime();
        await officerRef.set(officerData, { merge: true });
        waitingActive = true;
        await updateOfficerStatus(activeSession ? 'busy' : 'online', {
          currentSessionId: activeSession?.id || '',
          officerName,
          tournamentId,
          tournamentName: identity.tournamentName || tournamentId,
          deviceNo: String(deviceNo),
          loginRole: identity.loginRole,
          roleLabel: identity.roleLabel,
          loginSessionId: identity.loginSessionId,
          assignmentId: identity.assignmentId || currentAssignmentId(),
          source: identity.source,
          qualityMode,
          qualityLabel: QUALITY_MODES[qualityMode].label
        });
        waitingHeartbeat = setInterval(() => {
          updateOfficerStatus(activeSession ? 'busy' : 'online', {
            currentSessionId: activeSession?.id || '',
            officerName,
            deviceNo: String(deviceNo),
            loginRole: identity.loginRole,
            roleLabel: identity.roleLabel,
            loginSessionId: identity.loginSessionId,
            assignmentId: identity.assignmentId || currentAssignmentId(),
            qualityMode,
            qualityLabel: QUALITY_MODES[qualityMode].label
          }).catch(console.warn);
        }, 25000);
        unsubscribeIncomingCalls = db.collection('tournaments').doc(tournamentId).collection('camera_calls').onSnapshot((snapshot) => {
          const requested = snapshot.docs
            .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
            .filter((call) => requestedCallMatches(call, effectiveOfficerId, officerName));
          if (requested.length) showIncomingCall(requested.sort((a, b) => (a.requestedAt?.toMillis?.() || 0) - (b.requestedAt?.toMillis?.() || 0))[0]);
          else if (!activeSession) hideIncomingCall();
        }, (listenError) => showError(error, `本部呼出を受信できませんでした: ${listenError.message}`));
      } catch (waitError) {
        waitingActive = false;
        showError(error, `待機を開始できませんでした: ${waitError.message}`);
        setWaitingUi('offline');
      }
    }
    async function stopWaiting() {
      if (unsubscribeIncomingCalls) unsubscribeIncomingCalls();
      unsubscribeIncomingCalls = null;
      if (waitingHeartbeat) clearInterval(waitingHeartbeat);
      waitingHeartbeat = null;
      waitingActive = false;
      hideIncomingCall();
      try { await updateOfficerStatus(activeSession ? 'busy' : 'offline', { currentSessionId: activeSession?.id || '' }); } catch (waitError) { console.warn('待機終了状態を保存できませんでした', waitError); }
      if (!activeSession) setWaitingUi('offline');
    }
    function currentQualityData(stream = localStream) {
      const quality = QUALITY_MODES[qualityMode];
      const settings = stream?.getVideoTracks()[0]?.getSettings?.() || {};
      return {
        qualityMode,
        qualityLabel: quality.label,
        videoWidth: Number(settings.width) || quality.width,
        videoHeight: Number(settings.height) || quality.height,
        frameRate: Number(settings.frameRate) || quality.frameRate
      };
    }
    async function saveQualityToSession() {
      if (!localStream) return;
      const data = currentQualityData();
      const writes = [];
      if (activeSession) writes.push(activeSession.update(data));
      if (officerRef) writes.push(officerRef.update({ qualityMode: data.qualityMode, qualityLabel: data.qualityLabel, lastSeen: serverTime(), updatedAt: serverTime() }));
      if (assignmentRef) writes.push(assignmentRef.update({ qualityMode: data.qualityMode, qualityLabel: data.qualityLabel, lastSeen: serverTime(), updatedAt: serverTime() }));
      try { await Promise.all(writes); } catch (saveError) { console.warn('画質情報を保存できませんでした', saveError); }
    }

    function reportLocalVideoMetadata() {
      const track = localStream?.getVideoTracks()[0];
      const width = video.videoWidth;
      const height = video.videoHeight;
      debug('localMetadata', `localVideo: ${width} × ${height}`);
      debug('localCameraMode', usedCameraFallback ? 'カメラ: フォールバック設定' : 'カメラ: 背面優先');
      if (track) {
        const settings = track.getSettings();
        debug('localTrack', `videoTrack: readyState=${track.readyState}, enabled=${track.enabled}`);
        debug('localSettings', `videoTrack settings: ${JSON.stringify(settings)}`);
        debug('localFrameRate', `frameRate: ${settings.frameRate ?? '-'}fps`);
        debug('localFacingMode', `facingMode: ${settings.facingMode ?? '-'}`);
      }
      debug('localFrame', width === 0 || height === 0 ? '映像フレーム未取得' : '表示レイヤー確認');
      setPlaceholderVisible(placeholder, false);
      saveQualityToSession();
    }
    video.addEventListener('loadedmetadata', reportLocalVideoMetadata);

    async function getCameraStream(mode = qualityMode) {
      try {
        usedCameraFallback = false;
        return await navigator.mediaDevices.getUserMedia(qualityConstraints(mode));
      } catch (cameraError) {
        debug('camera', `背面カメラ優先の取得に失敗: ${cameraError.name || cameraError.message}（基本設定へフォールバック）`);
        usedCameraFallback = true;
        return navigator.mediaDevices.getUserMedia(qualityConstraints(mode, { fallback: true }));
      }
    }
    async function showLocalPreview(stream) {
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      setPlaceholderVisible(placeholder, false);
      if (!await requestVideoPlayback(video)) {
        showError(error, 'カメラは取得できましたが、プレビューを再生できませんでした。Safariのカメラ権限を確認してください。');
        debug('camera', 'カメラ取得成功（プレビュー再生待機）');
      }
    }

    const stopMedia = () => {
      if (localStream) localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      video.srcObject = null;
      setPlaceholderVisible(placeholder, true, 'カメラプレビュー');
    };
    const resetCallControls = () => {
      startButton.disabled = false;
      endButton.disabled = true;
      micButton.disabled = true;
      retryCameraButton.disabled = true;
      setQualityButtonsDisabled(false);
      micButton.textContent = 'マイク ON';
      activeSession = null;
    };
    const finishLocalCall = () => {
      if (unsubscribeSession) unsubscribeSession();
      if (unsubscribeAnswerCandidates) unsubscribeAnswerCandidates();
      unsubscribeSession = null;
      unsubscribeAnswerCandidates = null;
      closePeer(peer); peer = null;
      stopMedia();
      resetCallControls();
    };

    async function replaceOutboundVideoTrack(stream) {
      if (!peer) { debug('replaceTrack', 'replaceTrack 未実行（WebRTC未接続）'); return; }
      const newVideoTrack = stream.getVideoTracks()[0];
      const videoSender = peer.getSenders().find((sender) => sender.track?.kind === 'video');
      if (!newVideoTrack || !videoSender) {
        const error = new Error('送信video trackが見つかりません。');
        debug('replaceTrack', `replaceTrack 失敗: ${error.message}`);
        throw error;
      }
      try {
        await videoSender.replaceTrack(newVideoTrack);
        const newAudioTrack = stream.getAudioTracks()[0];
        const audioSender = peer.getSenders().find((sender) => sender.track?.kind === 'audio');
        if (newAudioTrack && audioSender) await audioSender.replaceTrack(newAudioTrack);
        debug('replaceTrack', 'replaceTrack 成功');
      } catch (replaceError) {
        debug('replaceTrack', `replaceTrack 失敗: ${replaceError.name || replaceError.message}`);
        throw replaceError;
      }
    }
    async function replaceCameraStream(reason) {
      const previousStream = localStream;
      if (previousStream) previousStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      try {
        debug('camera', `${reason}中: ${qualityText(qualityMode)}`);
        const nextStream = await getCameraStream(qualityMode);
        localStream = nextStream;
        await showLocalPreview(nextStream);
        await replaceOutboundVideoTrack(nextStream);
        await saveQualityToSession();
        debug('camera', `${reason}成功: ${qualityText(qualityMode)}`);
      } catch (cameraError) {
        debug('replaceTrack', `replaceTrack 失敗: ${cameraError.name || cameraError.message}`);
        throw cameraError;
      }
    }

    async function endCall({ updateFirestore = true } = {}) {
      const session = activeSession;
      const callRef = activeCallRef;
      finishLocalCall();
      if (updateFirestore && session) {
        try { await session.update({ status: 'ended', endedAt: serverTime() }); } catch (err) { console.warn('終了状態を保存できませんでした', err); }
      }
      if (callRef) {
        try { await callRef.update({ status: 'ended', endedAt: serverTime(), updatedAt: serverTime() }); } catch (err) { console.warn('呼出終了状態を保存できませんでした', err); }
      }
      activeCallRef = null;
      updateOfficerStatus(waitingActive ? 'online' : 'offline', { currentSessionId: '' }).catch(console.warn);
      setStatus(status, '終了しました');
    }

    async function makeCall(hqCall = null) {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      const identity = currentLoginIdentity();
      const officerName = currentRulingEyeDevice?.officerName || hqCall?.targetOfficerName || assignedOfficerName();
      const effectiveOfficerId = assignedOfficerId();
      const tournamentName = currentRulingEyeDevice?.tournamentName || hqCall?.tournamentName || tournamentId;
      const hole = String(hqCall?.hole || holeInput.value.trim());
      const groupNo = String(hqCall?.groupNo || groupInput.value.trim());
      showError(error, '');
      if (!tournamentId || !officerName || !hole || !groupNo) {
        showError(error, '大会ID、競技委員名、ホール番号、組番号をすべて入力してください。'); return;
      }
      try {
        startButton.disabled = true;
        setQualityButtonsDisabled(true);
        setStatus(status, 'カメラを起動しています…', 'calling');
        debug('camera', 'カメラ取得中');
        // ボタン操作から直接、標準画質・背面カメラ優先で取得します。
        localStream = await getCameraStream(qualityMode);
        debug('camera', 'カメラ取得成功');
        await showLocalPreview(localStream);
        micButton.disabled = false;
        retryCameraButton.disabled = false;
        micButton.textContent = 'マイク ON';

        db = db || createFirebase();

        const sessions = db.collection('tournaments').doc(tournamentId).collection('camera_sessions');
        activeSession = sessions.doc();
        const roomId = activeSession.id;
        activeCallRef = hqCall?.ref || null;
        const sessionData = {
          tournamentId,
          tournamentName,
          officerId: effectiveOfficerId,
          officerName,
          deviceNo: String(currentRulingEyeDevice?.deviceNo || deviceNo),
          loginRole: identity.loginRole || hqCall?.targetLoginRole || '',
          roleLabel: identity.roleLabel || hqCall?.targetRoleLabel || '',
          loginSessionId: identity.loginSessionId || hqCall?.loginSessionId || '',
          assignmentId: identity.assignmentId || hqCall?.assignmentId || currentAssignmentId(),
          hole,
          groupNo,
          status: 'calling',
          roomId,
          createdAt: serverTime(),
          connectedAt: null,
          endedAt: null,
          memo: '',
          hqUser: '',
          callId: hqCall?.callId || hqCall?.id || '',
          requestMode: hqCall?.requestMode || (hqCall ? 'hq_to_officer' : 'officer_manual'),
          reason: hqCall?.reason || '',
          ...currentQualityData()
        };
        if (activeCallRef) {
          const batch = db.batch();
          batch.set(activeSession, sessionData);
          batch.update(activeCallRef, {
            status: 'accepted',
            sessionId: activeSession.id,
            acceptedAt: serverTime(),
            updatedAt: serverTime(),
            deviceNo: sessionData.deviceNo,
            loginSessionId: sessionData.loginSessionId,
            assignmentId: sessionData.assignmentId,
            targetLoginRole: sessionData.loginRole,
            targetRoleLabel: sessionData.roleLabel
          });
          await batch.commit();
        } else {
          await activeSession.set(sessionData);
        }
        await updateOfficerStatus('busy', {
          currentSessionId: activeSession.id,
          officerName,
          deviceNo: sessionData.deviceNo,
          loginRole: sessionData.loginRole,
          roleLabel: sessionData.roleLabel,
          loginSessionId: sessionData.loginSessionId,
          assignmentId: sessionData.assignmentId,
          qualityMode,
          qualityLabel: QUALITY_MODES[qualityMode].label
        });

        peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));
        peer.onicecandidate = (event) => {
          if (event.candidate) activeSession.collection('offerCandidates').add(event.candidate.toJSON()).catch(console.warn);
        };
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === 'connected') {
            setStatus(status, '本部と接続中', 'connected'); debug('hq', '本部接続済み');
            if (activeCallRef) activeCallRef.update({ status: 'connected', connectedAt: serverTime(), updatedAt: serverTime() }).catch(console.warn);
          }
          if (['failed', 'disconnected'].includes(peer?.connectionState)) setStatus(status, '接続が切れました。本部を待機中です。', 'calling');
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await activeSession.update({ offer: { type: offer.type, sdp: offer.sdp } });
        setStatus(status, '本部の応答を待っています', 'calling');
        debug('hq', '本部接続中');
        endButton.disabled = false;
        setQualityButtonsDisabled(false);

        unsubscribeAnswerCandidates = activeSession.collection('answerCandidates').onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') peer?.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(console.warn);
          });
        });
        unsubscribeSession = activeSession.onSnapshot((snapshot) => {
          const data = snapshot.data();
          if (!data || !peer) return;
          if (data.answer && !peer.currentRemoteDescription) peer.setRemoteDescription(new RTCSessionDescription(data.answer)).catch((err) => showError(error, `本部への接続に失敗しました: ${err.message}`));
          if (data.status === 'connected') { setStatus(status, '本部と接続中', 'connected'); debug('hq', '本部接続済み'); }
          if (data.status === 'ended') {
            const callRef = activeCallRef;
            finishLocalCall();
            if (callRef) callRef.update({ status: 'ended', endedAt: serverTime(), updatedAt: serverTime() }).catch(console.warn);
            activeCallRef = null;
            updateOfficerStatus(waitingActive ? 'online' : 'offline', { currentSessionId: '' }).catch(console.warn);
            setStatus(status, '本部側で対応完了になりました');
          }
        });
        return true;
      } catch (err) {
        console.error(err);
        const callRef = activeCallRef;
        showError(error, `映像共有を開始できませんでした: ${err.message}`);
        if (!localStream) debug('camera', `カメラ取得失敗: ${err.name || err.message}`);
        finishLocalCall();
        if (callRef) callRef.update({ status: 'missed', endedAt: serverTime(), updatedAt: serverTime() }).catch(console.warn);
        activeCallRef = null;
        updateOfficerStatus(waitingActive ? 'online' : 'offline', { currentSessionId: '' }).catch(console.warn);
        setStatus(status, '開始できませんでした', 'error');
        return false;
      }
    }

    startButton.addEventListener('click', () => { makeCall(); });
    endButton.addEventListener('click', () => endCall());
    deviceNoSelect.value = String(deviceNo);
    renderRulingEyeDeviceIdle();
    saveDeviceButton.addEventListener('click', async () => {
      deviceNo = String(deviceNoSelect.value);
      try {
        localStorage.setItem('rulingEyeCameraDeviceNo', deviceNo);
        localStorage.setItem('ruling-eye-device-no', deviceNo);
      } catch (_) { /* private mode fallback */ }
      assignmentData = null; assignmentRef = null;
      currentRulingEyeDevice = null;
      renderRulingEyeDeviceIdle();
      assignmentStatusDisplay(`この端末を iPhone No.${deviceNo} に設定しました。大会IDを入力して割当確認してください。`);
      setRulingEyeDeviceStatus(`この端末を iPhone No.${deviceNo} に設定しました。端末情報を読み込んでください。`);
      if (tournamentInput.value.trim()) await loadRulingEyeCameraOfficerData();
    });
    deviceNoSelect.addEventListener('change', async () => {
      deviceNo = String(deviceNoSelect.value);
      try {
        localStorage.setItem('rulingEyeCameraDeviceNo', deviceNo);
        localStorage.setItem('ruling-eye-device-no', deviceNo);
      } catch (_) { /* private mode fallback */ }
      currentRulingEyeDevice = null;
      assignmentData = null;
      assignmentRef = null;
      renderRulingEyeDeviceIdle();
      setRulingEyeDeviceStatus(`この端末を iPhone No.${deviceNo} に設定しました。`);
      if (tournamentInput.value.trim()) await loadRulingEyeCameraOfficerData();
    });
    checkAssignmentButton.addEventListener('click', loadAssignment);
    if (loadRulingEyeDeviceButton) loadRulingEyeDeviceButton.addEventListener('click', loadRulingEyeCameraOfficerData);
    tournamentInput.addEventListener('change', async () => {
      currentRulingEyeDevice = null;
      renderRulingEyeDeviceIdle();
      if (!tournamentInput.value.trim()) return;
      await loadRulingEyeCameraOfficerData();
      if (!currentRulingEyeDevice) await loadAssignment();
    });
    if (tournamentInput.value.trim()) loadRulingEyeCameraOfficerData();
    startWaitingButton.addEventListener('click', startWaiting);
    stopWaitingButton.addEventListener('click', stopWaiting);
    acceptCallButton.addEventListener('click', async () => {
      const call = incomingCall;
      if (!call) return;
      acceptCallButton.disabled = true;
      declineCallButton.disabled = true;
      holeInput.value = call.hole || '';
      groupInput.value = call.groupNo || '';
      hideIncomingCall();
      const started = await makeCall(call);
      if (!started) showIncomingCall(call);
      acceptCallButton.disabled = false;
      declineCallButton.disabled = false;
    });
    declineCallButton.addEventListener('click', async () => {
      const call = incomingCall;
      if (!call) return;
      acceptCallButton.disabled = true;
      declineCallButton.disabled = true;
      try {
        await call.ref.update({ status: 'declined', endedAt: serverTime(), updatedAt: serverTime() });
        hideIncomingCall();
        setStatus(status, '本部からの映像依頼を辞退しました');
      } catch (declineError) {
        showError(error, `辞退状態を保存できませんでした: ${declineError.message}`);
      } finally {
        acceptCallButton.disabled = false;
        declineCallButton.disabled = false;
      }
    });
    retryCameraButton.addEventListener('click', async () => {
      retryCameraButton.disabled = true;
      showError(error, '');
      try {
        await replaceCameraStream('カメラ再取得');
      } catch (cameraError) {
        console.error(cameraError);
        showError(error, `カメラを再取得できませんでした: ${cameraError.message}`);
        debug('camera', `カメラ取得失敗: ${cameraError.name || cameraError.message}`);
      } finally {
        retryCameraButton.disabled = false;
      }
    });
    qualityButtons.forEach((button) => button.addEventListener('click', async () => {
      const nextMode = button.dataset.qualityMode;
      if (!QUALITY_MODES[nextMode] || nextMode === qualityMode) return;
      const previousMode = qualityMode;
      qualityMode = nextMode;
      setQualityModeUi();
      if (!localStream) {
        if (officerRef) officerRef.update({ qualityMode, qualityLabel: QUALITY_MODES[qualityMode].label, lastSeen: serverTime(), updatedAt: serverTime() }).catch(console.warn);
        return;
      }
      setQualityButtonsDisabled(true);
      try {
        await replaceCameraStream('画質切替');
      } catch (cameraError) {
        qualityMode = previousMode;
        setQualityModeUi();
        showError(error, `画質を切り替えできませんでした: ${cameraError.message}`);
      } finally {
        setQualityButtonsDisabled(false);
      }
    }));
    setQualityModeUi();
    setWaitingUi('offline');
    micButton.addEventListener('click', () => {
      const track = localStream?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      micButton.textContent = track.enabled ? 'マイク ON' : 'マイク OFF';
    });
    window.addEventListener('pagehide', () => {
      waitingActive = false;
      if (activeSession) activeSession.update({ status: 'ended', endedAt: serverTime() });
      if (officerRef) officerRef.update({ status: 'offline', lastSeen: serverTime(), updatedAt: serverTime() }).catch(() => {});
      if (assignmentRef) assignmentRef.update({ status: 'offline', lastSeen: serverTime(), updatedAt: serverTime() }).catch(() => {});
    });
  }

  async function startAdmin() {
    const tournamentInput = $('tournamentId');
    const watchButton = $('watchCallsButton');
    const callList = $('callList');
    const callCount = $('callCount');
    const officerList = $('officerList');
    const officerCount = $('officerCount');
    const selectedOfficer = $('selectedOfficer');
    const requestHole = $('requestHole');
    const requestGroupNo = $('requestGroupNo');
    const requestReason = $('requestReason');
    const sendRequestButton = $('sendRequestButton');
    const hqCallList = $('hqCallList');
    const rosterOfficerName = $('rosterOfficerName');
    const rosterCategory = $('rosterCategory');
    const rosterNote = $('rosterNote');
    const saveRosterButton = $('saveRosterButton');
    const cancelRosterEditButton = $('cancelRosterEditButton');
    const rosterList = $('rosterList');
    const rosterCsvInput = $('rosterCsvInput');
    const importRosterButton = $('importRosterButton');
    const exportRosterButton = $('exportRosterButton');
    const rosterCsvResult = $('rosterCsvResult');
    const assignmentRosterList = $('assignmentRosterList');
    const assignmentWarning = $('assignmentWarning');
    const saveAssignmentsButton = $('saveAssignmentsButton');
    const loadRulingEyeAdminButton = $('loadRulingEyeAdminButton');
    const rulingEyeAdminStatus = $('rulingEyeAdminStatus');
    const rulingEyeAdminSummary = $('rulingEyeAdminSummary');
    const rulingEyeAssignmentList = $('rulingEyeAssignmentList');
    const rulingEyeLoginList = $('rulingEyeLoginList');
    const rulingEyeCallCandidateList = $('rulingEyeCallCandidateList');
    const adminMonitorGrid = $('adminMonitorGrid');
    const adminMonitorStatus = $('adminMonitorStatus');
    const hqRequestPanel = $('hqRequestPanel');
    const adminTournamentId = $('adminTournamentId');
    const adminTournamentName = $('adminTournamentName');
    const adminLastLoaded = $('adminLastLoaded');
    const adminMonitoringStatus = $('adminMonitoringStatus');
    const status = $('adminConnectionStatus');
    const error = $('adminError');
    const remoteVideo = $('remoteVideo');
    const remotePlaceholder = $('remotePlaceholder');
    const viewerTitle = $('viewerTitle');
    const viewerState = $('viewerState');
    const adminViewingGuard = $('adminViewingGuard');
    const currentViewingSummary = $('currentViewingSummary');
    const qualityDisplay = $('qualityDisplay');
    const memo = $('memo');
    const completeButton = $('completeButton');
    const manualPlayButton = $('manualPlayButton');
    const reloadVideoButton = $('reloadVideoButton');
    const unmuteButton = $('unmuteButton');
    const debug = createDebugReporter($('adminDebug'));
    let db;
    let activeTournamentId;
    let activeSession;
    let peer;
    let unsubscribeCalls;
    let unsubscribeRoster;
    let unsubscribeAssignments;
    let unsubscribeOfficers;
    let unsubscribeHqCalls;
    let unsubscribeOfferCandidates;
    let unsubscribeActiveSession;
    let queuedCandidates = [];
    let iceCandidatesReceived = 0;
    let selectedOfficerData;
    let officersById = new Map();
    let officersCache = [];
    let officerRefreshTimer;
    let activeCallRef;
    let activeOfficerRef;
    let activeAssignmentRef;
    let rosterCache = [];
    let assignmentCache = [];
    let rulingEyeAdminData = null;
    let rulingEyeCallCandidates = [];
    let rulingEyeCandidatesBySessionId = new Map();
    let editingRosterId;
    let currentViewingSessionId = '';
    let currentViewingCallId = '';
    let currentViewingOfficerName = '';
    let currentViewingDeviceNo = '';
    let isAdminViewingActiveSession = false;
    debug('signaling', '接続する呼出を選択してください');
    debug('viewingGuard', '対応中セッションなし');

    function hasActiveViewingSession() {
      return Boolean(isAdminViewingActiveSession && currentViewingSessionId);
    }

    function currentViewingLabel() {
      const deviceLabel = currentViewingDeviceNo ? `No.${currentViewingDeviceNo}` : '';
      return [deviceLabel, currentViewingOfficerName || '映像接続準備中'].filter(Boolean).join(' ');
    }

    function applyViewingSessionButtonGuard() {
      const active = hasActiveViewingSession();
      document.querySelectorAll('[data-connect], [data-review-call]').forEach((button) => {
        const targetSessionId = String(button.dataset.connect || button.dataset.reviewCall || '');
        const blocked = active && targetSessionId !== currentViewingSessionId;
        button.disabled = blocked;
        button.classList.toggle('is-viewing-locked', blocked);
        if (blocked) {
          button.title = '現在対応中の映像があります。対応完了後に確認してください。';
        } else if (button.title === '現在対応中の映像があります。対応完了後に確認してください。') {
          button.removeAttribute('title');
        }
        button.closest('.camera-call-card')?.classList.toggle('is-viewing-locked', blocked);
      });
    }

    function updateViewingGuardUi() {
      const active = hasActiveViewingSession();
      if (adminViewingGuard) adminViewingGuard.dataset.state = active ? 'active' : 'idle';
      if (currentViewingSummary) {
        currentViewingSummary.textContent = active
          ? `現在対応中: ${currentViewingLabel()}。別の映像を見る場合は、先に対応完了してください。`
          : '現在対応中: なし';
      }
      applyViewingSessionButtonGuard();
    }

    function setCurrentViewingSession({ sessionId, callId = '', officerName = '', deviceNo = '' }) {
      currentViewingSessionId = String(sessionId || '');
      currentViewingCallId = String(callId || '');
      currentViewingOfficerName = String(officerName || '');
      currentViewingDeviceNo = String(deviceNo || '');
      isAdminViewingActiveSession = Boolean(currentViewingSessionId);
      debug('viewingGuard', isAdminViewingActiveSession
        ? `対応中セッション: ${currentViewingSessionId} / ${currentViewingLabel()}`
        : '対応中セッションなし');
      updateViewingGuardUi();
    }

    function clearCurrentViewingSession() {
      currentViewingSessionId = '';
      currentViewingCallId = '';
      currentViewingOfficerName = '';
      currentViewingDeviceNo = '';
      isAdminViewingActiveSession = false;
      debug('viewingGuard', '対応中セッションなし');
      updateViewingGuardUi();
    }

    function showViewingSessionGuard(requestedSessionId) {
      const message = '現在対応中の映像があります。対応完了後に別の映像を確認してください。';
      console.warn(message, {
        currentViewingSessionId,
        currentViewingCallId,
        requestedSessionId
      });
      debug('viewingGuard', `接続を停止: ${currentViewingSessionId} の対応完了待ち`);
      showError(error, message);
      setStatus(status, `現在 ${currentViewingLabel()} の映像を確認中です`, 'calling');
      updateViewingGuardUi();
    }

    function updateQualityDisplay(data) {
      const quality = QUALITY_MODES[data?.qualityMode] || QUALITY_MODES.standard;
      if (!data?.qualityMode) {
        qualityDisplay.textContent = '画質: 未取得';
        debug('quality', '受信中画質モード: 未取得');
        return;
      }
      const label = data.qualityLabel || quality.label;
      const width = data.videoWidth || quality.width;
      const height = data.videoHeight || quality.height;
      const frameRate = data.frameRate || quality.frameRate;
      qualityDisplay.textContent = `画質: ${label} ${width}×${height} / ${frameRate}fps`;
      debug('quality', `受信中画質モード: ${label} ${width}×${height} / ${frameRate}fps`);
    }
    function officerAvailability(officer) {
      const lastSeen = officer.lastSeen?.toMillis?.() || 0;
      if (!lastSeen || Date.now() - lastSeen > 90000) return { key: 'stale', label: '未更新（オフライン扱い）' };
      if (officer.status === 'busy') return { key: 'busy', label: '対応中' };
      if (officer.status === 'online') return { key: 'online', label: 'online' };
      return { key: 'offline', label: 'offline' };
    }
    function categoryLabel(category) { return category === 'specialist' ? '専門競技委員' : '登録競技委員'; }
    function setRulingEyeAdminStatus(message, tone = '') {
      if (!rulingEyeAdminStatus) return;
      rulingEyeAdminStatus.textContent = message;
      rulingEyeAdminStatus.dataset.tone = tone;
    }
    function setAdminMonitoringStatus(message, state = 'idle') {
      if (!adminMonitoringStatus) return;
      adminMonitoringStatus.textContent = message;
      adminMonitoringStatus.dataset.state = state;
    }
    function updateAdminOverview(data = rulingEyeAdminData) {
      const tournamentId = data?.tournamentId || cleanTournamentId(tournamentInput.value) || '未選択';
      if (adminTournamentId) adminTournamentId.textContent = tournamentId;
      if (adminTournamentName) {
        adminTournamentName.textContent = data?.settingExists
          ? data.setting?.tournamentName || tournamentId
          : '未読込';
      }
      if (adminLastLoaded) adminLastLoaded.textContent = data?.loadedAt ? formatDateTime(data.loadedAt) : '-';
    }
    function buildRulingEyeCallCandidates(data = rulingEyeAdminData) {
      if (!data?.settingExists || data.setting?.deleted === true || !data?.loginSessions) return [];
      const validDeviceNumbers = new Set(['1', '2', '3', '4', '5', '6', '7']);
      const assignmentsByOfficer = new Map(
        (data.assignments || [])
          .filter((assignment) => assignment.officerId)
          .map((assignment) => [String(assignment.officerId), assignment])
      );
      const assignmentsByDevice = new Map(
        (data.assignments || [])
          .filter((assignment) => assignment.deviceNo)
          .map((assignment) => [String(assignment.deviceNo), assignment])
      );
      const loginTime = (session) => {
        if (typeof session.loginAt?.toMillis === 'function') return session.loginAt.toMillis();
        const parsed = new Date(session.loginAt || 0).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const candidates = activeLoginSessions(data.loginSessions)
        .filter((session) => ['chief', 'officer'].includes(session.loginRole))
        .filter((session) => validDeviceNumbers.has(String(session.deviceNo || '')))
        .filter((session) => String(session.officerId || '').trim() && String(session.officerName || '').trim())
        .sort((a, b) => loginTime(b) - loginTime(a))
        .map((session) => {
          const assignment = assignmentsByOfficer.get(String(session.officerId))
            || assignmentsByDevice.get(String(session.deviceNo))
            || null;
          return {
            source: 'ruling_eye',
            id: session.sessionId || session.id || '',
            sessionId: session.sessionId || session.id || '',
            tournamentId: data.tournamentId,
            tournamentName: data.setting?.tournamentName || data.tournamentId,
            loginRole: session.loginRole,
            roleLabel: roleLabel(session.loginRole),
            officerId: String(session.officerId),
            officerName: String(session.officerName),
            deviceNo: String(session.deviceNo),
            assignmentId: assignment?.assignmentId || assignment?.id || '',
            qualityMode: assignment?.qualityMode || '',
            qualityLabel: assignment?.qualityLabel || '',
            status: 'active',
            loginAt: session.loginAt || null
          };
        });
      const newestByDevice = new Map();
      candidates.forEach((candidate) => {
        if (!newestByDevice.has(candidate.deviceNo)) newestByDevice.set(candidate.deviceNo, candidate);
      });
      return [...newestByDevice.values()]
        .sort((a, b) => Number(a.deviceNo) - Number(b.deviceNo));
    }
    function timestampMillis(timestamp) {
      if (!timestamp) return 0;
      if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
      if (typeof timestamp.toDate === 'function') return timestamp.toDate().getTime();
      const parsed = new Date(timestamp).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    }
    function findCameraOfficerForCandidate(candidate) {
      if (!candidate) return null;
      const matches = (left, right) => Boolean(String(left || '').trim() && String(right || '').trim() && String(left) === String(right));
      const byOfficer = officersCache.find((officer) => matches(officer.officerId || officer.id, candidate.officerId));
      if (byOfficer) return byOfficer;
      const byLogin = officersCache.find((officer) => matches(officer.loginSessionId, candidate.sessionId));
      if (byLogin) return byLogin;
      const byAssignment = officersCache.find((officer) => matches(officer.assignmentId, candidate.assignmentId));
      if (byAssignment) return byAssignment;
      return [...officersCache]
        .filter((officer) => matches(officer.deviceNo, candidate.deviceNo))
        .sort((a, b) => timestampMillis(b.lastSeen || b.updatedAt) - timestampMillis(a.lastSeen || a.updatedAt))[0] || null;
    }
    function rulingEyeCandidateAvailability(candidate) {
      if (!candidate) return { key: 'unlogged', label: '未ログイン', action: '呼出不可', officer: null };
      const officer = findCameraOfficerForCandidate(candidate);
      if (!officer) return { key: 'not-waiting', label: '未待機', action: '待機開始待ち', officer: null };
      if (officer.status === 'busy') return { key: 'busy', label: '対応中', action: '対応中', officer };
      const lastSeen = timestampMillis(officer.lastSeen || officer.updatedAt);
      if (!lastSeen || Date.now() - lastSeen >= 90000) {
        return { key: 'stale', label: '未更新', action: '未更新', officer };
      }
      if (officer.status === 'online') return { key: 'online', label: '待機中', action: '映像依頼', officer };
      if (officer.status === 'offline') return { key: 'offline', label: 'オフライン', action: '呼出不可', officer };
      return { key: 'not-waiting', label: '未待機', action: '待機開始待ち', officer };
    }
    function renderAdminMonitorGrid(data = rulingEyeAdminData) {
      if (!adminMonitorGrid) return;
      const candidatesByDevice = new Map(
        rulingEyeCallCandidates.map((candidate) => [String(candidate.deviceNo), candidate])
      );
      const cards = ['1', '2', '3', '4', '5', '6', '7'].map((number) => {
        const candidate = candidatesByDevice.get(number) || null;
        const availability = rulingEyeCandidateAvailability(candidate);
        const cameraOfficer = availability.officer;
        const quality = cameraOfficer?.qualityLabel
          || candidate?.qualityLabel
          || QUALITY_MODES[cameraOfficer?.qualityMode || candidate?.qualityMode]?.label
          || '未取得';
        const lastUpdated = cameraOfficer?.lastSeen || cameraOfficer?.updatedAt || null;
        const role = number === '1' ? '競技委員長' : '競技委員';
        const name = candidate?.officerName || '未ログイン';
        const selected = candidate
          && selectedOfficerData?.source === 'ruling_eye'
          && selectedOfficerData.sessionId === candidate.sessionId;
        const canRequest = availability.key === 'online';
        return `
          <article class="camera-admin-monitor-card${selected ? ' is-selected' : ''}" data-monitor-device="${number}" data-state="${escapeHtml(availability.key)}" tabindex="0" role="button" aria-label="iPhone No.${number} ${escapeHtml(name)} ${escapeHtml(availability.label)}">
            <div class="camera-admin-monitor-card-head">
              <span class="camera-admin-monitor-device">No.${number}</span>
              <span class="camera-admin-monitor-role">${escapeHtml(role)}</span>
            </div>
            <strong class="camera-admin-monitor-name">${escapeHtml(name)}</strong>
            <div class="camera-admin-monitor-state">
              <span>状態</span>
              <em class="admin-state-badge state-${escapeHtml(availability.key)}">${escapeHtml(availability.label)}</em>
            </div>
            <div class="camera-admin-monitor-meta">
              <span>画質: ${escapeHtml(candidate ? quality : '-')}</span>
              <span>最終更新: ${escapeHtml(lastUpdated ? formatTime(lastUpdated) : '-')}</span>
            </div>
            <button class="camera-button camera-button-primary" type="button"${canRequest ? '' : ' disabled'}>${canRequest ? '映像依頼' : '呼出不可'}</button>
          </article>
        `;
      });
      cards.push(`
        <article class="camera-admin-monitor-card" data-monitor-device="reserve" data-state="reserve" tabindex="0" role="button" aria-label="予備 未使用">
          <div class="camera-admin-monitor-card-head">
            <span class="camera-admin-monitor-device">予備</span>
            <span class="camera-admin-monitor-role">未使用</span>
          </div>
          <strong class="camera-admin-monitor-name">未使用</strong>
          <div class="camera-admin-monitor-state">
            <span>状態</span>
            <em class="admin-state-badge">予備</em>
          </div>
          <div class="camera-admin-monitor-meta">
            <span>画質: -</span>
            <span>最終更新: -</span>
          </div>
          <button class="camera-button camera-button-secondary" type="button" disabled>呼出不可</button>
        </article>
      `);
      adminMonitorGrid.innerHTML = cards.join('');
      if (adminMonitorStatus) {
        if (!data) {
          adminMonitorStatus.textContent = '大会管理情報は未読込です。';
        } else if (!data.settingExists) {
          adminMonitorStatus.textContent = '大会設定が見つかりません。';
        } else if (data.setting?.deleted === true) {
          adminMonitorStatus.textContent = '削除済みの大会です。';
        } else {
          adminMonitorStatus.textContent = '端末状態を自動監視中です。待機中のカードから映像依頼できます。';
        }
      }
    }
    function monitorCardGuidance(availability, candidate, deviceNo) {
      const label = candidate ? `No.${deviceNo} ${candidate.officerName}` : `No.${deviceNo}`;
      if (availability.key === 'busy') return `${label}は現在対応中です。`;
      if (availability.key === 'not-waiting') return `${label}は競技委員側で待機開始が必要です。`;
      if (availability.key === 'stale') return `${label}は端末の更新が止まっています。競技委員側の画面を確認してください。`;
      if (availability.key === 'offline') return `${label}はオフラインです。競技委員側の画面を確認してください。`;
      return `${label}はruling_eye.htmlで大会ログインが必要です。`;
    }
    function clearMonitorSelection(message) {
      selectedOfficerData = null;
      selectedOfficer.textContent = message;
      sendRequestButton.disabled = true;
      renderRulingEyeCallCandidates();
    }
    function handleAdminMonitorCard(deviceNo) {
      if (deviceNo === 'reserve') {
        const message = '予備枠です。映像依頼には使用できません。';
        clearMonitorSelection(message);
        setRulingEyeAdminStatus(message, 'warning');
        setStatus(status, message, 'calling');
        return;
      }
      const candidate = rulingEyeCallCandidates.find((item) => item.deviceNo === String(deviceNo)) || null;
      const availability = rulingEyeCandidateAvailability(candidate);
      if (candidate && availability.key === 'online') {
        selectOfficer(candidate);
        const message = `No.${deviceNo} ${candidate.officerName}を選択しました。ホール・組・理由を入力してください。`;
        setRulingEyeAdminStatus(message, 'success');
        setStatus(status, message, 'connected');
        hqRequestPanel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const message = monitorCardGuidance(availability, candidate, deviceNo);
      clearMonitorSelection(message);
      setRulingEyeAdminStatus(message, 'warning');
      setStatus(status, message, 'calling');
    }
    function renderRulingEyeAdminSummary(data = rulingEyeAdminData) {
      if (!rulingEyeAdminSummary || !data) return;
      updateAdminOverview(data);
      const setting = data.setting || {};
      if (!data.settingExists) {
        rulingEyeAdminSummary.innerHTML = '<p class="camera-empty">この大会IDのRuling Eye大会設定が見つかりません。ruling_eye.html で大会設定を作成してください。</p>';
        return;
      }
      if (setting.deleted === true) {
        rulingEyeAdminSummary.innerHTML = '<p class="camera-empty">この大会設定は削除済みです。</p>';
        return;
      }
      rulingEyeAdminSummary.innerHTML = `
        <div class="ruling-eye-info-card"><span>大会ID</span><strong>${escapeHtml(data.tournamentId)}</strong></div>
        <div class="ruling-eye-info-card"><span>年度</span><strong>${escapeHtml(setting.year || '-')}</strong></div>
        <div class="ruling-eye-info-card"><span>大会名</span><strong>${escapeHtml(setting.tournamentName || data.tournamentId)}</strong></div>
        <div class="ruling-eye-info-card"><span>競技委員人数</span><strong>${escapeHtml(setting.officerCount || '-')}</strong></div>
        <div class="ruling-eye-info-card"><span>競技委員長</span><strong>${escapeHtml(setting.chiefOfficerName || '-')}</strong></div>
        <div class="ruling-eye-info-card"><span>管理データ読込状態</span><strong>読込済み</strong></div>
        <div class="ruling-eye-info-card"><span>最終読込</span><strong>${escapeHtml(formatDateTime(data.loadedAt))}</strong></div>
      `;
    }
    function renderRulingEyeAssignments(data = rulingEyeAdminData) {
      if (!rulingEyeAssignmentList || !data) return;
      const setting = data.setting || {};
      if (!data.settingExists || setting.deleted === true) {
        rulingEyeAssignmentList.innerHTML = '<p class="camera-empty">大会設定が有効な場合に表示します。</p>';
        return;
      }
      const activeByDevice = new Map(
        activeLoginSessions(data.loginSessions)
          .filter((session) => ['chief', 'officer'].includes(session.loginRole))
          .filter((session) => session.deviceNo)
          .map((session) => [String(session.deviceNo), session])
      );
      const assignmentByDevice = new Map(
        data.assignments
          .filter((assignment) => assignment.deviceNo)
          .map((assignment) => [String(assignment.deviceNo), assignment])
      );
      rulingEyeAssignmentList.innerHTML = ['1', '2', '3', '4', '5', '6', '7'].map((number) => {
        const session = activeByDevice.get(number);
        const assignment = assignmentByDevice.get(number);
        const isChiefNo = number === '1';
        const name = session?.officerName || assignment?.officerName || (isChiefNo ? setting.chiefOfficerName : '');
        const displayName = name || '未ログイン';
        const displayRole = session ? roleLabel(session.loginRole) : isChiefNo ? '競技委員長' : '競技委員';
        const state = session ? 'ログイン中' : '未ログイン';
        return `
          <div class="ruling-eye-row ${session ? 'is-active' : ''}">
            <strong>No.${number}</strong>
            <span>${escapeHtml(displayRole)}</span>
            <span>${escapeHtml(displayName)}</span>
            <em>${escapeHtml(state)}</em>
          </div>
        `;
      }).join('');
    }
    function renderRulingEyeLoginSessions(data = rulingEyeAdminData) {
      if (!rulingEyeLoginList || !data) return;
      const sessions = [...data.loginSessions].sort((a, b) => {
        if ((a.status === 'ended') !== (b.status === 'ended')) return a.status === 'ended' ? 1 : -1;
        return (b.loginAt?.toMillis?.() || 0) - (a.loginAt?.toMillis?.() || 0);
      });
      if (!sessions.length) {
        rulingEyeLoginList.innerHTML = '<p class="camera-empty">この大会のログイン状態はありません。</p>';
        return;
      }
      rulingEyeLoginList.innerHTML = sessions.map((session) => `
        <div class="ruling-eye-row ${session.status === 'ended' ? 'is-ended' : 'is-active'}">
          <strong>${escapeHtml(roleLabel(session.loginRole))}</strong>
          <span>${escapeHtml(session.officerName || session.roleLabel || '-')}</span>
          <span>${session.deviceNo ? `iPhone No.${escapeHtml(session.deviceNo)}` : 'iPhone No.なし'}</span>
          <em>${escapeHtml(session.status || '-')}</em>
          <small>ログイン: ${escapeHtml(formatDateTime(session.loginAt))}</small>
          <small>終了: ${escapeHtml(formatDateTime(session.endedAt))}</small>
        </div>
      `).join('');
    }
    function renderRulingEyeCallCandidates(data = rulingEyeAdminData) {
      if (!rulingEyeCallCandidateList) return;
      rulingEyeCallCandidates = buildRulingEyeCallCandidates(data);
      rulingEyeCandidatesBySessionId = new Map(
        rulingEyeCallCandidates.map((candidate) => [candidate.sessionId, candidate])
      );
      renderAdminMonitorGrid(data);
      if (selectedOfficerData?.source === 'ruling_eye') {
        const selectedCandidate = rulingEyeCandidatesBySessionId.get(selectedOfficerData.sessionId);
        if (!selectedCandidate || rulingEyeCandidateAvailability(selectedCandidate).key !== 'online') {
          selectedOfficerData = null;
          selectedOfficer.textContent = '待機中の競技委員を選択してください';
          sendRequestButton.disabled = true;
        }
      }
      if (!data) {
        rulingEyeCallCandidateList.innerHTML = '<p class="camera-empty">最新データ取得後に端末状態を表示します。</p>';
        return;
      }
      if (!data?.settingExists) {
        rulingEyeCallCandidateList.innerHTML = '<p class="camera-empty">この大会IDのRuling Eye大会設定が見つかりません。ruling_eye.html で大会設定を作成してください。</p>';
        return;
      }
      if (data.setting?.deleted === true) {
        rulingEyeCallCandidateList.innerHTML = '<p class="camera-empty">この大会設定は削除済みのため、呼出対象を表示できません。</p>';
        return;
      }
      const candidatesByDevice = new Map(
        rulingEyeCallCandidates.map((candidate) => [candidate.deviceNo, candidate])
      );
      const emptyGuidance = rulingEyeCallCandidates.length
        ? ''
        : '<p class="camera-empty">ログイン中の競技委員がいません。ruling_eye.html の大会ログインで競技委員をログインしてください。</p>';
      rulingEyeCallCandidateList.innerHTML = `${emptyGuidance}${['1', '2', '3', '4', '5', '6', '7'].map((number) => {
        const candidate = candidatesByDevice.get(number);
        if (!candidate) {
          return `
            <article class="ruling-eye-call-target-card state-unlogged">
              <div class="ruling-eye-call-target-main">
                <strong>No.${number}</strong>
                <span>${number === '1' ? '競技委員長' : '競技委員'}</span>
              </div>
              <p>未ログイン</p>
              <em class="admin-state-badge state-unlogged">未ログイン</em>
            </article>
          `;
        }
        const availability = rulingEyeCandidateAvailability(candidate);
        const cameraOfficer = availability.officer;
        const selected = selectedOfficerData?.source === 'ruling_eye'
          && selectedOfficerData.sessionId === candidate.sessionId;
        const quality = cameraOfficer?.qualityLabel
          || candidate.qualityLabel
          || QUALITY_MODES[cameraOfficer?.qualityMode || candidate.qualityMode]?.label
          || '未取得';
        const lastUpdated = cameraOfficer?.lastSeen || cameraOfficer?.updatedAt || null;
        const canRequest = availability.key === 'online';
        return `
          <article class="ruling-eye-call-target-card state-${escapeHtml(availability.key)}${selected ? ' is-selected' : ''}">
            <div class="ruling-eye-call-target-main">
              <strong>No.${escapeHtml(candidate.deviceNo)}</strong>
              <span>${escapeHtml(candidate.roleLabel)}</span>
            </div>
            <p>${escapeHtml(candidate.officerName)}</p>
            <em class="admin-state-badge state-${escapeHtml(availability.key)}">${escapeHtml(availability.label)}</em>
            <div class="ruling-eye-call-target-meta">
              <span>画質: ${escapeHtml(quality)}</span>
              <span>最終更新: ${escapeHtml(lastUpdated ? formatTime(lastUpdated) : '-')}</span>
            </div>
            <button class="camera-button camera-button-primary" type="button" data-select-ruling-eye="${escapeHtml(candidate.sessionId)}"${canRequest ? '' : ' disabled'}>${escapeHtml(availability.action)}</button>
          </article>
        `;
      }).join('')}`;
    }
    async function loadRulingEyeCameraAdminData(tournamentId) {
      const targetTournamentId = cleanTournamentId(tournamentId || tournamentInput.value);
      showError(error, '');
      if (!targetTournamentId) {
        setRulingEyeAdminStatus('大会IDを入力してください。', 'error');
        return null;
      }
      try {
        db = db || createFirebase();
        if (loadRulingEyeAdminButton) loadRulingEyeAdminButton.disabled = true;
        if (adminTournamentId) adminTournamentId.textContent = targetTournamentId;
        if (adminTournamentName) adminTournamentName.textContent = '読込中';
        setRulingEyeAdminStatus('Ruling Eye大会管理情報を読み込み中です…');
        if (activeTournamentId !== targetTournamentId) {
          await watchCalls();
          if (activeTournamentId !== targetTournamentId) {
            throw new Error('大会IDの呼出監視を開始できませんでした。');
          }
        }
        const tournamentRef = db.collection('tournaments').doc(targetTournamentId);
        const [settingsDoc, assignmentsSnapshot, sessionsSnapshot] = await Promise.all([
          tournamentRef.collection('ruling_eye_settings').doc('main').get(),
          tournamentRef.collection('camera_assignments').get(),
          tournamentRef.collection('ruling_eye_login_sessions').get()
        ]);
        rulingEyeAdminData = {
          tournamentId: targetTournamentId,
          settingExists: settingsDoc.exists,
          setting: settingsDoc.exists ? settingsDoc.data() : null,
          assignments: assignmentsSnapshot.docs.map((doc) => ({ id: doc.id, assignmentId: doc.id, ...doc.data() })),
          loginSessions: sessionsSnapshot.docs.map((doc) => ({ id: doc.id, sessionId: doc.id, ...doc.data() })),
          loadedAt: new Date()
        };
        if (!rulingEyeAdminData.settingExists) {
          setRulingEyeAdminStatus('この大会IDのRuling Eye大会設定が見つかりません。ruling_eye.html で大会設定を作成してください。', 'error');
        } else if (rulingEyeAdminData.setting?.deleted === true) {
          setRulingEyeAdminStatus('この大会設定は削除済みです。', 'warning');
        } else {
          setRulingEyeAdminStatus('Ruling Eye大会管理情報を読み込みました。', 'success');
        }
        renderRulingEyeAdminSummary(rulingEyeAdminData);
        renderRulingEyeAssignments(rulingEyeAdminData);
        renderRulingEyeLoginSessions(rulingEyeAdminData);
        renderRulingEyeCallCandidates(rulingEyeAdminData);
        return rulingEyeAdminData;
      } catch (readError) {
        console.error('Ruling Eye admin data read failed', readError);
        const message = rulingEyeReadErrorMessage(readError);
        setRulingEyeAdminStatus(message, 'error');
        showError(error, message);
        return null;
      } finally {
        if (loadRulingEyeAdminButton) loadRulingEyeAdminButton.disabled = false;
      }
    }
    function resetRosterEditor() {
      editingRosterId = null;
      rosterOfficerName.value = ''; rosterCategory.value = 'specialist'; rosterNote.value = '';
      saveRosterButton.textContent = 'ロースターへ追加';
      cancelRosterEditButton.hidden = true;
    }
    function renderRoster() {
      const sorted = [...rosterCache].sort((a, b) => (a.officerName || '').localeCompare(b.officerName || '', 'ja'));
      if (!sorted.length) { rosterList.innerHTML = '<p class="camera-empty">ロースターはまだ登録されていません。</p>'; return; }
      rosterList.innerHTML = sorted.map((officer) => `<article class="camera-call-card camera-roster-card" data-active="${officer.active !== false}">
        <div class="camera-card-top"><span class="camera-card-name">${escapeHtml(officer.officerName || '名前未入力')}</span><span class="camera-card-status">${categoryLabel(officer.category)}</span></div>
        <div class="camera-card-meta"><span>${escapeHtml(officer.note || 'メモなし')}</span><span>${officer.active === false ? '停止中' : '有効'}</span></div>
        <div class="camera-roster-actions"><button class="camera-button camera-button-secondary" type="button" data-edit-roster="${escapeHtml(officer.id)}">編集</button><button class="camera-button camera-button-secondary" type="button" data-toggle-roster="${escapeHtml(officer.id)}">${officer.active === false ? '有効化' : '停止'}</button></div>
      </article>`).join('');
    }
    function renderAssignmentRoster() {
      if (!activeTournamentId) { assignmentRosterList.innerHTML = '<p class="camera-empty">大会IDを入力して「呼出を表示」を押してください。</p>'; saveAssignmentsButton.disabled = true; return; }
      const available = rosterCache.filter((officer) => officer.active !== false).sort((a, b) => (a.officerName || '').localeCompare(b.officerName || '', 'ja'));
      if (!available.length) { assignmentRosterList.innerHTML = '<p class="camera-empty">有効なロースターを登録してください。</p>'; saveAssignmentsButton.disabled = true; return; }
      const assignmentsByOfficer = new Map(assignmentCache.map((assignment) => [assignment.officerId, assignment]));
      assignmentRosterList.innerHTML = available.map((officer) => {
        const assignment = assignmentsByOfficer.get(officer.officerId || officer.id);
        const selected = Boolean(assignment);
        const currentDevice = assignment?.deviceNo || '';
        const options = ['1', '2', '3', '4', '5', '6', '7'].map((number) => `<option value="${number}" ${currentDevice === number ? 'selected' : ''}>No.${number}</option>`).join('');
        return `<article class="camera-call-card camera-roster-card" data-roster-officer="${escapeHtml(officer.id)}">
          <div class="camera-card-top"><span class="camera-card-name">${escapeHtml(officer.officerName)}</span><span class="camera-card-status">${categoryLabel(officer.category)}</span></div>
          <div class="camera-assignment-row"><label><input type="checkbox" data-assignment-select="${escapeHtml(officer.id)}" ${selected ? 'checked' : ''}> 選抜</label><label>端末 <select data-assignment-device="${escapeHtml(officer.id)}" ${selected ? '' : 'disabled'}><option value="">選択</option>${options}</select></label></div>
        </article>`;
      }).join('');
      saveAssignmentsButton.disabled = false;
    }
    async function saveRoster() {
      const officerName = rosterOfficerName.value.trim();
      if (!officerName) { showError(error, 'ロースターへ追加する競技委員名を入力してください。'); return; }
      try {
        db = db || createFirebase();
        const ref = editingRosterId ? db.collection('camera_roster').doc(editingRosterId) : db.collection('camera_roster').doc();
        const existing = rosterCache.find((officer) => officer.id === editingRosterId);
        const data = { officerId: ref.id, officerName, category: rosterCategory.value, active: existing?.active !== false, note: rosterNote.value.trim(), updatedAt: serverTime() };
        if (!editingRosterId) data.createdAt = serverTime();
        await ref.set(data, { merge: true });
        resetRosterEditor();
      } catch (rosterError) { showError(error, `ロースターを保存できませんでした: ${rosterError.message}`); }
    }
    function setCsvResult(message, tone = '') {
      rosterCsvResult.textContent = message;
      rosterCsvResult.dataset.tone = tone;
    }
    function parseCsv(text) {
      const rows = [];
      let row = [];
      let field = '';
      let quoted = false;
      const source = text.replace(/^\uFEFF/, '');
      for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (quoted) {
          if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
          else if (character === '"') quoted = false;
          else field += character;
          continue;
        }
        if (character === '"') { quoted = true; continue; }
        if (character === ',') { row.push(field); field = ''; continue; }
        if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; continue; }
        field += character;
      }
      if (quoted) throw new Error('CSVの引用符が閉じられていません。');
      if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
      return rows;
    }
    function normalizeHeader(value) {
      return String(value || '').trim().replace(/^\uFEFF/, '').toLowerCase().replace(/[\s_－-]/g, '');
    }
    function normalizeCategory(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (['specialist', '専門', '専門競技委員'].includes(normalized)) return 'specialist';
      if (['registered', '登録', '登録競技委員'].includes(normalized)) return 'registered';
      return null;
    }
    function normalizeActive(value) {
      const normalized = String(value ?? '').trim().toLowerCase();
      if (!normalized) return true;
      if (['true', '1', '有効', 'active'].includes(normalized)) return true;
      if (['false', '0', '停止', 'inactive'].includes(normalized)) return false;
      return null;
    }
    function makeSafeRosterId(value, usedIds) {
      let base = String(value || '').trim().normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!base) base = 'officer';
      let candidate = base;
      let counter = 2;
      while (usedIds.has(candidate)) { candidate = `${base}-${counter}`; counter += 1; }
      usedIds.add(candidate);
      return candidate;
    }
    function csvEscape(value) {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }
    async function importRosterCsv(file) {
      if (!file) return;
      setCsvResult('CSVを読み込んでいます…');
      importRosterButton.disabled = true;
      try {
        db = db || createFirebase();
        const rows = parseCsv(await file.text());
        if (!rows.length) throw new Error('CSVが空です。');
        const headers = rows[0].map(normalizeHeader);
        const headerIndex = {
          officerId: headers.findIndex((header) => ['officerid', '競技委員id'].includes(header)),
          officerName: headers.findIndex((header) => ['officername', '競技委員名'].includes(header)),
          category: headers.findIndex((header) => ['category', '区分', 'カテゴリ'].includes(header)),
          active: headers.findIndex((header) => ['active', '有効', '状態'].includes(header)),
          note: headers.findIndex((header) => ['note', 'メモ', '備考'].includes(header))
        };
        if (headerIndex.officerName < 0 || headerIndex.category < 0) throw new Error('ヘッダーに officerName と category が必要です。');
        const existingSnapshot = await db.collection('camera_roster').get();
        const existing = new Map(existingSnapshot.docs.map((doc) => [doc.id, doc.data()]));
        const usedIds = new Set(existing.keys());
        const csvIds = new Set();
        const records = [];
        const errors = [];
        rows.slice(1).forEach((columns, rowOffset) => {
          const line = rowOffset + 2;
          const get = (key) => headerIndex[key] >= 0 ? String(columns[headerIndex[key]] ?? '').trim() : '';
          const officerName = get('officerName');
          const category = normalizeCategory(get('category'));
          const active = normalizeActive(get('active'));
          const suppliedId = get('officerId');
          if (!columns.some((column) => String(column).trim())) return;
          if (!officerName) { errors.push(`${line}行目: officerName が空です。`); return; }
          if (!category) { errors.push(`${line}行目: category を specialist / registered / 専門 / 登録 にしてください。`); return; }
          if (active === null) { errors.push(`${line}行目: active を true/false、1/0、有効/停止にしてください。`); return; }
          if (suppliedId && /[\/\u0000-\u001F]/.test(suppliedId)) { errors.push(`${line}行目: officerId に使用できない文字があります。`); return; }
          const officerId = suppliedId || makeSafeRosterId(officerName, usedIds);
          if (csvIds.has(officerId)) { errors.push(`${line}行目: officerId ${officerId} がCSV内で重複しています。`); return; }
          csvIds.add(officerId);
          if (suppliedId) usedIds.add(officerId);
          records.push({ officerId, officerName, category, active, note: get('note'), line, isExisting: existing.has(officerId) });
        });
        let added = 0;
        let updated = 0;
        for (let start = 0; start < records.length; start += 20) {
          const results = await Promise.all(records.slice(start, start + 20).map(async (record) => {
            const data = { officerId: record.officerId, officerName: record.officerName, category: record.category, active: record.active, note: record.note, updatedAt: serverTime() };
            if (!record.isExisting) data.createdAt = serverTime();
            try {
              await db.collection('camera_roster').doc(record.officerId).set(data, { merge: true });
              return record;
            } catch (writeError) {
              errors.push(`${record.line}行目: 保存できませんでした（${writeError.message}）。`);
              return null;
            }
          }));
          results.filter(Boolean).forEach((record) => { if (record.isExisting) updated += 1; else added += 1; });
        }
        const errorDetail = errors.length ? `\nエラー ${errors.length}件: ${errors.slice(0, 10).join(' / ')}${errors.length > 10 ? ' …' : ''}` : '';
        setCsvResult(`CSVインポート完了: 追加 ${added}件 / 更新 ${updated}件 / エラー ${errors.length}件${errorDetail}`, errors.length ? 'error' : 'success');
      } catch (csvError) {
        setCsvResult(`CSVインポートに失敗しました: ${csvError.message}`, 'error');
      } finally {
        rosterCsvInput.value = '';
        importRosterButton.disabled = false;
      }
    }
    function exportRosterCsv() {
      const rows = [['officerId', 'officerName', 'category', 'active', 'note']];
      [...rosterCache].sort((a, b) => (a.officerId || a.id).localeCompare(b.officerId || b.id)).forEach((officer) => {
        rows.push([officer.officerId || officer.id, officer.officerName || '', officer.category || 'registered', officer.active === false ? 'false' : 'true', officer.note || '']);
      });
      const csv = `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const date = new Date();
      const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      anchor.href = url;
      anchor.download = `ruling_eye_roster_${ymd}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setCsvResult(`CSVをエクスポートしました: ${rows.length - 1}件`, 'success');
    }
    async function saveAssignments() {
      if (!db || !activeTournamentId) return;
      const selected = [...assignmentRosterList.querySelectorAll('[data-assignment-select]:checked')].map((input) => {
        const officer = rosterCache.find((item) => item.id === input.dataset.assignmentSelect);
        const deviceNo = assignmentRosterList.querySelector(`[data-assignment-device="${input.dataset.assignmentSelect}"]`)?.value || '';
        return { officer, deviceNo };
      });
      if (selected.length < 5 || selected.length > 7) { assignmentWarning.textContent = '大会用ロースターは5〜7名を選抜してください。'; assignmentWarning.dataset.tone = 'error'; return; }
      if (selected.some((item) => !item.officer || !item.deviceNo)) { assignmentWarning.textContent = '選抜した全員に端末No.を割り当ててください。'; assignmentWarning.dataset.tone = 'error'; return; }
      const deviceNos = selected.map((item) => item.deviceNo);
      if (new Set(deviceNos).size !== deviceNos.length) { assignmentWarning.textContent = '端末No.は重複して割り当てできません。'; assignmentWarning.dataset.tone = 'error'; return; }
      const hasSpecialist = selected.some((item) => item.officer.category === 'specialist');
      assignmentWarning.textContent = hasSpecialist ? '専門競技委員を含む大会用割当です。' : '警告: 専門競技委員が含まれていません。';
      assignmentWarning.dataset.tone = hasSpecialist ? '' : 'error';
      saveAssignmentsButton.disabled = true;
      try {
        const assignments = db.collection('tournaments').doc(activeTournamentId).collection('camera_assignments');
        const existingByOfficer = new Map(assignmentCache.map((assignment) => [assignment.officerId, assignment]));
        const selectedIds = new Set(selected.map((item) => item.officer.officerId || item.officer.id));
        const batch = db.batch();
        selected.forEach(({ officer, deviceNo }) => {
          const id = officer.officerId || officer.id;
          const existing = existingByOfficer.get(id);
          const ref = assignments.doc(id);
          batch.set(ref, { assignmentId: id, officerId: id, officerName: officer.officerName, category: officer.category, deviceNo, deviceId: `iphone-${deviceNo}`, status: existing?.status || 'assigned', currentSessionId: existing?.currentSessionId || '', qualityMode: existing?.qualityMode || 'standard', qualityLabel: existing?.qualityLabel || '標準', lastSeen: existing?.lastSeen || null, createdAt: existing?.createdAt || serverTime(), updatedAt: serverTime() }, { merge: true });
        });
        assignmentCache.filter((assignment) => !selectedIds.has(assignment.officerId)).forEach((assignment) => batch.delete(assignments.doc(assignment.id)));
        await batch.commit();
      } catch (assignmentError) { showError(error, `大会用割当を保存できませんでした: ${assignmentError.message}`); }
      finally { saveAssignmentsButton.disabled = false; }
    }
    async function watchRoster() {
      try {
        db = db || createFirebase();
        if (unsubscribeRoster) unsubscribeRoster();
        unsubscribeRoster = db.collection('camera_roster').onSnapshot((snapshot) => {
          rosterCache = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
          renderRoster();
          renderAssignmentRoster();
        }, (rosterError) => showError(error, `ロースターを取得できませんでした: ${rosterError.message}`));
      } catch (rosterError) { showError(error, rosterError.message); }
    }
    function renderOfficers(officers) {
      const sorted = officers.sort((a, b) => (a.officerName || '').localeCompare(b.officerName || '', 'ja'));
      officersById = new Map(sorted.map((officer) => [officer.id, officer]));
      if (selectedOfficerData && selectedOfficerData.source !== 'ruling_eye') {
        const refreshedSelection = officersById.get(selectedOfficerData.id);
        if (refreshedSelection) selectOfficer(refreshedSelection);
      }
      officerCount.textContent = sorted.length;
      if (!sorted.length) { officerList.innerHTML = '<p class="camera-empty">待機中の競技委員はいません。</p>'; return; }
      officerList.innerHTML = sorted.map((officer) => {
        const availability = officerAvailability(officer);
        const quality = officer.qualityMode ? `${escapeHtml(officer.qualityLabel || QUALITY_MODES[officer.qualityMode]?.label || officer.qualityMode)}` : '画質未取得';
        const canRequest = availability.key === 'online';
        return `<article class="camera-call-card camera-officer-card" data-availability="${availability.key}">
          <div class="camera-card-top"><span class="camera-card-name">No.${escapeHtml(officer.deviceNo || '-')} / ${escapeHtml(officer.officerName || '名前未入力')}</span><span class="camera-card-status">${availability.label}</span></div>
          <div class="camera-card-meta"><span>${categoryLabel(officer.category)} / ${quality}</span><time>${formatTime(officer.lastSeen)}</time></div>
          <button class="camera-button camera-button-primary" type="button" data-select-officer="${escapeHtml(officer.id)}" ${canRequest ? '' : 'disabled'}>呼出</button>
        </article>`;
      }).join('');
    }
    function selectedOfficerCanRequest(officer = selectedOfficerData) {
      if (!officer) return false;
      if (officer.source === 'ruling_eye') {
        return rulingEyeCandidateAvailability(officer).key === 'online'
          && officer.status === 'active'
          && ['chief', 'officer'].includes(officer.loginRole)
          && Boolean(officer.deviceNo && officer.officerId && officer.officerName);
      }
      return officerAvailability(officer).key === 'online';
    }
    function selectOfficer(officer) {
      if (!officer) return;
      selectedOfficerData = officer;
      if (officer.source === 'ruling_eye') {
        const availability = rulingEyeCandidateAvailability(officer);
        selectedOfficer.textContent = `選択中: No.${officer.deviceNo} ${officer.officerName}（${officer.roleLabel} / ${availability.label}）`;
        renderRulingEyeCallCandidates();
      } else {
        selectedOfficer.textContent = `選択中: No.${officer.deviceNo || '-'} ${officer.officerName}（${officerAvailability(officer).label}）`;
      }
      sendRequestButton.disabled = !selectedOfficerCanRequest(officer);
      requestHole.focus();
    }
    function renderHqCalls(calls) {
      const sorted = calls.sort((a, b) => (b.requestedAt?.toMillis?.() || 0) - (a.requestedAt?.toMillis?.() || 0));
      if (!sorted.length) {
        hqCallList.innerHTML = '<p class="camera-empty">映像依頼はありません。</p>';
        updateViewingGuardUi();
        return;
      }
      hqCallList.innerHTML = sorted.map((call) => {
        const statusLabel = { requested: '依頼中', accepted: '受付済み', connected: '接続中', declined: '対応不可', ended: '完了', missed: '未応答' }[call.status] || call.status;
        const canReview = call.sessionId && ['accepted', 'connected'].includes(call.status);
        return `<article class="camera-call-card" data-status="${escapeHtml(call.status || '')}">
          <div class="camera-card-top"><span class="camera-card-name">No.${escapeHtml(call.deviceNo || '-')} / ${escapeHtml(call.targetOfficerName || '競技委員')}</span><span class="admin-state-badge state-call-${escapeHtml(call.status || 'unknown')}">${escapeHtml(statusLabel)}</span></div>
          <div class="camera-card-meta"><span>${escapeHtml(call.hole || '-')}H / ${escapeHtml(call.groupNo || '-')}組</span><time>${formatTime(call.requestedAt)}</time></div>
          <div class="camera-card-meta"><span>${escapeHtml(call.reason || '本部確認')}</span><span>${call.sessionId ? 'session準備済み' : ''}</span></div>
          ${canReview ? `<button class="camera-button camera-button-primary" type="button" data-review-call="${escapeHtml(call.sessionId)}">映像を確認</button>` : ''}
        </article>`;
      }).join('');
      updateViewingGuardUi();
    }
    async function sendHqRequest() {
      const hole = requestHole.value.trim();
      const groupNo = requestGroupNo.value.trim();
      if (!db || !activeTournamentId || !selectedOfficerData || !hole || !groupNo) {
        showError(error, '競技委員、ホール番号、組番号を入力して映像依頼を送信してください。'); return;
      }
      if (!selectedOfficerCanRequest()) {
        showError(error, '対象端末は現在待機中ではないため、映像依頼を送信できません。最新の端末状態を確認してください。');
        sendRequestButton.disabled = true;
        return;
      }
      sendRequestButton.disabled = true;
      try {
        const callRef = db.collection('tournaments').doc(activeTournamentId).collection('camera_calls').doc();
        const tournamentName = selectedOfficerData.tournamentName
          || rulingEyeAdminData?.setting?.tournamentName
          || activeTournamentId;
        const requestMode = selectedOfficerData.source === 'ruling_eye'
          ? 'ruling_eye_admin'
          : 'hq_to_officer';
        await callRef.set({
          callId: callRef.id,
          tournamentId: activeTournamentId,
          tournamentName,
          targetOfficerId: selectedOfficerData.officerId || selectedOfficerData.id,
          targetOfficerName: selectedOfficerData.officerName || '',
          targetLoginRole: selectedOfficerData.loginRole || '',
          targetRoleLabel: selectedOfficerData.roleLabel || roleLabel(selectedOfficerData.loginRole),
          deviceNo: String(selectedOfficerData.deviceNo || ''),
          loginSessionId: selectedOfficerData.sessionId || '',
          assignmentId: selectedOfficerData.assignmentId || selectedOfficerData.id || '',
          hole,
          groupNo,
          reason: requestReason.value,
          status: 'requested',
          requestMode,
          sessionId: '',
          requestedBy: 'HQ',
          requestedAt: serverTime(),
          updatedAt: serverTime(),
          acceptedAt: null,
          connectedAt: null,
          endedAt: null,
          memo: ''
        });
        requestHole.value = ''; requestGroupNo.value = '';
        const sentMessage = `No.${selectedOfficerData.deviceNo || '-'} ${selectedOfficerData.officerName}へ映像依頼を送信しました。`;
        setStatus(status, sentMessage, 'calling');
        if (selectedOfficerData.source === 'ruling_eye') setRulingEyeAdminStatus(sentMessage, 'success');
      } catch (requestError) {
        showError(error, `映像依頼を送信できませんでした: ${requestError.message}`);
      } finally {
        sendRequestButton.disabled = !selectedOfficerCanRequest();
      }
    }

    function reportRemoteVideoMetadata() {
      const width = remoteVideo.videoWidth;
      const height = remoteVideo.videoHeight;
      debug('remoteMetadata', `remoteVideo: ${width} × ${height}`);
      debug('remoteFrame', width === 0 || height === 0 ? '映像フレーム未取得' : '表示レイヤー確認');
      setPlaceholderVisible(remotePlaceholder, false);
    }
    remoteVideo.addEventListener('loadedmetadata', reportRemoteVideoMetadata);
    remoteVideo.addEventListener('resize', reportRemoteVideoMetadata);

    function resetViewer() {
      if (unsubscribeOfferCandidates) unsubscribeOfferCandidates();
      if (unsubscribeActiveSession) unsubscribeActiveSession();
      unsubscribeOfferCandidates = null; unsubscribeActiveSession = null;
      closePeer(peer); peer = null; queuedCandidates = [];
      iceCandidatesReceived = 0;
      activeSession = null;
      activeCallRef = null;
      activeOfficerRef = null;
      activeAssignmentRef = null;
      clearCurrentViewingSession();
      remoteVideo.srcObject = null;
      remoteVideo.muted = true;
      setPlaceholderVisible(remotePlaceholder, true, '接続する呼出を選択してください');
      manualPlayButton.hidden = true;
      manualPlayButton.disabled = false;
      reloadVideoButton.hidden = true;
      reloadVideoButton.disabled = false;
      unmuteButton.hidden = true;
      viewerTitle.textContent = '映像確認';
      viewerState.textContent = '未接続'; viewerState.dataset.state = 'idle';
      qualityDisplay.textContent = '画質: 未取得';
      memo.value = ''; completeButton.disabled = true;
      debug('offer', 'offer未受信');
      debug('answer', 'answer未作成');
      debug('ice', 'ICE候補待機中');
      debug('remote', 'remote stream待機中');
      debug('quality', '受信中画質モード: 未取得');
      debug('playback', 'muted再生待機中');
      debug('manual', '手動再生不要');
      debug('audio', '音声OFF');
    }
    async function playRemoteVideo({ manual = false } = {}) {
      // 映像を優先するため、常に muted 状態から再生を開始します。
      remoteVideo.muted = true;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      debug('playback', 'muted再生試行');
      try {
        await remoteVideo.play();
        debug('playback', 'muted再生成功');
        debug('videoPlayback', '映像再生成功');
        setPlaceholderVisible(remotePlaceholder, false);
        manualPlayButton.hidden = true;
        unmuteButton.hidden = false;
        if (manual) debug('manual', '手動再生成功');
        return true;
      } catch (playError) {
        console.warn('リモート映像の再生がブロックされました', playError);
        debug('playback', 'muted再生失敗');
        debug('videoPlayback', '映像再生失敗');
        manualPlayButton.hidden = false;
        manualPlayButton.disabled = false;
        debug('manual', '手動再生ボタン表示');
        // WebRTC接続は閉じず、警告と手動操作だけを表示します。
        showError(error, '映像ストリームは受信しましたが再生できませんでした。ブラウザの自動再生設定を確認してください。「映像を表示」を押してください。');
        return false;
      }
    }
    function renderCalls(sessions) {
      const displaySessions = sessions.filter((item) => item.status === 'calling' || item.status === 'connected').sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || 0; const bTime = b.createdAt?.toMillis?.() || 0; return aTime - bTime;
      });
      callCount.textContent = displaySessions.length;
      if (!displaySessions.length) {
        callList.innerHTML = '<p class="camera-empty">現在、呼出はありません。</p>';
        updateViewingGuardUi();
        return;
      }
      callList.innerHTML = displaySessions.map((item) => `
        <article class="camera-call-card" data-status="${item.status}" data-session-id="${escapeHtml(item.id)}">
          <div class="camera-card-top"><span class="camera-card-name">${escapeHtml(item.officerName || '名前未入力')}</span><span class="camera-card-status">${item.status === 'connected' ? '対応中' : '呼出中'}</span></div>
          <div class="camera-card-meta"><span>${escapeHtml(item.hole || '-')}H / ${escapeHtml(item.groupNo || '-')}組</span><time>${formatTime(item.createdAt)}</time></div>
          <button class="camera-button camera-button-primary" type="button" data-connect="${escapeHtml(item.id)}">${item.status === 'connected' ? '映像を確認' : '接続'}</button>
        </article>`).join('');
      updateViewingGuardUi();
    }
    async function watchCalls() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      showError(error, '');
      if (!tournamentId) { setStatus(status, '大会IDを入力してください', 'error'); return; }
      if (hasActiveViewingSession()) {
        showViewingSessionGuard('monitoring-restart');
        return;
      }
      try {
        const tournamentChanged = activeTournamentId !== tournamentId;
        db = db || createFirebase();
        setAdminMonitoringStatus('監視開始中', 'starting');
        if (unsubscribeCalls) unsubscribeCalls();
        if (unsubscribeOfficers) unsubscribeOfficers();
        if (unsubscribeHqCalls) unsubscribeHqCalls();
        if (unsubscribeAssignments) unsubscribeAssignments();
        resetViewer();
        activeTournamentId = tournamentId;
        if (adminTournamentId) adminTournamentId.textContent = tournamentId;
        assignmentCache = [];
        if (tournamentChanged) {
          rulingEyeAdminData = null;
          rulingEyeCallCandidates = [];
          rulingEyeCandidatesBySessionId = new Map();
          officersCache = [];
          renderAdminMonitorGrid(null);
          if (rulingEyeCallCandidateList) {
            rulingEyeCallCandidateList.innerHTML = '<p class="camera-empty">「最新データ取得」を押してRuling Eye呼出対象を表示してください。</p>';
          }
          if (adminTournamentName) adminTournamentName.textContent = '未読込';
          if (adminLastLoaded) adminLastLoaded.textContent = '-';
        }
        renderAssignmentRoster();
        selectedOfficerData = null;
        selectedOfficer.textContent = '待機中の競技委員を選択してください';
        sendRequestButton.disabled = true;
        setStatus(status, '呼出を監視中', 'connected');
        callList.innerHTML = '<p class="camera-empty">呼出を確認しています…</p>';
        officerList.innerHTML = '<p class="camera-empty">待機中の競技委員を確認しています…</p>';
        hqCallList.innerHTML = '<p class="camera-empty">映像依頼を確認しています…</p>';
        unsubscribeCalls = db.collection('tournaments').doc(tournamentId).collection('camera_sessions').where('status', 'in', ['calling', 'connected']).onSnapshot((snapshot) => {
          renderCalls(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        }, (err) => { showError(error, `呼出の取得に失敗しました: ${err.message}`); setStatus(status, '監視エラー', 'error'); });
        unsubscribeOfficers = db.collection('tournaments').doc(tournamentId).collection('camera_officers').onSnapshot((snapshot) => {
          officersCache = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
          setAdminMonitoringStatus('自動監視中', 'active');
          renderRulingEyeCallCandidates();
        }, (err) => {
          setAdminMonitoringStatus('監視エラー', 'error');
          showError(error, `競技委員端末状態を取得できませんでした: ${err.message}`);
        });
        unsubscribeAssignments = db.collection('tournaments').doc(tournamentId).collection('camera_assignments').onSnapshot((snapshot) => {
          assignmentCache = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
          renderAssignmentRoster();
          renderOfficers(assignmentCache);
        }, (err) => showError(error, `大会用割当を取得できませんでした: ${err.message}`));
        if (!officerRefreshTimer) {
          officerRefreshTimer = setInterval(() => {
            renderOfficers(assignmentCache);
            renderRulingEyeCallCandidates();
          }, 15000);
        }
        unsubscribeHqCalls = db.collection('tournaments').doc(tournamentId).collection('camera_calls').onSnapshot((snapshot) => {
          renderHqCalls(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        }, (err) => showError(error, `本部からの映像依頼を取得できませんでした: ${err.message}`));
      } catch (err) {
        setAdminMonitoringStatus('監視エラー', 'error');
        showError(error, err.message);
        setStatus(status, 'Firebase設定エラー', 'error');
      }
    }
    async function addOrQueueCandidate(candidate) {
      iceCandidatesReceived += 1;
      debug('ice', `ICE候補受信: ${iceCandidatesReceived}件`);
      if (!peer?.remoteDescription) { queuedCandidates.push(candidate); return; }
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    }
    async function connect(sessionId) {
      if (!db || !activeTournamentId) return;
      const requestedSessionId = String(sessionId || '');
      if (!requestedSessionId) return;
      if (hasActiveViewingSession()) {
        if (currentViewingSessionId !== requestedSessionId) {
          showViewingSessionGuard(requestedSessionId);
          return;
        }
        showError(error, '');
        setStatus(status, `現在 ${currentViewingLabel()} の映像を確認中です`, 'connected');
        debug('viewingGuard', `同一セッションを確認中: ${currentViewingSessionId}`);
        return;
      }
      resetViewer();
      setCurrentViewingSession({ sessionId: requestedSessionId });
      showError(error, '');
      const ref = sessionRef(db, activeTournamentId, sessionId);
      try {
        const snapshot = await ref.get();
        if (!snapshot.exists || snapshot.data().status === 'ended') throw new Error('この呼出は終了しています。');
        const data = snapshot.data();
        if (!data.offer) throw new Error('競技委員側の接続準備を待っています。数秒後にもう一度お試しください。');
        debug('offer', 'offer受信');
        setCurrentViewingSession({
          sessionId: requestedSessionId,
          callId: data.callId,
          officerName: data.officerName,
          deviceNo: data.deviceNo
        });
        activeSession = ref;
        activeCallRef = data.callId ? db.collection('tournaments').doc(activeTournamentId).collection('camera_calls').doc(data.callId) : null;
        activeOfficerRef = data.officerId ? db.collection('tournaments').doc(activeTournamentId).collection('camera_officers').doc(data.officerId) : null;
        activeAssignmentRef = data.assignmentId ? db.collection('tournaments').doc(activeTournamentId).collection('camera_assignments').doc(data.assignmentId) : null;
        updateQualityDisplay(data);
        viewerTitle.textContent = `${data.officerName || '競技委員'}（${data.hole || '-'}H / ${data.groupNo || '-'}組）`;
        viewerState.textContent = '接続中'; viewerState.dataset.state = 'calling';
        setPlaceholderVisible(remotePlaceholder, true, '映像を接続しています…');
        peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        peer.addTransceiver('video', { direction: 'recvonly' }); peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.ontrack = (event) => {
          const stream = event.streams[0] || new MediaStream([event.track]);
          // WebRTC受信ストリームを必ず video 要素に設定します。
          remoteVideo.srcObject = stream;
          remoteVideo.muted = true;
          remoteVideo.autoplay = true;
          remoteVideo.playsInline = true;
          setPlaceholderVisible(remotePlaceholder, false);
          reloadVideoButton.hidden = false;
          debug('remote', 'remote stream受信');
          if (event.track.kind === 'video') playRemoteVideo();
        };
        peer.onicecandidate = (event) => { if (event.candidate) ref.collection('answerCandidates').add(event.candidate.toJSON()).catch(console.warn); };
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === 'connected') { viewerState.textContent = '接続中'; viewerState.dataset.state = 'connected'; setStatus(status, '映像を確認中', 'connected'); }
          if (peer?.connectionState === 'failed') {
            showError(error, '映像接続に失敗しました。ネットワークまたはTURNサーバーの設定を確認してください。');
            resetViewer();
            debug('viewingGuard', '接続失敗のため対応中ガードを解除');
            setStatus(status, '映像接続に失敗しました', 'error');
          }
        };
        await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
        for (const candidate of queuedCandidates) await peer.addIceCandidate(new RTCIceCandidate(candidate));
        queuedCandidates = [];
        unsubscribeOfferCandidates = ref.collection('offerCandidates').onSnapshot((candidateSnapshot) => {
          candidateSnapshot.docChanges().forEach((change) => { if (change.type === 'added') addOrQueueCandidate(change.doc.data()).catch(console.warn); });
        });
        const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        debug('answer', 'answer作成');
        await ref.update({ answer: { type: answer.type, sdp: answer.sdp }, status: 'connected', connectedAt: serverTime(), hqUser: 'HQ' });
        if (activeCallRef) activeCallRef.update({ status: 'connected', connectedAt: serverTime() }).catch(console.warn);
        if (activeOfficerRef) activeOfficerRef.update({ status: 'busy', currentSessionId: ref.id, lastSeen: serverTime(), updatedAt: serverTime() }).catch(console.warn);
        if (activeAssignmentRef) activeAssignmentRef.update({ status: 'busy', currentSessionId: ref.id, lastSeen: serverTime(), updatedAt: serverTime() }).catch(console.warn);
        memo.value = data.memo || '';
        completeButton.disabled = false;
        unsubscribeActiveSession = ref.onSnapshot((sessionSnapshot) => {
          const current = sessionSnapshot.data();
          if (current) updateQualityDisplay(current);
          if (current?.status === 'ended') { resetViewer(); setStatus(status, '競技委員側で終了しました'); }
        });
      } catch (err) {
        console.error(err);
        showError(error, `接続できませんでした: ${err.message}`);
        resetViewer();
        debug('viewingGuard', '接続失敗のため対応中ガードを解除');
        setStatus(status, '映像接続に失敗しました', 'error');
      }
    }
    async function complete() {
      if (!activeSession) return;
      const session = activeSession;
      const callRef = activeCallRef;
      const officerRef = activeOfficerRef;
      const assignmentRef = activeAssignmentRef;
      completeButton.disabled = true;
      try {
        await session.update({ status: 'ended', endedAt: serverTime(), memo: memo.value.trim() });
        if (callRef) await callRef.update({ status: 'ended', endedAt: serverTime(), memo: memo.value.trim() });
        if (officerRef) await officerRef.set({ status: 'online', currentSessionId: '', lastSeen: serverTime(), updatedAt: serverTime() }, { merge: true });
        if (assignmentRef) await assignmentRef.set({ status: 'online', currentSessionId: '', lastSeen: serverTime(), updatedAt: serverTime() }, { merge: true });
        resetViewer(); setStatus(status, '対応を完了しました');
      } catch (err) { showError(error, `対応完了を保存できませんでした: ${err.message}`); completeButton.disabled = false; }
    }
    watchButton.addEventListener('click', watchCalls);
    if (loadRulingEyeAdminButton) loadRulingEyeAdminButton.addEventListener('click', () => loadRulingEyeCameraAdminData());
    tournamentInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') watchCalls(); });
    callList.addEventListener('click', (event) => { const button = event.target.closest('[data-connect]'); if (button) connect(button.dataset.connect); });
    officerList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-select-officer]');
      if (button) selectOfficer(officersById.get(button.dataset.selectOfficer));
    });
    if (rulingEyeCallCandidateList) {
      rulingEyeCallCandidateList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-select-ruling-eye]');
        if (!button) return;
        const candidate = rulingEyeCandidatesBySessionId.get(button.dataset.selectRulingEye);
        if (candidate) selectOfficer(candidate);
      });
    }
    if (adminMonitorGrid) {
      adminMonitorGrid.addEventListener('click', (event) => {
        const card = event.target.closest('[data-monitor-device]');
        if (card) handleAdminMonitorCard(card.dataset.monitorDevice);
      });
      adminMonitorGrid.addEventListener('keydown', (event) => {
        const card = event.target.closest('[data-monitor-device]');
        if (!card || event.target !== card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        handleAdminMonitorCard(card.dataset.monitorDevice);
      });
    }
    hqCallList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-review-call]');
      if (button) connect(button.dataset.reviewCall);
    });
    sendRequestButton.addEventListener('click', sendHqRequest);
    saveRosterButton.addEventListener('click', saveRoster);
    cancelRosterEditButton.addEventListener('click', resetRosterEditor);
    importRosterButton.addEventListener('click', () => rosterCsvInput.click());
    rosterCsvInput.addEventListener('change', () => importRosterCsv(rosterCsvInput.files?.[0]));
    exportRosterButton.addEventListener('click', exportRosterCsv);
    rosterList.addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit-roster]');
      const toggleButton = event.target.closest('[data-toggle-roster]');
      if (editButton) {
        const officer = rosterCache.find((item) => item.id === editButton.dataset.editRoster);
        if (!officer) return;
        editingRosterId = officer.id;
        rosterOfficerName.value = officer.officerName || '';
        rosterCategory.value = officer.category || 'registered';
        rosterNote.value = officer.note || '';
        saveRosterButton.textContent = 'ロースターを更新';
        cancelRosterEditButton.hidden = false;
      }
      if (toggleButton) {
        const officer = rosterCache.find((item) => item.id === toggleButton.dataset.toggleRoster);
        if (!officer || !db) return;
        try { await db.collection('camera_roster').doc(officer.id).update({ active: officer.active === false, updatedAt: serverTime() }); }
        catch (rosterError) { showError(error, `ロースター状態を更新できませんでした: ${rosterError.message}`); }
      }
    });
    assignmentRosterList.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-assignment-select]');
      if (!checkbox) return;
      const select = assignmentRosterList.querySelector(`[data-assignment-device="${checkbox.dataset.assignmentSelect}"]`);
      if (select) select.disabled = !checkbox.checked;
    });
    saveAssignmentsButton.addEventListener('click', saveAssignments);
    resetRosterEditor();
    renderAdminMonitorGrid();
    watchRoster();
    completeButton.addEventListener('click', complete);
    manualPlayButton.addEventListener('click', () => { playRemoteVideo({ manual: true }); });
    reloadVideoButton.addEventListener('click', () => {
      const stream = remoteVideo.srcObject;
      if (!stream) { showError(error, '再読み込みできる映像ストリームがありません。'); return; }
      remoteVideo.pause();
      remoteVideo.srcObject = null;
      remoteVideo.srcObject = stream;
      remoteVideo.muted = true;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      setPlaceholderVisible(remotePlaceholder, false);
      debug('remote', '映像を再読み込み');
      playRemoteVideo({ manual: true });
    });
    unmuteButton.addEventListener('click', async () => {
      remoteVideo.muted = false;
      try { await remoteVideo.play(); } catch (playError) { console.warn('音声付き再生を開始できませんでした', playError); }
      debug('audio', '音声ON');
    });
    window.addEventListener('pagehide', () => {
      if (unsubscribeCalls) unsubscribeCalls();
      if (unsubscribeOfficers) unsubscribeOfficers();
      if (unsubscribeAssignments) unsubscribeAssignments();
      if (unsubscribeHqCalls) unsubscribeHqCalls();
      if (unsubscribeRoster) unsubscribeRoster();
      if (unsubscribeOfferCandidates) unsubscribeOfferCandidates();
      if (unsubscribeActiveSession) unsubscribeActiveSession();
      if (officerRefreshTimer) clearInterval(officerRefreshTimer);
      closePeer(peer);
      setAdminMonitoringStatus('停止中', 'idle');
    });

    const urlTournamentId = new URLSearchParams(window.location.search).get('tournamentId');
    if (urlTournamentId) {
      tournamentInput.value = cleanTournamentId(urlTournamentId);
      await loadRulingEyeCameraAdminData(tournamentInput.value);
    }
  }

  document.addEventListener('DOMContentLoaded', () => { if (isOfficerPage) startOfficer(); else startAdmin(); });
})();
