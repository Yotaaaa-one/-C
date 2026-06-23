/* global firebase */
(() => {
  'use strict';

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
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
    debug('camera', 'カメラ取得待機中');
    debug('hq', '本部未接続');

    const stopMedia = () => {
      if (localStream) localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      video.srcObject = null;
      placeholder.hidden = false;
    };
    const resetCallControls = () => {
      startButton.disabled = false;
      endButton.disabled = true;
      micButton.disabled = true;
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

    async function endCall({ updateFirestore = true } = {}) {
      const session = activeSession;
      finishLocalCall();
      if (updateFirestore && session) {
        try { await session.update({ status: 'ended', endedAt: serverTime() }); } catch (err) { console.warn('終了状態を保存できませんでした', err); }
      }
      setStatus(status, '終了しました');
    }

    async function makeCall() {
      const tournamentId = cleanTournamentId(tournamentInput.value);
      const officerName = nameInput.value.trim();
      const hole = holeInput.value.trim();
      const groupNo = groupInput.value.trim();
      showError(error, '');
      if (!tournamentId || !officerName || !hole || !groupNo) {
        showError(error, '大会ID、競技委員名、ホール番号、組番号をすべて入力してください。'); return;
      }
      try {
        startButton.disabled = true;
        setStatus(status, 'カメラを起動しています…', 'calling');
        debug('camera', 'カメラ取得中');
        // この呼出はボタン操作から直接実行されるため、iPhone Safari の権限・自動再生制約を満たします。
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (cameraError) {
          debug('camera', `カメラ取得失敗: ${cameraError.name || cameraError.message}`);
          throw cameraError;
        }
        debug('camera', 'カメラ取得成功');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = localStream;
        placeholder.hidden = true;
        if (!await requestVideoPlayback(video)) {
          showError(error, 'カメラは取得できましたが、プレビューを再生できませんでした。Safariのカメラ権限を確認してください。');
          debug('camera', 'カメラ取得成功（プレビュー再生待機）');
        }
        micButton.disabled = false;
        micButton.textContent = 'マイク ON';

        db = db || createFirebase();

        const sessions = db.collection('tournaments').doc(tournamentId).collection('camera_sessions');
        activeSession = sessions.doc();
        const roomId = activeSession.id;
        await activeSession.set({ officerName, hole, groupNo, status: 'calling', roomId, createdAt: serverTime(), connectedAt: null, endedAt: null, memo: '', hqUser: '' });

        peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));
        peer.onicecandidate = (event) => {
          if (event.candidate) activeSession.collection('offerCandidates').add(event.candidate.toJSON()).catch(console.warn);
        };
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === 'connected') { setStatus(status, '本部と接続中', 'connected'); debug('hq', '本部接続済み'); }
          if (['failed', 'disconnected'].includes(peer?.connectionState)) setStatus(status, '接続が切れました。本部を待機中です。', 'calling');
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await activeSession.update({ offer: { type: offer.type, sdp: offer.sdp } });
        setStatus(status, '本部の応答を待っています', 'calling');
        debug('hq', '本部接続中');
        endButton.disabled = false;

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
            finishLocalCall();
            setStatus(status, '本部側で対応完了になりました');
          }
        });
      } catch (err) {
        console.error(err);
        showError(error, `映像共有を開始できませんでした: ${err.message}`);
        if (!localStream) debug('camera', `カメラ取得失敗: ${err.name || err.message}`);
        finishLocalCall();
        setStatus(status, '開始できませんでした', 'error');
      }
    }

    startButton.addEventListener('click', makeCall);
    endButton.addEventListener('click', () => endCall());
    micButton.addEventListener('click', () => {
      const track = localStream?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      micButton.textContent = track.enabled ? 'マイク ON' : 'マイク OFF';
    });
    window.addEventListener('beforeunload', () => { if (activeSession) activeSession.update({ status: 'ended', endedAt: serverTime() }); });
  }

  async function startAdmin() {
    const tournamentInput = $('tournamentId');
    const watchButton = $('watchCallsButton');
    const callList = $('callList');
    const callCount = $('callCount');
    const status = $('adminConnectionStatus');
    const error = $('adminError');
    const remoteVideo = $('remoteVideo');
    const remotePlaceholder = $('remotePlaceholder');
    const viewerTitle = $('viewerTitle');
    const viewerState = $('viewerState');
    const memo = $('memo');
    const completeButton = $('completeButton');
    const debug = createDebugReporter($('adminDebug'));
    let db;
    let activeTournamentId;
    let activeSession;
    let peer;
    let unsubscribeCalls;
    let unsubscribeOfferCandidates;
    let unsubscribeActiveSession;
    let queuedCandidates = [];
    let iceCandidatesReceived = 0;
    debug('signaling', '接続する呼出を選択してください');

    function resetViewer() {
      if (unsubscribeOfferCandidates) unsubscribeOfferCandidates();
      if (unsubscribeActiveSession) unsubscribeActiveSession();
      unsubscribeOfferCandidates = null; unsubscribeActiveSession = null;
      closePeer(peer); peer = null; queuedCandidates = [];
      iceCandidatesReceived = 0;
      activeSession = null;
      remoteVideo.srcObject = null;
      remotePlaceholder.hidden = false;
      viewerTitle.textContent = '映像確認';
      viewerState.textContent = '未接続'; viewerState.dataset.state = 'idle';
      memo.value = ''; completeButton.disabled = true;
      debug('offer', 'offer未受信');
      debug('answer', 'answer未作成');
      debug('ice', 'ICE候補待機中');
      debug('remote', 'remote stream待機中');
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
        resetViewer();
        activeTournamentId = tournamentId;
        setStatus(status, '呼出を監視中', 'connected');
        callList.innerHTML = '<p class="camera-empty">呼出を確認しています…</p>';
        unsubscribeCalls = db.collection('tournaments').doc(tournamentId).collection('camera_sessions').where('status', 'in', ['calling', 'connected']).onSnapshot((snapshot) => {
          renderCalls(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        }, (err) => { showError(error, `呼出の取得に失敗しました: ${err.message}`); setStatus(status, '監視エラー', 'error'); });
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
        viewerTitle.textContent = `${data.officerName || '競技委員'}（${data.hole || '-'}H / ${data.groupNo || '-'}組）`;
        viewerState.textContent = '接続中'; viewerState.dataset.state = 'calling';
        remotePlaceholder.textContent = '映像を接続しています…'; remotePlaceholder.hidden = false;
        peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        // 初期は muted 属性で自動再生可能にし、PC本部では接続時に音声再生も試みます。
        remoteVideo.muted = false;
        peer.addTransceiver('video', { direction: 'recvonly' }); peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.ontrack = (event) => {
          const stream = event.streams[0] || new MediaStream([event.track]);
          // WebRTC受信ストリームを必ず video 要素に設定します。
          remoteVideo.srcObject = stream;
          remoteVideo.autoplay = true;
          remoteVideo.playsInline = true;
          remotePlaceholder.hidden = true;
          requestVideoPlayback(remoteVideo, { mutedFallback: true }).then((started) => {
            debug('remote', started ? 'remote stream受信' : 'remote stream受信（再生待機）');
            if (!started) showError(error, '映像ストリームは受信しましたが再生できませんでした。ブラウザの自動再生設定を確認してください。');
          });
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
        memo.value = data.memo || '';
        completeButton.disabled = false;
        unsubscribeActiveSession = ref.onSnapshot((sessionSnapshot) => {
          const current = sessionSnapshot.data();
          if (current?.status === 'ended') { resetViewer(); setStatus(status, '競技委員側で終了しました'); }
        });
      } catch (err) { console.error(err); showError(error, `接続できませんでした: ${err.message}`); resetViewer(); }
    }
    async function complete() {
      if (!activeSession) return;
      completeButton.disabled = true;
      try {
        await activeSession.update({ status: 'ended', endedAt: serverTime(), memo: memo.value.trim() });
        resetViewer(); setStatus(status, '対応を完了しました');
      } catch (err) { showError(error, `対応完了を保存できませんでした: ${err.message}`); completeButton.disabled = false; }
    }
    watchButton.addEventListener('click', watchCalls);
    tournamentInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') watchCalls(); });
    callList.addEventListener('click', (event) => { const button = event.target.closest('[data-connect]'); if (button) connect(button.dataset.connect); });
    completeButton.addEventListener('click', complete);
  }

  document.addEventListener('DOMContentLoaded', () => { if (isOfficerPage) startOfficer(); else startAdmin(); });
})();
