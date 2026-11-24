/**
 * app.js - Client-Side Orchestration and Decryption Engine
 * All decryption runs strictly client-side using Web Crypto API.
 * Secrets, keys, and decrypted content are maintained strictly in-memory.
 */

import {
  bytesToHex,
  normalizeAnswer,
  sha256Hex,
  deriveKeyPBKDF2,
  importRawAesKey,
  tryDecryptAESGCMString,
  decryptAESGCMString,
  combineShares
} from './crypto-core.mjs';

import { CanvasArticleReader } from './canvas-reader.js';

// Strictly in-memory session state (NEVER persisted to localStorage/sessionStorage)
const sessionState = {
  token: '',
  groupPassphrase: '',
  quizData: null,          // { threshold, totalQuestions, questions }
  quizMasterKeyHex: null,
  friendPayload: null,     // { name, email, tiers, tierKeys }
  posts: [],               // Decrypted articles
  activePostId: null
};

// DOM Elements
const viewGate1 = document.getElementById('viewGate1');
const viewGate2 = document.getElementById('viewGate2');
const viewReader = document.getElementById('viewReader');

const gate1Form = document.getElementById('gate1Form');
const groupPassInput = document.getElementById('groupPassInput');
const tokenInput = document.getElementById('tokenInput');
const tokenStatusHelp = document.getElementById('tokenStatusHelp');
const gate1Alert = document.getElementById('gate1Alert');
const gate1SubmitBtn = document.getElementById('gate1SubmitBtn');

const viewGate2Card = document.getElementById('viewGate2');
const quizForm = document.getElementById('quizForm');
const thresholdBadge = document.getElementById('thresholdBadge');
const quizQuestionsContainer = document.getElementById('quizQuestionsContainer');
const gate2Alert = document.getElementById('gate2Alert');
const quizSubmitBtn = document.getElementById('quizSubmitBtn');

const lockVaultBtn = document.getElementById('lockVaultBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const friendAttributionName = document.getElementById('friendAttributionName');
const friendTiersBadge = document.getElementById('friendTiersBadge');
const postListNav = document.getElementById('postListNav');
const articleCanvas = document.getElementById('articleCanvas');
const privacyShield = document.getElementById('privacyShield');

// Reader instance
let canvasReader = null;

// ==========================================
// Initialization & Token Detection
// ==========================================

function init() {
  initTheme();
  initTokenFromHash();
  initPrivacyShield();
  canvasReader = new CanvasArticleReader(articleCanvas);

  gate1Form.addEventListener('submit', handleGate1Submit);
  quizForm.addEventListener('submit', handleQuizSubmit);
  lockVaultBtn.addEventListener('click', lockVault);
}

function initTheme() {
  const savedTheme = localStorage.getItem('vault_theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  themeToggleBtn.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    let newTheme = 'dark';
    if (currentTheme === 'dark') {
      newTheme = 'light';
    } else if (currentTheme === 'light') {
      newTheme = 'dark';
    } else {
      // System default
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      newTheme = prefersDark ? 'light' : 'dark';
    }

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('vault_theme', newTheme);

    if (sessionState.posts.length > 0 && sessionState.activePostId) {
      const activePost = sessionState.posts.find(p => p.id === sessionState.activePostId);
      if (activePost) {
        canvasReader.renderPost(activePost, sessionState.friendPayload);
      }
    }
  });
}

/**
 * Extract token from URL hash (e.g. #token=abc or #abc)
 * Immediately wipe from address bar using history.replaceState
 */
function initTokenFromHash() {
  const hash = window.location.hash ? window.location.hash.substring(1) : '';
  if (!hash) return;

  let token = '';
  if (hash.startsWith('token=')) {
    token = hash.replace('token=', '').trim();
  } else if (!hash.includes('=')) {
    token = hash.trim();
  }

  if (token) {
    sessionState.token = token;
    tokenInput.value = token;
    tokenStatusHelp.textContent = 'Token securely loaded from link and wiped from address bar.';
    tokenStatusHelp.style.color = 'var(--success)';

    // Wipe hash from visible URL without reloading
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

// ==========================================
// UI View Switching & Alerts
// ==========================================

function switchView(target) {
  viewGate1.classList.remove('active');
  viewGate2.classList.remove('active');
  viewReader.classList.remove('active');

  if (target === 'gate1') {
    viewGate1.classList.add('active');
    lockVaultBtn.style.display = 'none';
  } else if (target === 'gate2') {
    viewGate2.classList.add('active');
    lockVaultBtn.style.display = 'inline-block';
  } else if (target === 'reader') {
    viewReader.classList.add('active');
    lockVaultBtn.style.display = 'inline-block';
  }
}

function showAlert(element, message, type = 'error') {
  element.textContent = message;
  element.className = `alert visible alert-${type}`;
}

function clearAlert(element) {
  element.textContent = '';
  element.className = 'alert';
}

function setBtnLoading(btn, isLoading, loadingText = 'Verifying...') {
  if (isLoading) {
    btn.disabled = true;
    btn.dataset.origHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span> <span>${loadingText}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
    }
  }
}

// ==========================================
// Gate 1: Group Passphrase & Questions Decryption
// ==========================================

async function handleGate1Submit(e) {
  e.preventDefault();
  clearAlert(gate1Alert);

  const groupPass = groupPassInput.value.trim();
  const token = tokenInput.value.trim();

  if (!groupPass) {
    showAlert(gate1Alert, 'Please enter the group passphrase.');
    return;
  }
  if (!token) {
    showAlert(gate1Alert, 'Please enter or provide your personal friend token.');
    return;
  }

  sessionState.groupPassphrase = groupPass;
  sessionState.token = token;

  setBtnLoading(gate1SubmitBtn, true, 'Unlocking Questions...');

  try {
    // 1. Fetch encrypted questions file
    const res = await fetch('data/questions.enc');
    if (!res.ok) {
      throw new Error(`Failed to load data/questions.enc (HTTP ${res.status})`);
    }
    const questionsEnc = await res.json();

    // 2. Derive key from normalized groupPassphrase
    const normPass = normalizeAnswer(groupPass);
    const qKey = await deriveKeyPBKDF2(normPass, questionsEnc.salt, 210000);

    // 3. Attempt decryption
    const decryptedJsonStr = await tryDecryptAESGCMString(qKey, questionsEnc.iv, questionsEnc.ciphertext);
    if (!decryptedJsonStr) {
      showAlert(gate1Alert, 'Incorrect group passphrase. Please check the passphrase and try again.');
      setBtnLoading(gate1SubmitBtn, false);
      return;
    }

    const quizData = JSON.parse(decryptedJsonStr);
    sessionState.quizData = quizData;

    // 4. Render Quiz in Gate 2
    renderQuizView(quizData);
    switchView('gate2');
  } catch (err) {
    console.error('Gate 1 Error:', err);
    showAlert(gate1Alert, `Error: ${err.message || 'Could not unlock questions.'}`);
  } finally {
    setBtnLoading(gate1SubmitBtn, false);
  }
}

function renderQuizView(quizData) {
  const { threshold, totalQuestions, questions } = quizData;
  thresholdBadge.textContent = `Threshold: ${threshold} of ${totalQuestions} Required`;
  quizQuestionsContainer.innerHTML = '';

  questions.forEach((q, idx) => {
    const qBox = document.createElement('div');
    qBox.className = 'question-box';

    const hintHtml = q.hint ? `<div class="question-hint">Hint: ${escapeHtml(q.hint)}</div>` : '';

    qBox.innerHTML = `
      <div class="question-header">
        <span class="question-num">Question ${idx + 1} of ${totalQuestions}</span>
      </div>
      <div class="question-prompt">${escapeHtml(q.prompt)}</div>
      ${hintHtml}
      <input type="text" class="question-input" data-qid="${q.id}" placeholder="Your answer..." autocomplete="off">
    `;
    quizQuestionsContainer.appendChild(qBox);
  });
}

// ==========================================
// Gate 2: Quiz Verification & Shamir Key Reconstruction
// ==========================================

async function handleQuizSubmit(e) {
  e.preventDefault();
  clearAlert(gate2Alert);

  const inputs = quizQuestionsContainer.querySelectorAll('.question-input');
  const userAnswers = [];
  inputs.forEach(input => {
    const qId = input.dataset.qid;
    const val = input.value.trim();
    if (val) {
      userAnswers.push({ id: qId, val });
    }
  });

  const K = sessionState.quizData.threshold;
  if (userAnswers.length < K) {
    showAlert(
      gate2Alert,
      `You have answered ${userAnswers.length} question(s). At least ${K} answers are required to reach the threshold.`
    );
    return;
  }

  setBtnLoading(quizSubmitBtn, true, 'Decrypting Shares...');

  try {
    // 1. Fetch shares.json and keys.json in parallel
    const [sharesRes, keysRes] = await Promise.all([
      fetch('data/shares.json'),
      fetch('data/keys.json')
    ]);

    if (!sharesRes.ok || !keysRes.ok) {
      throw new Error('Failed to load cryptographic vault artifacts.');
    }

    const sharesJson = await sharesRes.json();
    const keysJson = await keysRes.json();

    // 2. Attempt decrypting each answered question's share
    const validShares = [];

    for (const item of userAnswers) {
      const shareRecord = sharesJson.find(s => s.questionId === item.id);
      if (!shareRecord) continue;

      const normAns = normalizeAnswer(item.val);
      const shareKey = await deriveKeyPBKDF2(normAns, shareRecord.salt, 210000);
      const decryptedShareStr = await tryDecryptAESGCMString(shareKey, shareRecord.iv, shareRecord.ciphertext);

      if (decryptedShareStr) {
        try {
          const shareObj = JSON.parse(decryptedShareStr);
          validShares.push(shareObj); // { x, y }
        } catch {
          // Ignore invalid share json
        }
      }
    }

    // 3. Check if threshold reached
    if (validShares.length < K) {
      showAlert(
        gate2Alert,
        `Only ${validShares.length} of ${K} required shares decrypted successfully. Please verify your answers and try again.`
      );
      setBtnLoading(quizSubmitBtn, false);
      return;
    }

    setBtnLoading(quizSubmitBtn, true, 'Reconstructing Key & Opening Envelope...');

    // 4. Shamir reconstruction of QuizMasterKey
    const masterKeyBytes = combineShares(validShares.slice(0, K));
    const masterKeyHex = bytesToHex(masterKeyBytes);
    sessionState.quizMasterKeyHex = masterKeyHex;

    // 5. Look up friend envelope in keys.json
    const lookupId = await sha256Hex(`friend:${sessionState.token}`);
    const friendEnvelope = keysJson[lookupId];

    if (!friendEnvelope) {
      showAlert(
        gate2Alert,
        'Your answers are correct, but your friend token is not recognized or has been deactivated. Please contact the author.'
      );
      setBtnLoading(quizSubmitBtn, false);
      return;
    }

    // 6. Unwrap friend envelope
    const friendWrapPass = `${masterKeyHex}:${sessionState.token}`;
    const friendWrapKey = await deriveKeyPBKDF2(friendWrapPass, friendEnvelope.salt, 210000);
    const friendPayloadStr = await tryDecryptAESGCMString(friendWrapKey, friendEnvelope.iv, friendEnvelope.ciphertext);

    if (!friendPayloadStr) {
      showAlert(gate2Alert, 'Failed to unwrap friend credentials. Please check your token.');
      setBtnLoading(quizSubmitBtn, false);
      return;
    }

    const friendPayload = JSON.parse(friendPayloadStr);
    sessionState.friendPayload = friendPayload;

    setBtnLoading(quizSubmitBtn, true, 'Decrypting Articles...');

    // 7. Fetch and decrypt posts.enc
    const postsRes = await fetch('data/posts.enc');
    if (!postsRes.ok) {
      throw new Error(`Failed to load data/posts.enc (HTTP ${postsRes.status})`);
    }
    const postsEnc = await postsRes.json();

    const allDecryptedPosts = [];

    for (const tier of (friendPayload.tiers || ['general'])) {
      if (friendPayload.tierKeys && friendPayload.tierKeys[tier] && postsEnc[tier]) {
        try {
          const tierRawKey = friendPayload.tierKeys[tier];
          const aesKey = await importRawAesKey(tierRawKey);
          const decryptedTierStr = await decryptAESGCMString(aesKey, postsEnc[tier].iv, postsEnc[tier].ciphertext);
          const tierPosts = JSON.parse(decryptedTierStr);
          allDecryptedPosts.push(...tierPosts);
        } catch (tierErr) {
          console.warn(`Could not decrypt tier '${tier}':`, tierErr);
        }
      }
    }

    // Sort newest-first
    allDecryptedPosts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    sessionState.posts = allDecryptedPosts;

    if (allDecryptedPosts.length === 0) {
      showAlert(gate2Alert, 'No articles available for your access tier.');
      setBtnLoading(quizSubmitBtn, false);
      return;
    }

    // 8. Open Reader UI
    renderReaderView();
    switchView('reader');
  } catch (err) {
    console.error('Quiz Verification Error:', err);
    showAlert(gate2Alert, `Error: ${err.message || 'Failed to verify answers.'}`);
  } finally {
    setBtnLoading(quizSubmitBtn, false);
  }
}

// ==========================================
// Reader View Rendering
// ==========================================

function renderReaderView() {
  const friend = sessionState.friendPayload;
  friendAttributionName.textContent = friend.name || 'Friend';

  const hasInner = Array.isArray(friend.tiers) && friend.tiers.includes('inner');
  friendTiersBadge.textContent = hasInner ? 'Inner Circle' : 'General Access';
  friendTiersBadge.className = `tier-badge ${hasInner ? 'inner' : 'general'}`;

  // Populate sidebar post nav
  postListNav.innerHTML = '';
  sessionState.posts.forEach((post, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `post-nav-item ${idx === 0 ? 'active' : ''}`;
    btn.dataset.id = post.id;

    btn.innerHTML = `
      <div class="post-item-top">
        <span class="tier-badge ${post.tier === 'inner' ? 'inner' : 'general'}">${post.tier || 'general'}</span>
        <span class="post-item-date">${escapeHtml(post.date || '')}</span>
      </div>
      <div class="post-item-title">${escapeHtml(post.title || 'Untitled')}</div>
      <div class="post-item-summary">${escapeHtml(post.summary || '')}</div>
    `;

    btn.addEventListener('click', () => {
      document.querySelectorAll('.post-nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectPost(post.id);
    });

    postListNav.appendChild(btn);
  });

  // Select first post
  if (sessionState.posts.length > 0) {
    selectPost(sessionState.posts[0].id);
  }
}

function selectPost(postId) {
  sessionState.activePostId = postId;
  const post = sessionState.posts.find(p => p.id === postId);
  if (!post) return;

  canvasReader.renderPost(post, {
    name: sessionState.friendPayload.name,
    email: sessionState.friendPayload.email
  });
}

// ==========================================
// Vault Locking & Memory Purge
// ==========================================

function lockVault() {
  // Purge all in-memory keys, tokens, and decrypted content
  sessionState.token = '';
  sessionState.groupPassphrase = '';
  sessionState.quizData = null;
  sessionState.quizMasterKeyHex = null;
  sessionState.friendPayload = null;
  sessionState.posts = [];
  sessionState.activePostId = null;

  // Clear inputs
  groupPassInput.value = '';
  tokenInput.value = '';
  tokenStatusHelp.textContent = 'Auto-filled from your invite link or enter it manually.';
  tokenStatusHelp.style.color = '';
  quizQuestionsContainer.innerHTML = '';

  // Clear Canvas
  const ctx = articleCanvas.getContext('2d');
  ctx.clearRect(0, 0, articleCanvas.width, articleCanvas.height);

  clearAlert(gate1Alert);
  clearAlert(gate2Alert);

  switchView('gate1');
}

// ==========================================
// Blur-on-Unfocus Privacy Curtain & Screenshot Friction
// ==========================================

function initPrivacyShield() {
  const showShield = () => {
    // Only engage privacy shield when reader is active
    if (viewReader.classList.contains('active')) {
      privacyShield.classList.add('active');
    }
  };

  const hideShield = () => {
    privacyShield.classList.remove('active');
  };

  // Window blur (user clicks outside or tabs away)
  window.addEventListener('blur', showShield);

  // Document visibility change (user minimizes or switches tabs)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      showShield();
    }
  });

  // PrintScreen key intercept
  window.addEventListener('keydown', e => {
    if (e.key === 'PrintScreen' || e.keyCode === 44) {
      showShield();
    }
  });

  // Click shield to resume
  privacyShield.addEventListener('click', hideShield);
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
