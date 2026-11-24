/**
 * app.js - Client-Side Orchestration with Non-Blocking Web Worker
 * Warm Editorial Minimalism UI & Feed Experience
 * Refactored for per-friend question packages and multi-answer share matching.
 */

import { BlockCanvasReader } from './canvas-reader.js';
import * as CryptoCore from './crypto-core.mjs';

// In-memory session state (strictly never persisted to storage)
const session = {
  token: '',
  friend: null,          // { name, email }
  posts: [],             // combined chronological posts
  friendPackage: null,   // { questionsEnc, shares, envelopeEnc }
  quizData: null,        // { poolSize, questionsShown, threshold, questions }
  sampledQuestions: [],  // randomly sampled 5 questions
  activePost: null
};

// DOM references
const viewGate1 = document.getElementById('viewGate1');
const viewGate2 = document.getElementById('viewGate2');
const viewFeed = document.getElementById('viewFeed');
const viewReader = document.getElementById('viewReader');

const gate1Form = document.getElementById('gate1Form');
const tokenInput = document.getElementById('tokenInput');
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

  return runCryptoFallback(type, payload);
}

async function runCryptoFallback(type, payload) {
  try {
    if (type === 'DECRYPT_FRIEND_QUESTIONS') {
      const { token, questionsEnc } = payload;
      const qKey = await CryptoCore.deriveKeyPBKDF2(token, questionsEnc.salt, 210000);
      const plainStr = await CryptoCore.tryDecryptAESGCMString(qKey, questionsEnc.iv, questionsEnc.ciphertext);
      if (!plainStr) return { success: false, error: 'INVALID_TOKEN' };
      return { success: true, data: JSON.parse(plainStr) };
    }

    if (type === 'VERIFY_AND_UNLOCK') {
      const { answers, shares, envelopeEnc, postsEnc, token, threshold } = payload;

      const sharesByQ = new Map();
      for (const s of shares) {
        if (!sharesByQ.has(s.questionId)) sharesByQ.set(s.questionId, []);
        sharesByQ.get(s.questionId).push(s);
      }

      const validSharesMap = new Map();
      for (const item of answers) {
        if (!item.val || !item.val.trim()) continue;
        const matchingShares = sharesByQ.get(item.id);
        if (!matchingShares) continue;

        const normAns = CryptoCore.normalizeAnswer(item.val);
        for (const sRecord of matchingShares) {
          const shareKey = await CryptoCore.deriveKeyPBKDF2(normAns, sRecord.salt, 210000);
          const decryptedShareStr = await CryptoCore.tryDecryptAESGCMString(shareKey, sRecord.iv, sRecord.ciphertext);
          if (decryptedShareStr) {
            try {
              const shareObj = JSON.parse(decryptedShareStr);
              if (shareObj && typeof shareObj.x === 'number' && shareObj.y) {
                validSharesMap.set(item.id, shareObj);
                break;
              }
            } catch {}
          }
        }
      }

      const validShares = Array.from(validSharesMap.values());
      if (validShares.length < threshold) {
        return { success: false, error: 'INSUFFICIENT_SHARES', validCount: validShares.length };
      }

      const friendKeyBytes = CryptoCore.combineShares(validShares.slice(0, threshold));
      const friendKeyHex = CryptoCore.bytesToHex(friendKeyBytes);

      const envWrapPass = `${friendKeyHex}:${token}`;
      const envWrapKey = await CryptoCore.deriveKeyPBKDF2(envWrapPass, envelopeEnc.salt, 210000);
      const envelopeStr = await CryptoCore.tryDecryptAESGCMString(envWrapKey, envelopeEnc.iv, envelopeEnc.ciphertext);
      if (!envelopeStr) return { success: false, error: 'ENVELOPE_DECRYPT_FAILED' };

      const friendPayload = JSON.parse(envelopeStr);
      const allPosts = [];
      const allowedTiers = Array.isArray(friendPayload.tiers) ? friendPayload.tiers : ['general'];

      for (const tier of allowedTiers) {
        if (friendPayload.tierKeys && friendPayload.tierKeys[tier] && postsEnc[tier]) {
          try {
            const rawKey = friendPayload.tierKeys[tier];
            const aesKey = await CryptoCore.importRawAesKey(rawKey);
            const pStr = await CryptoCore.decryptAESGCMString(aesKey, postsEnc[tier].iv, postsEnc[tier].ciphertext);
            allPosts.push(...JSON.parse(pStr));
          } catch {}
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
// Random Sampling Helper
// ==========================================

function sampleQuestionsWithoutReplacement(pool, count = 5) {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// ==========================================
// App Initialization
// ==========================================

function init() {
  initWorker();
  initTheme();
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

  // Check URL hash for token
  initTokenFromHash();
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
 * Check for #token=... in URL hash
 * If found, wipe immediately and launch direct quiz load
 */
function initTokenFromHash() {
  const hash = window.location.hash ? window.location.hash.substring(1) : '';
  let token = '';

  if (hash.startsWith('token=')) {
    token = hash.replace('token=', '').trim();
  } else if (hash && !hash.includes('=')) {
    token = hash.trim();
  }

  if (token) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    loadFriendQuiz(token);
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
// Direct Token-to-Quiz Loading Flow
// ==========================================

async function loadFriendQuiz(token) {
  clearGentleAlert(gate1Alert);
  setBtnLoading(gate1SubmitBtn, true, 'Finding notes...');

  try {
    const lookupId = await CryptoCore.sha256Hex(`friend:${token}`);
    const res = await fetch(`data/friends/${lookupId}.json`);

    if (!res.ok) {
      showGentleAlert(gate1Alert, "That invite code doesn't seem quite right. Double-check and try again.");
      switchView('gate1');
      return;
    }

    const friendPackage = await res.json();

    // Decrypt question pool in worker
    const result = await callCrypto('DECRYPT_FRIEND_QUESTIONS', {
      token,
      questionsEnc: friendPackage.questionsEnc
    });

    if (!result.success) {
      showGentleAlert(gate1Alert, "Unable to open questions with this code. Please check your invite.");
      switchView('gate1');
      return;
    }

    session.token = token;
    session.friendPackage = friendPackage;
    session.quizData = result.data;

    // Randomly sample 5 questions without replacement from the 10-question pool
    const shownCount = session.quizData.questionsShown || 5;
    session.sampledQuestions = sampleQuestionsWithoutReplacement(session.quizData.questions, shownCount);

    // Render single-card 5-question quiz UI
    renderQuizView(session.sampledQuestions, session.quizData.threshold || 4);
    switchView('gate2');
  } catch (err) {
    console.error(err);
    showGentleAlert(gate1Alert, "Unable to connect right now. Please try again in a moment.");
    switchView('gate1');
  } finally {
    setBtnLoading(gate1SubmitBtn, false);
  }
}

async function handleGate1Submit(e) {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) {
    showGentleAlert(gate1Alert, "Please enter your personal invite code.");
    return;
  }
  loadFriendQuiz(token);
}

function renderQuizView(questions, threshold = 4) {
  quizInstructionText.textContent = `Answer at least ${threshold} of these ${questions.length} to step in.`;
  quizListContainer.innerHTML = '';

  questions.forEach((q, idx) => {
    const item = document.createElement('div');
    item.className = 'quiz-item';

    // Question hint directly as formatting placeholder
    const hintPlaceholder = q.hint ? q.hint : 'Your answer...';

    item.innerHTML = `
      <label class="quiz-prompt" for="q_input_${idx}">${escapeHtml(q.prompt)}</label>
      <input type="text" id="q_input_${idx}" class="form-input" data-qid="${q.id}" placeholder="${escapeHtml(hintPlaceholder)}" autocomplete="off">
    `;
    quizListContainer.appendChild(item);
  });
}

// ==========================================
// Gate 2: Quiz Verification & Worker Decryption
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

  const threshold = session.quizData.threshold || 4;
  if (answers.length < threshold) {
    showGentleAlert(gate2Alert, `Please answer at least ${threshold} of the questions to step in.`);
    return;
  }

  setBtnLoading(quizSubmitBtn, true, 'Unlocking your pages...');

  try {
    const postsRes = await fetch('data/posts.enc');
    if (!postsRes.ok) {
      throw new Error("Failed to load notes data.");
    }
    const postsEnc = await postsRes.json();

    // Verify answers against shares and unwrap envelope
    const result = await callCrypto('VERIFY_AND_UNLOCK', {
      answers,
      shares: session.friendPackage.shares,
      envelopeEnc: session.friendPackage.envelopeEnc,
      postsEnc,
      token: session.token,
      threshold
    });

    if (!result.success) {
      // Gentle aggregate human error feedback (never per-question indicators)
      showGentleAlert(
        gate2Alert,
        "Almost there—a few didn't quite match. Double-check spelling or date formats and try again."
      );
      setBtnLoading(quizSubmitBtn, false);
      return;
    }

    session.friend = result.data.friend;
    session.posts = result.data.posts;

    // Render feed
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
  session.token = '';
  session.friend = null;
  session.posts = [];
  session.friendPackage = null;
  session.quizData = null;
  session.sampledQuestions = [];
  session.activePost = null;

  tokenInput.value = '';
  quizListContainer.innerHTML = '';
  articleChunksWrapper.innerHTML = '';

  clearGentleAlert(gate1Alert);
  clearGentleAlert(gate2Alert);

  switchView('gate1');
}

// ==========================================
// Soft Privacy Curtain (Blur-on-Unfocus)
// ==========================================

function initPrivacyCurtain() {
  const showCurtain = () => {
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

init();
