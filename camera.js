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
    const incomingCallLocation = $('incomingCallLocation');
    const incomingCallReason = $('incomingCallReason');
    const acceptCallButton = $('acceptCallButton');
    const declineCallButton = $('declineCallButton');
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
    let unsubscribeIncomingCalls;
    let incomingCall;
    let activeCallRef;
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
      waitingState.textContent = busy ? '映像対応中' : online ? '本部呼出待機中' : '待機停止中';
      waitingState.dataset.state = busy ? 'calling' : online ? 'connected' : 'idle';
      startWaitingButton.disabled = online || busy;
      stopWaitingButton.disabled = !online;
    }
    async function updateOfficerStatus(status, extra = {}) {
      if (!officerRef) return;
      await officerRef.set({ status, lastSeen: serverTime(), updatedAt: serverTime(), ...extra }, { merge: true });
      setWaitingUi(status);
    }
    function hideIncomingCall() {
      incomingCallPanel.hidden = true;
      incomingCall = null;
    }
    function showIncomingCall(call) {
      if (activeSession) return;
      incomingCall = call;
      incomingCallLocation.textContent = `${call.hole || '-'}H / ${call.groupNo || '-'}組`;
      incomingCallReason.textContent = `理由: ${call.reason || '本部確認'}`;
      incomingCallPanel.hidden = false;
    }
    async function startWaiting() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      const officerName = nameInput.value.trim();
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
        officerRef = db.collection('tournaments').doc(tournamentId).collection('camera_officers').doc(officerId);
        const existingOfficer = await officerRef.get();
        const officerData = {
          officerId, officerName, status: activeSession ? 'busy' : 'online', currentSessionId: activeSession?.id || '',
          qualityMode, qualityLabel: QUALITY_MODES[qualityMode].label, lastSeen: serverTime(),
          updatedAt: serverTime(), deviceType: deviceType()
        };
        if (!existingOfficer.exists) officerData.createdAt = serverTime();
        await officerRef.set(officerData, { merge: true });
        setWaitingUi(activeSession ? 'busy' : 'online');
        waitingHeartbeat = setInterval(() => {
          updateOfficerStatus(activeSession ? 'busy' : 'online', { currentSessionId: activeSession?.id || '', qualityMode, qualityLabel: QUALITY_MODES[qualityMode].label }).catch(console.warn);
        }, 25000);
        unsubscribeIncomingCalls = db.collection('tournaments').doc(tournamentId).collection('camera_calls').where('targetOfficerId', '==', officerId).onSnapshot((snapshot) => {
          const requested = snapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() })).filter((call) => call.status === 'requested');
          if (requested.length) showIncomingCall(requested.sort((a, b) => (a.requestedAt?.toMillis?.() || 0) - (b.requestedAt?.toMillis?.() || 0))[0]);
          else if (!activeSession) hideIncomingCall();
        }, (listenError) => showError(error, `本部呼出を受信できませんでした: ${listenError.message}`));
      } catch (waitError) {
        showError(error, `待機を開始できませんでした: ${waitError.message}`);
        setWaitingUi('offline');
      }
    }
    async function stopWaiting() {
      if (unsubscribeIncomingCalls) unsubscribeIncomingCalls();
      unsubscribeIncomingCalls = null;
      if (waitingHeartbeat) clearInterval(waitingHeartbeat);
      waitingHeartbeat = null;
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
        try { await callRef.update({ status: 'ended', endedAt: serverTime() }); } catch (err) { console.warn('呼出終了状態を保存できませんでした', err); }
      }
      activeCallRef = null;
      updateOfficerStatus('online', { currentSessionId: '' }).catch(console.warn);
      setStatus(status, '終了しました');
    }

    async function makeCall(hqCall = null) {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      const officerName = hqCall?.targetOfficerName || nameInput.value.trim();
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
          officerId, officerName, hole, groupNo, status: 'calling', roomId, createdAt: serverTime(), connectedAt: null, endedAt: null,
          memo: '', hqUser: '', callId: hqCall?.id || '', requestMode: hqCall ? 'hq_to_officer' : 'officer_manual', reason: hqCall?.reason || '', ...currentQualityData()
        };
        if (activeCallRef) {
          const batch = db.batch();
          batch.set(activeSession, sessionData);
          batch.update(activeCallRef, { status: 'accepted', sessionId: activeSession.id, acceptedAt: serverTime() });
          await batch.commit();
        } else {
          await activeSession.set(sessionData);
        }
        await updateOfficerStatus('busy', { currentSessionId: activeSession.id, qualityMode, qualityLabel: QUALITY_MODES[qualityMode].label });

        peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));
        peer.onicecandidate = (event) => {
          if (event.candidate) activeSession.collection('offerCandidates').add(event.candidate.toJSON()).catch(console.warn);
        };
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === 'connected') {
            setStatus(status, '本部と接続中', 'connected'); debug('hq', '本部接続済み');
            if (activeCallRef) activeCallRef.update({ status: 'connected', connectedAt: serverTime() }).catch(console.warn);
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
            if (callRef) callRef.update({ status: 'ended', endedAt: serverTime() }).catch(console.warn);
            activeCallRef = null;
            updateOfficerStatus('online', { currentSessionId: '' }).catch(console.warn);
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
        if (callRef) callRef.update({ status: 'missed', endedAt: serverTime() }).catch(console.warn);
        activeCallRef = null;
        updateOfficerStatus('online', { currentSessionId: '' }).catch(console.warn);
        setStatus(status, '開始できませんでした', 'error');
        return false;
      }
    }

    startButton.addEventListener('click', () => { makeCall(); });
    endButton.addEventListener('click', () => endCall());
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
        await call.ref.update({ status: 'declined', endedAt: serverTime() });
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
      if (activeSession) activeSession.update({ status: 'ended', endedAt: serverTime() });
      if (officerRef) officerRef.update({ status: 'offline', lastSeen: serverTime(), updatedAt: serverTime() }).catch(() => {});
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
    const status = $('adminConnectionStatus');
    const error = $('adminError');
    const remoteVideo = $('remoteVideo');
    const remotePlaceholder = $('remotePlaceholder');
    const viewerTitle = $('viewerTitle');
    const viewerState = $('viewerState');
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
    debug('signaling', '接続する呼出を選択してください');

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
    function renderOfficers(officers) {
      const sorted = officers.sort((a, b) => (a.officerName || '').localeCompare(b.officerName || '', 'ja'));
      officersById = new Map(sorted.map((officer) => [officer.id, officer]));
      if (selectedOfficerData) {
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
          <div class="camera-card-top"><span class="camera-card-name">${escapeHtml(officer.officerName || '名前未入力')}</span><span class="camera-card-status">${availability.label}</span></div>
          <div class="camera-card-meta"><span>${quality}</span><time>${formatTime(officer.lastSeen)}</time></div>
          <button class="camera-button camera-button-primary" type="button" data-select-officer="${escapeHtml(officer.id)}" ${canRequest ? '' : 'disabled'}>呼出</button>
        </article>`;
      }).join('');
    }
    function selectOfficer(officer) {
      if (!officer) return;
      selectedOfficerData = officer;
      selectedOfficer.textContent = `選択中: ${officer.officerName}（${officerAvailability(officer).label}）`;
      sendRequestButton.disabled = officerAvailability(officer).key !== 'online';
    }
    function renderHqCalls(calls) {
      const sorted = calls.sort((a, b) => (b.requestedAt?.toMillis?.() || 0) - (a.requestedAt?.toMillis?.() || 0));
      if (!sorted.length) { hqCallList.innerHTML = '<p class="camera-empty">映像依頼はありません。</p>'; return; }
      hqCallList.innerHTML = sorted.map((call) => {
        const statusLabel = { requested: '依頼中', accepted: '受付済み', connected: '接続中', declined: '辞退', ended: '完了', missed: '未応答' }[call.status] || call.status;
        const canReview = call.sessionId && ['accepted', 'connected'].includes(call.status);
        return `<article class="camera-call-card" data-status="${escapeHtml(call.status || '')}">
          <div class="camera-card-top"><span class="camera-card-name">${escapeHtml(call.targetOfficerName || '競技委員')}</span><span class="camera-card-status">${escapeHtml(statusLabel)}</span></div>
          <div class="camera-card-meta"><span>${escapeHtml(call.hole || '-')}H / ${escapeHtml(call.groupNo || '-')}組</span><time>${formatTime(call.requestedAt)}</time></div>
          <div class="camera-card-meta"><span>${escapeHtml(call.reason || '本部確認')}</span><span>${call.sessionId ? 'session準備済み' : ''}</span></div>
          ${canReview ? `<button class="camera-button camera-button-primary" type="button" data-review-call="${escapeHtml(call.sessionId)}">映像を確認</button>` : ''}
        </article>`;
      }).join('');
    }
    async function sendHqRequest() {
      const hole = requestHole.value.trim();
      const groupNo = requestGroupNo.value.trim();
      if (!db || !activeTournamentId || !selectedOfficerData || !hole || !groupNo) {
        showError(error, '競技委員、ホール番号、組番号を入力して映像依頼を送信してください。'); return;
      }
      sendRequestButton.disabled = true;
      try {
        await db.collection('tournaments').doc(activeTournamentId).collection('camera_calls').add({
          targetOfficerId: selectedOfficerData.officerId || selectedOfficerData.id,
          targetOfficerName: selectedOfficerData.officerName || '', hole, groupNo, reason: requestReason.value,
          status: 'requested', sessionId: '', requestedBy: 'HQ', requestedAt: serverTime(), acceptedAt: null,
          connectedAt: null, endedAt: null, memo: ''
        });
        requestHole.value = ''; requestGroupNo.value = '';
        setStatus(status, `${selectedOfficerData.officerName}へ映像依頼を送信しました`, 'calling');
      } catch (requestError) {
        showError(error, `映像依頼を送信できませんでした: ${requestError.message}`);
      } finally {
        sendRequestButton.disabled = !selectedOfficerData || officerAvailability(selectedOfficerData).key !== 'online';
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
      if (!displaySessions.length) { callList.innerHTML = '<p class="camera-empty">現在、呼出はありません。</p>'; return; }
      callList.innerHTML = displaySessions.map((item) => `
        <article class="camera-call-card" data-status="${item.status}" data-session-id="${escapeHtml(item.id)}">
          <div class="camera-card-top"><span class="camera-card-name">${escapeHtml(item.officerName || '名前未入力')}</span><span class="camera-card-status">${item.status === 'connected' ? '対応中' : '呼出中'}</span></div>
          <div class="camera-card-meta"><span>${escapeHtml(item.hole || '-')}H / ${escapeHtml(item.groupNo || '-')}組</span><time>${formatTime(item.createdAt)}</time></div>
          <button class="camera-button camera-button-primary" type="button" data-connect="${escapeHtml(item.id)}">${item.status === 'connected' ? '映像を確認' : '接続'}</button>
        </article>`).join('');
    }
    async function watchCalls() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      showError(error, '');
      if (!tournamentId) { setStatus(status, '大会IDを入力してください', 'error'); return; }
      try {
        db = db || createFirebase();
        if (unsubscribeCalls) unsubscribeCalls();
        if (unsubscribeOfficers) unsubscribeOfficers();
        if (unsubscribeHqCalls) unsubscribeHqCalls();
        resetViewer();
        activeTournamentId = tournamentId;
        selectedOfficerData = null;
        selectedOfficer.textContent = '競技委員を選択してください';
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
          renderOfficers(officersCache);
        }, (err) => showError(error, `競技委員待機一覧を取得できませんでした: ${err.message}`));
        if (!officerRefreshTimer) officerRefreshTimer = setInterval(() => renderOfficers(officersCache), 15000);
        unsubscribeHqCalls = db.collection('tournaments').doc(tournamentId).collection('camera_calls').onSnapshot((snapshot) => {
          renderHqCalls(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        }, (err) => showError(error, `本部からの映像依頼を取得できませんでした: ${err.message}`));
      } catch (err) { showError(error, err.message); setStatus(status, 'Firebase設定エラー', 'error'); }
    }
    async function addOrQueueCandidate(candidate) {
      iceCandidatesReceived += 1;
      debug('ice', `ICE候補受信: ${iceCandidatesReceived}件`);
      if (!peer?.remoteDescription) { queuedCandidates.push(candidate); return; }
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    }
    async function connect(sessionId) {
      if (!db || !activeTournamentId) return;
      resetViewer(); showError(error, '');
      const ref = sessionRef(db, activeTournamentId, sessionId);
      try {
        const snapshot = await ref.get();
        if (!snapshot.exists || snapshot.data().status === 'ended') throw new Error('この呼出は終了しています。');
        const data = snapshot.data();
        if (!data.offer) throw new Error('競技委員側の接続準備を待っています。数秒後にもう一度お試しください。');
        debug('offer', 'offer受信');
        activeSession = ref;
        activeCallRef = data.callId ? db.collection('tournaments').doc(activeTournamentId).collection('camera_calls').doc(data.callId) : null;
        activeOfficerRef = data.officerId ? db.collection('tournaments').doc(activeTournamentId).collection('camera_officers').doc(data.officerId) : null;
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
          if (peer?.connectionState === 'failed') { showError(error, '映像接続に失敗しました。ネットワークまたはTURNサーバーの設定を確認してください。'); viewerState.textContent = '接続失敗'; viewerState.dataset.state = 'idle'; }
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
        memo.value = data.memo || '';
        completeButton.disabled = false;
        unsubscribeActiveSession = ref.onSnapshot((sessionSnapshot) => {
          const current = sessionSnapshot.data();
          if (current) updateQualityDisplay(current);
          if (current?.status === 'ended') { resetViewer(); setStatus(status, '競技委員側で終了しました'); }
        });
      } catch (err) { console.error(err); showError(error, `接続できませんでした: ${err.message}`); resetViewer(); }
    }
    async function complete() {
      if (!activeSession) return;
      const session = activeSession;
      const callRef = activeCallRef;
      const officerRef = activeOfficerRef;
      completeButton.disabled = true;
      try {
        await session.update({ status: 'ended', endedAt: serverTime(), memo: memo.value.trim() });
        if (callRef) await callRef.update({ status: 'ended', endedAt: serverTime(), memo: memo.value.trim() });
        if (officerRef) await officerRef.update({ status: 'online', currentSessionId: '', lastSeen: serverTime(), updatedAt: serverTime() });
        resetViewer(); setStatus(status, '対応を完了しました');
      } catch (err) { showError(error, `対応完了を保存できませんでした: ${err.message}`); completeButton.disabled = false; }
    }
    watchButton.addEventListener('click', watchCalls);
    tournamentInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') watchCalls(); });
    callList.addEventListener('click', (event) => { const button = event.target.closest('[data-connect]'); if (button) connect(button.dataset.connect); });
    officerList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-select-officer]');
      if (button) selectOfficer(officersById.get(button.dataset.selectOfficer));
    });
    hqCallList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-review-call]');
      if (button) connect(button.dataset.reviewCall);
    });
    sendRequestButton.addEventListener('click', sendHqRequest);
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
  }

  document.addEventListener('DOMContentLoaded', () => { if (isOfficerPage) startOfficer(); else startAdmin(); });
})();
