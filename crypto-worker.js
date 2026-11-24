/**
 * crypto-worker.js - Dedicated Web Worker for Non-Blocking Web Crypto Operations
 * Handles 210,000 PBKDF2 iterations and Shamir share decryption off the main thread.
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
    if (type === 'DECRYPT_QUESTIONS') {
      const { groupPassphrase, questionsEnc } = payload;
      const normPass = normalizeAnswer(groupPassphrase);
      const qKey = await deriveKeyPBKDF2(normPass, questionsEnc.salt, 210000);
      const plainStr = await tryDecryptAESGCMString(qKey, questionsEnc.iv, questionsEnc.ciphertext);

      if (!plainStr) {
        self.postMessage({ id, success: false, error: 'INVALID_PASSPHRASE' });
        return;
      }

      const quizData = JSON.parse(plainStr);
      self.postMessage({ id, success: true, data: quizData });

    } else if (type === 'VERIFY_AND_UNLOCK') {
      const { answers, sharesJson, keysJson, postsEnc, token, threshold } = payload;

      // 1. Decrypt shares
      const validShares = [];
      for (const item of answers) {
        if (!item.val || !item.val.trim()) continue;
        const shareRecord = sharesJson.find(s => s.questionId === item.id);
        if (!shareRecord) continue;

        const normAns = normalizeAnswer(item.val);
        const shareKey = await deriveKeyPBKDF2(normAns, shareRecord.salt, 210000);
        const decryptedShareStr = await tryDecryptAESGCMString(shareKey, shareRecord.iv, shareRecord.ciphertext);

        if (decryptedShareStr) {
          try {
            const shareObj = JSON.parse(decryptedShareStr);
            validShares.push(shareObj);
          } catch {
            // invalid json
          }
        }
      }

      // 2. Check threshold
      if (validShares.length < threshold) {
        self.postMessage({
          id,
          success: false,
          error: 'INSUFFICIENT_SHARES',
          validCount: validShares.length
        });
        return;
      }

      // 3. Reconstruct QuizMasterKey
      const masterKeyBytes = combineShares(validShares.slice(0, threshold));
      const masterKeyHex = bytesToHex(masterKeyBytes);

      // 4. Look up friend envelope
      const lookupId = await sha256Hex(`friend:${token}`);
      const friendEnvelope = keysJson[lookupId];

      if (!friendEnvelope) {
        self.postMessage({
          id,
          success: false,
          error: 'REVOKED_OR_UNKNOWN_TOKEN'
        });
        return;
      }

      // 5. Unwrap envelope
      const friendWrapPass = `${masterKeyHex}:${token}`;
      const friendWrapKey = await deriveKeyPBKDF2(friendWrapPass, friendEnvelope.salt, 210000);
      const friendPayloadStr = await tryDecryptAESGCMString(friendWrapKey, friendEnvelope.iv, friendEnvelope.ciphertext);

      if (!friendPayloadStr) {
        self.postMessage({
          id,
          success: false,
          error: 'ENVELOPE_DECRYPT_FAILED'
        });
        return;
      }

      const friendPayload = JSON.parse(friendPayloadStr);

      // 6. Decrypt all allowed tiers and seamlessly merge into a single feed
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

      // Sort newest-first
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
