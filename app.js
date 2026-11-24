/**
 * app.js - Client-Side Orchestration with Non-Blocking Web Worker
 * Warm Editorial Minimalism UI & Feed Experience
 */

import { BlockCanvasReader } from './canvas-reader.js';

// Fallback direct crypto if module worker is not supported
import * as CryptoCore from './crypto-core.mjs';

// In-memory session state (strictly never persisted to storage)
const session = {
  token: '',
  friend: null,     // { name, email }
  posts: [],        // combined chronological posts
  quizData: null,   // { threshold, totalQuestions, questions }
  activePost: null
};

// DOM references
const viewGate1 = document.getElementById('viewGate1');
const viewGate2 = document.getElementById('viewGate2');
const viewFeed = document.getElementById('viewFeed');
const viewReader = document.getElementById('viewReader');

const gate1Form = document.getElementById('gate1Form');
const passphraseInput = document.getElementById('passphraseInput');
const tokenInput = document.getElementById('tokenInput');
const inviteTokenGroup = document.getElementById('inviteTokenGroup');
const gate1SubmitBtn = document.getElementById('gate1SubmitBtn');
const gate1Alert = document.getElementById('gate1Alert');

const quizForm = document.getElementById('quizForm');
const quizListContainer = document.getElementById('quizListContainer');
const quizInstructionText = document.getElementById('quizInstructionText');
const quizSubmitBtn = document.getElementById('quizSubmitBtn');
const gate2Alert = document.getElementById('gate2Alert');

const feedGreeting = document.getElementById('feedGreeting');
const feedFooterNote = document.getElementById('feedFooterNote');
const postsFeedContainer = document.getElementById('postsFeedContainer');

const backToFeedBtn = document.getElementById('backToFeedBtn');
const textSizeDownBtn = document.getElementById('textSizeDownBtn');
const textSizeUpBtn = document.getElementById('textSizeUpBtn');
const articleChunksWrapper = document.getElementById('articleChunksWrapper');

const privacyCurtain = document.getElementById('privacyCurtain');

// Block-level Canvas Reader instance
let blockReader = null;

// Dedicated Web Worker
let cryptoWorker = null;
let workerMsgId = 0;
const workerCallbacks = new Map();

function initWorker() {
  try {
    cryptoWorker = new Worker('crypto-worker.js', { type: 'module' });
    cryptoWorker.onmessage = function (e) {
      const { id, success, data, error, validCount } = e.data;
      const cb = workerCallbacks.get(id);
      if (cb) {
        workerCallbacks.delete(id);
        cb({ success, data, error, validCount });
      }
    };
  } catch (err) {
    console.warn('Module worker could not be spawned, using main thread fallback:', err);
    cryptoWorker = null;
  }
}

/**
 * Dispatch task to Web Worker with in-line fallback
 */
async function callCrypto(type, payload) {
  if (cryptoWorker) {
    return new Promise(resolve => {
      const id = ++workerMsgId;
      workerCallbacks.set(id, resolve);
      cryptoWorker.postMessage({ id, type, payload });
    });
  }

  // Fallback if workers are restricted in environment
  return runCryptoFallback(type, payload);
}

async function runCryptoFallback(type, payload) {
  try {
    if (type === 'DECRYPT_QUESTIONS') {
      const { groupPassphrase, questionsEnc } = payload;
      const norm = CryptoCore.normalizeAnswer(groupPassphrase);
      const qKey = await CryptoCore.deriveKeyPBKDF2(norm, questionsEnc.salt, 210000);
      const str = await CryptoCore.tryDecryptAESGCMString(qKey, questionsEnc.iv, questionsEnc.ciphertext);
      if (!str) return { success: false, error: 'INVALID_PASSPHRASE' };
      return { success: true, data: JSON.parse(str) };
    }

    if (type === 'VERIFY_AND_UNLOCK') {
      const { answers, sharesJson, keysJson, postsEnc, token, threshold } = payload;
      const validShares = [];
      for (const item of answers) {
        if (!item.val || !item.val.trim()) continue;
        const rec = sharesJson.find(s => s.questionId === item.id);
        if (!rec) continue;
        const key = await CryptoCore.deriveKeyPBKDF2(CryptoCore.normalizeAnswer(item.val), rec.salt, 210000);
        const shareStr = await CryptoCore.tryDecryptAESGCMString(key, rec.iv, rec.ciphertext);
        if (shareStr) {
          try { validShares.push(JSON.parse(shareStr)); } catch {}
        }
      }

      if (validShares.length < threshold) {
        return { success: false, error: 'INSUFFICIENT_SHARES', validCount: validShares.length };
      }

      const masterKey = CryptoCore.combineShares(validShares.slice(0, threshold));
      const masterKeyHex = CryptoCore.bytesToHex(masterKey);
      const lookupId = await CryptoCore.sha256Hex(`friend:${token}`);
      const env = keysJson[lookupId];
      if (!env) return { success: false, error: 'REVOKED_OR_UNKNOWN_TOKEN' };

      const wrapKey = await CryptoCore.deriveKeyPBKDF2(`${masterKeyHex}:${token}`, env.salt, 210000);
      const payloadStr = await CryptoCore.tryDecryptAESGCMString(wrapKey, env.iv, env.ciphertext);
      if (!payloadStr) return { success: false, error: 'ENVELOPE_DECRYPT_FAILED' };

      const friendPayload = JSON.parse(payloadStr);
      const allPosts = [];
      for (const t of (friendPayload.tiers || ['general'])) {
        if (friendPayload.tierKeys && friendPayload.tierKeys[t] && postsEnc[t]) {
          const rawKey = friendPayload.tierKeys[t];
          const aesKey = await CryptoCore.importRawAesKey(rawKey);
          const pStr = await CryptoCore.decryptAESGCMString(aesKey, postsEnc[t].iv, postsEnc[t].ciphertext);
          allPosts.push(...JSON.parse(pStr));
        }
      }
      allPosts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return {
        success: true,
        data: {
          friend: { name: friendPayload.name, email: friendPayload.email },
          posts: allPosts
        }
      };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ==========================================
// App Initialization
// ==========================================

function init() {
  initWorker();
  initTheme();
  initInvisibleToken();
  initPrivacyCurtain();

  blockReader = new BlockCanvasReader(articleChunksWrapper);

  gate1Form.addEventListener('submit', handleGate1Submit);
  quizForm.addEventListener('submit', handleQuizSubmit);
  backToFeedBtn.addEventListener('click', () => switchView('feed'));

  textSizeDownBtn.addEventListener('click', () => {
    blockReader.setFontSizeStep(blockReader.sizeStep - 1);
  });
  textSizeUpBtn.addEventListener('click', () => {
    blockReader.setFontSizeStep(blockReader.sizeStep + 1);
  });

  document.querySelectorAll('.lock-vault-btn').forEach(btn => {
    btn.addEventListener('click', lockVault);
  });
}

/**
 * 3-Way Theme Support: Paper, Sepia, Late-Night Journal (Dark)
 */
function initTheme() {
  const savedTheme = localStorage.getItem('reading_theme') || 'paper';
  setTheme(savedTheme);

  document.querySelectorAll('.theme-selector').forEach(selector => {
    selector.addEventListener('click', e => {
      const btn = e.target.closest('.theme-pill-btn');
      if (!btn) return;
      const themeVal = btn.dataset.themeVal;
      setTheme(themeVal);
      localStorage.setItem('reading_theme', themeVal);

      // Re-render current article if in reader view
      if (viewReader.classList.contains('active') && session.activePost) {
        blockReader.renderArticle(session.activePost, session.friend);
      }
    });
  });
}

function setTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
  document.querySelectorAll('.theme-pill-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.themeVal === themeName);
  });
}

/**
 * Silently read #token=... from window.location.hash
 * Store ONLY in memory, immediately wipe from address bar
 * Do NOT show any technical banners
 */
function initInvisibleToken() {
  const hash = window.location.hash ? window.location.hash.substring(1) : '';
  let token = '';

  if (hash.startsWith('token=')) {
    token = hash.replace('token=', '').trim();
  } else if (hash && !hash.includes('=')) {
    token = hash.trim();
  }

  if (token) {
    session.token = token;
    // Silently remove from URL
    history.replaceState(null, '', window.location.pathname + window.location.search);
    // Hide manual token input because token is already loaded
    inviteTokenGroup.style.display = 'none';
  } else {
    // Only render quiet invite code input if no hash was present
    inviteTokenGroup.style.display = 'block';
  }
}

// ==========================================
// View Transitions & Gentle Alerts
// ==========================================

function switchView(target) {
  viewGate1.classList.remove('active');
  viewGate2.classList.remove('active');
  viewFeed.classList.remove('active');
  viewReader.classList.remove('active');

  if (target === 'gate1') {
    viewGate1.classList.add('active');
    document.body.classList.add('auth-view');
  } else if (target === 'gate2') {
    viewGate2.classList.add('active');
    document.body.classList.add('auth-view');
  } else if (target === 'feed') {
    viewFeed.classList.add('active');
    document.body.classList.remove('auth-view');
  } else if (target === 'reader') {
    viewReader.classList.add('active');
    document.body.classList.remove('auth-view');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showGentleAlert(el, message) {
  el.textContent = message;
  el.classList.add('visible');
}

function clearGentleAlert(el) {
  el.textContent = '';
  el.classList.remove('visible');
}

function setBtnLoading(btn, isLoading, loadingText = 'Opening...') {
  if (isLoading) {
    btn.disabled = true;
    btn.dataset.origText = btn.innerHTML;
    btn.innerHTML = `<span class="calm-spinner"></span> <span>${loadingText}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origText) {
      btn.innerHTML = btn.dataset.origText;
    }
  }
}

// ==========================================
// Gate 1: Welcome & Questions Decryption
// ==========================================

async function handleGate1Submit(e) {
  e.preventDefault();
  clearGentleAlert(gate1Alert);

  const passphrase = passphraseInput.value.trim();
  if (!passphrase) {
    showGentleAlert(gate1Alert, "Please enter the passphrase.");
    return;
  }

  // If token was not in URL, read from manual input
  if (!session.token) {
    const manualToken = tokenInput.value.trim();
    if (!manualToken) {
      showGentleAlert(gate1Alert, "Please enter your personal invite code.");
      return;
    }
    session.token = manualToken;
  }

  setBtnLoading(gate1SubmitBtn, true, 'Opening...');

  try {
    const res = await fetch('data/questions.enc');
    if (!res.ok) {
      throw new Error("Could not load notes.");
    }
    const questionsEnc = await res.json();

    // Run PBKDF2 off-thread in Web Worker
    const result = await callCrypto('DECRYPT_QUESTIONS', {
      groupPassphrase: passphrase,
      questionsEnc
    });

    if (!result.success) {
      showGentleAlert(gate1Alert, "That passphrase doesn't seem quite right. Double-check and try again.");
      setBtnLoading(gate1SubmitBtn, false);
      return;
    }

    session.quizData = result.data;
    renderQuizView(result.data);
    switchView('gate2');
  } catch (err) {
    console.error(err);
    showGentleAlert(gate1Alert, "Unable to open notes right now. Please try again in a moment.");
  } finally {
    setBtnLoading(gate1SubmitBtn, false);
  }
}

function renderQuizView(quizData) {
  const { threshold, totalQuestions, questions } = quizData;
  quizInstructionText.textContent = `Answer at least ${threshold} of these ${totalQuestions} to step in.`;
  quizListContainer.innerHTML = '';

  questions.forEach((q, idx) => {
    const item = document.createElement('div');
    item.className = 'quiz-item';

    // Use question's hint directly as exact-match formatting placeholder
    const hintPlaceholder = q.hint ? q.hint : 'Your answer...';

    item.innerHTML = `
      <label class="quiz-prompt" for="q_input_${idx}">${escapeHtml(q.prompt)}</label>
      <input type="text" id="q_input_${idx}" class="form-input" data-qid="${q.id}" placeholder="${escapeHtml(hintPlaceholder)}" autocomplete="off">
    `;
    quizListContainer.appendChild(item);
  });
}

// ==========================================
// Gate 2: Quiz Verification & Non-Blocking Worker Decryption
// ==========================================

async function handleQuizSubmit(e) {
  e.preventDefault();
  clearGentleAlert(gate2Alert);

  const inputs = quizListContainer.querySelectorAll('input');
  const answers = [];
  inputs.forEach(input => {
    const qId = input.dataset.qid;
    const val = input.value.trim();
    if (val) {
      answers.push({ id: qId, val });
    }
  });

  const K = session.quizData.threshold;
  if (answers.length < K) {
    showGentleAlert(gate2Alert, `Please answer at least ${K} questions to step in.`);
    return;
  }

  // Non-blocking loading state
  setBtnLoading(quizSubmitBtn, true, 'Unlocking your pages...');

  try {
    const [sharesRes, keysRes, postsRes] = await Promise.all([
      fetch('data/shares.json'),
      fetch('data/keys.json'),
      fetch('data/posts.enc')
    ]);

    if (!sharesRes.ok || !keysRes.ok || !postsRes.ok) {
      throw new Error("Failed to load notes data.");
    }

    const sharesJson = await sharesRes.json();
    const keysJson = await keysRes.json();
    const postsEnc = await postsRes.json();

    // Offload all PBKDF2 derivations, Shamir reconstruction, and envelope unwrapping to Web Worker
    const result = await callCrypto('VERIFY_AND_UNLOCK', {
      answers,
      sharesJson,
      keysJson,
      postsEnc,
      token: session.token,
      threshold: K
    });

    if (!result.success) {
      // Gentle, aggregate human error feedback (never per-question indicators)
      showGentleAlert(
        gate2Alert,
        "Almost there—a few didn't quite match. Double-check spelling or date formats and try again."
      );
      setBtnLoading(quizSubmitBtn, false);
      return;
    }

    session.friend = result.data.friend;
    session.posts = result.data.posts;

    // Render warm personal feed
    renderFeedView();
    switchView('feed');
  } catch (err) {
    console.error(err);
    showGentleAlert(gate2Alert, "Something went wrong while unlocking. Please try again.");
  } finally {
    setBtnLoading(quizSubmitBtn, false);
  }
}

// ==========================================
// Feed View: Seamless Chronological Feed
// ==========================================

function renderFeedView() {
  const friendName = session.friend && session.friend.name ? session.friend.name : 'Friend';
  feedGreeting.textContent = `Hey ${friendName} — glad you're here.`;
  feedFooterNote.textContent = `Shared privately with ${friendName}.`;

  postsFeedContainer.innerHTML = '';

  session.posts.forEach(post => {
    const card = document.createElement('article');
    card.className = 'post-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const isInner = (post.tier === 'inner');
    const innerTagHtml = isInner ? `<span class="inner-circle-tag">Inner Circle</span>` : '';

    card.innerHTML = `
      <div class="post-card-meta ui-text">
        <span class="post-card-date">${escapeHtml(post.date || '')}</span>
        ${innerTagHtml}
      </div>
      <h2 class="post-card-title">${escapeHtml(post.title || 'Untitled')}</h2>
      ${post.summary ? `<p class="post-card-summary">${escapeHtml(post.summary)}</p>` : ''}
    `;

    const openPost = () => {
      session.activePost = post;
      blockReader.renderArticle(post, session.friend);
      switchView('reader');
    };

    card.addEventListener('click', openPost);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPost();
      }
    });

    postsFeedContainer.appendChild(card);
  });
}

// ==========================================
// Lock Vault: Memory Wipe & Clean Return
// ==========================================

function lockVault() {
  // Purge all secrets, keys, and decrypted content from memory
  session.token = '';
  session.friend = null;
  session.posts = [];
  session.quizData = null;
  session.activePost = null;

  // Clear input fields
  passphraseInput.value = '';
  tokenInput.value = '';
  quizListContainer.innerHTML = '';
  articleChunksWrapper.innerHTML = '';

  clearGentleAlert(gate1Alert);
  clearGentleAlert(gate2Alert);

  // Restore invite token field in case user logs in with another token
  inviteTokenGroup.style.display = 'block';

  switchView('gate1');
}

// ==========================================
// Soft Privacy Curtain (Blur-on-Unfocus)
// ==========================================

function initPrivacyCurtain() {
  const showCurtain = () => {
    // Only engage curtain when unlocked in feed or reader view
    if (viewFeed.classList.contains('active') || viewReader.classList.contains('active')) {
      privacyCurtain.classList.add('active');
    }
  };

  const hideCurtain = () => {
    privacyCurtain.classList.remove('active');
  };

  window.addEventListener('blur', showCurtain);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) showCurtain();
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'PrintScreen' || e.keyCode === 44) showCurtain();
  });

  privacyCurtain.addEventListener('click', hideCurtain);
}

// Helper: Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Start application
init();
