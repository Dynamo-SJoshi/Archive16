/**
 * crypto-worker.js - Dedicated Web Worker for Non-Blocking Web Crypto Operations
 * Handles 210,000 PBKDF2 iterations, multi-answer share matching, and Shamir reconstruction off the main thread.
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

self.onmessage = async function (e) {
  const { type, payload, id } = e.data;

  try {
    if (type === 'DECRYPT_FRIEND_QUESTIONS') {
      const { token, questionsEnc } = payload;
      const qKey = await deriveKeyPBKDF2(token, questionsEnc.salt, 210000);
      const plainStr = await tryDecryptAESGCMString(qKey, questionsEnc.iv, questionsEnc.ciphertext);

      if (!plainStr) {
        self.postMessage({ id, success: false, error: 'INVALID_TOKEN' });
        return;
      }

      const quizData = JSON.parse(plainStr);
      self.postMessage({ id, success: true, data: quizData });

    } else if (type === 'VERIFY_AND_UNLOCK') {
      const { answers, shares, envelopeEnc, postsEnc, token, threshold } = payload;

      // Group shares by questionId for fast multi-answer matching
      const sharesByQ = new Map();
      for (const s of shares) {
        if (!sharesByQ.has(s.questionId)) {
          sharesByQ.set(s.questionId, []);
        }
        sharesByQ.get(s.questionId).push(s);
      }

      // Map to store recovered share per question (keyed by questionId)
      const validSharesMap = new Map();

      for (const item of answers) {
        if (!item.val || !item.val.trim()) continue;
        const matchingShares = sharesByQ.get(item.id);
        if (!matchingShares || matchingShares.length === 0) continue;

        const normAns = normalizeAnswer(item.val);

        // Attempt decrypting against each share record for this question until one matches
        for (const sRecord of matchingShares) {
          const shareKey = await deriveKeyPBKDF2(normAns, sRecord.salt, 210000);
          const decryptedShareStr = await tryDecryptAESGCMString(shareKey, sRecord.iv, sRecord.ciphertext);

          if (decryptedShareStr) {
            try {
              const shareObj = JSON.parse(decryptedShareStr);
              if (shareObj && typeof shareObj.x === 'number' && shareObj.y) {
                validSharesMap.set(item.id, shareObj);
                break; // Found valid share for this question, stop testing other alternates
              }
            } catch {
              // Invalid json, keep checking
            }
          }
        }
      }

      const validShares = Array.from(validSharesMap.values());

      // Check threshold (K=4)
      if (validShares.length < threshold) {
        self.postMessage({
          id,
          success: false,
          error: 'INSUFFICIENT_SHARES',
          validCount: validShares.length
        });
        return;
      }

      // Reconstruct FriendKey via Shamir's Secret Sharing (threshold shares)
      const friendKeyBytes = combineShares(validShares.slice(0, threshold));
      const friendKeyHex = bytesToHex(friendKeyBytes);

      // Unwrap envelopeEnc with PBKDF2(FriendKey + ":" + token)
      const envWrapPass = `${friendKeyHex}:${token}`;
      const envWrapKey = await deriveKeyPBKDF2(envWrapPass, envelopeEnc.salt, 210000);
      const envelopeStr = await tryDecryptAESGCMString(envWrapKey, envelopeEnc.iv, envelopeEnc.ciphertext);

      if (!envelopeStr) {
        self.postMessage({
          id,
          success: false,
          error: 'ENVELOPE_DECRYPT_FAILED'
        });
        return;
      }

      const friendPayload = JSON.parse(envelopeStr);

      // Decrypt posts for allowed tiers
      const allPosts = [];
      const allowedTiers = Array.isArray(friendPayload.tiers) ? friendPayload.tiers : ['general'];

      for (const tier of allowedTiers) {
        if (friendPayload.tierKeys && friendPayload.tierKeys[tier] && postsEnc[tier]) {
          try {
            const tierRawKey = friendPayload.tierKeys[tier];
            const aesKey = await importRawAesKey(tierRawKey);
            const decryptedTierStr = await decryptAESGCMString(aesKey, postsEnc[tier].iv, postsEnc[tier].ciphertext);
            const tierPosts = JSON.parse(decryptedTierStr);
            allPosts.push(...tierPosts);
          } catch (tierErr) {
            console.warn(`Could not decrypt tier '${tier}':`, tierErr);
          }
        }
      }

      allPosts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      self.postMessage({
        id,
        success: true,
        data: {
          friend: {
            name: friendPayload.name,
            email: friendPayload.email
          },
          posts: allPosts
        }
      });

    } else {
      self.postMessage({ id, success: false, error: 'UNKNOWN_COMMAND' });
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || 'WORKER_ERROR' });
  }
};
