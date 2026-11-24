/**
 * crypto-core.mjs - Pure JavaScript Cryptographic Primitives & Shamir Secret Sharing
 * Byte-level identical compatibility between Node.js 20+ and modern browsers.
 * Uses globalThis.crypto and globalThis.crypto.subtle with zero native dependencies.
 */

// ==========================================
// Hex & Byte Utilities
// ==========================================

export function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string') {
    throw new TypeError('hexToBytes expects a hex string');
  }
  const cleanHex = hex.trim();
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

export function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

export function getRandomBytes(length) {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function normalizeAnswer(str) {
  if (typeof str !== 'string') return '';
  return str.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ==========================================
// GF(256) Galois Field Arithmetic & Shamir SSS
// ==========================================
// Irreducible polynomial: x^8 + x^4 + x^3 + x + 1 (0x11b = 283)
// Primitive generator: 3

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    // Multiply by 3 in GF(2^8) modulo 0x11b
    const x2 = (x << 1) ^ ((x & 0x80) ? 0x11b : 0);
    x = x2 ^ x;
  }
  GF_LOG[0] = 0; // conventionally unused, prevent undefined
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

/**
 * Split an arbitrary byte array into N Shamir shares with threshold K.
 * @param {Uint8Array} secretBytes - The secret (e.g. 32 bytes)
 * @param {number} n - Total number of shares to generate (1 <= n <= 255)
 * @param {number} k - Minimum threshold of shares required to reconstruct (1 <= k <= n)
 * @returns {Array<{ x: number, y: string }>} Array of N shares with hex-encoded y values
 */
export function splitSecret(secretBytes, n, k) {
  const secret = secretBytes instanceof Uint8Array ? secretBytes : new Uint8Array(secretBytes);
  if (k < 1 || k > n || n > 255) {
    throw new Error(`Invalid Shamir parameters: n=${n}, k=${k} (require 1 <= k <= n <= 255)`);
  }
  const L = secret.length;
  if (L === 0) {
    throw new Error('Secret cannot be empty');
  }

  // For each byte index, generate k - 1 random coefficients
  // coeffs[byteIdx][0] = secret[byteIdx]
  // coeffs[byteIdx][1..k-1] = random
  const allCoeffs = [];
  for (let b = 0; b < L; b++) {
    const c = new Uint8Array(k);
    c[0] = secret[b];
    if (k > 1) {
      const rand = getRandomBytes(k - 1);
      for (let j = 1; j < k; j++) {
        c[j] = rand[j - 1];
      }
    }
    allCoeffs.push(c);
  }

  const shares = [];
  for (let x = 1; x <= n; x++) {
    const yBytes = new Uint8Array(L);
    for (let b = 0; b < L; b++) {
      const c = allCoeffs[b];
      // Evaluate polynomial at x using Horner's method
      let y = c[k - 1];
      for (let j = k - 2; j >= 0; j--) {
        y = c[j] ^ gfMul(y, x);
      }
      yBytes[b] = y;
    }
    shares.push({
      x,
      y: bytesToHex(yBytes)
    });
  }

  return shares;
}

/**
 * Reconstruct secret byte array from at least K Shamir shares using Lagrange interpolation at x=0.
 * @param {Array<{ x: number, y: string|Uint8Array }>} shares - At least K shares
 * @returns {Uint8Array} Reconstructed secret bytes
 */
export function combineShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error('Shares must be a non-empty array');
  }

  // Validate and parse shares
  const parsedShares = shares.map(s => ({
    x: Number(s.x),
    y: typeof s.y === 'string' ? hexToBytes(s.y) : new Uint8Array(s.y)
  }));

  const L = parsedShares[0].y.length;
  const xs = new Set();
  for (const s of parsedShares) {
    if (s.x < 1 || s.x > 255) {
      throw new Error(`Invalid share x-coordinate: ${s.x}`);
    }
    if (xs.has(s.x)) {
      throw new Error(`Duplicate share x-coordinate: ${s.x}`);
    }
    xs.add(s.x);
    if (s.y.length !== L) {
      throw new Error('Mismatched share byte length');
    }
  }

  const m = parsedShares.length;
  const secret = new Uint8Array(L);

  // Precompute Lagrange basis polynomials at x = 0:
  // basis[i] = product_{j != i} (x_j / (x_i ^ x_j))
  const basis = new Uint8Array(m);
  for (let i = 0; i < m; i++) {
    let num = 1;
    let den = 1;
    const xi = parsedShares[i].x;
    for (let j = 0; j < m; j++) {
      if (i === j) continue;
      const xj = parsedShares[j].x;
      num = gfMul(num, xj);
      den = gfMul(den, xi ^ xj);
    }
    basis[i] = gfDiv(num, den);
  }

  for (let b = 0; b < L; b++) {
    let val = 0;
    for (let i = 0; i < m; i++) {
      val ^= gfMul(parsedShares[i].y[b], basis[i]);
    }
    secret[b] = val;
  }

  return secret;
}

// ==========================================
// Web Crypto API Helpers (PBKDF2 & AES-256-GCM)
// ==========================================

const PBKDF2_ITERATIONS = 210000;

/**
 * Compute SHA-256 hash
 * @param {Uint8Array|string} data
 * @returns {Promise<Uint8Array>}
 */
export async function sha256(data) {
  const bytes = typeof data === 'string' ? utf8Encode(data) : data;
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(hashBuffer);
}

/**
 * Compute SHA-256 hex string
 * @param {Uint8Array|string} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
  const hash = await sha256(data);
  return bytesToHex(hash);
}

/**
 * Derive an AES-256-GCM CryptoKey using PBKDF2 with SHA-256 and 210,000 iterations.
 * @param {string|Uint8Array} passphrase - The passphrase or normalized answer
 * @param {Uint8Array|string} salt - 16-byte salt (or hex string)
 * @param {number} [iterations=210000] - Iteration count
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKeyPBKDF2(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const passBytes = typeof passphrase === 'string' ? utf8Encode(passphrase) : passphrase;
  const saltBytes = typeof salt === 'string' ? hexToBytes(salt) : (salt instanceof Uint8Array ? salt : new Uint8Array(salt));

  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    passBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256'
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Import raw 32-byte key as AES-256-GCM CryptoKey.
 * @param {Uint8Array|string} rawKey - 32 bytes or 64 hex chars
 * @returns {Promise<CryptoKey>}
 */
export async function importRawAesKey(rawKey) {
  const keyBytes = typeof rawKey === 'string' ? hexToBytes(rawKey) : rawKey;
  if (keyBytes.length !== 32) {
    throw new Error(`AES-256 key must be exactly 32 bytes, got ${keyBytes.length}`);
  }
  return globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt data using AES-256-GCM with a random 12-byte IV.
 * @param {CryptoKey} key - The AES-GCM CryptoKey
 * @param {string|Uint8Array} data - Plaintext string or bytes
 * @param {Uint8Array} [customIv=null] - Optional 12-byte IV
 * @returns {Promise<{ iv: string, ciphertext: string }>} Hex-encoded IV and ciphertext (with tag appended)
 */
export async function encryptAESGCM(key, data, customIv = null) {
  const iv = customIv || getRandomBytes(12);
  const plaintext = typeof data === 'string' ? utf8Encode(data) : data;

  const cipherBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    plaintext
  );

  return {
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(cipherBuffer))
  };
}

/**
 * Decrypt data using AES-256-GCM.
 * @param {CryptoKey} key - The AES-GCM CryptoKey
 * @param {string|Uint8Array} iv - 12-byte IV (or hex)
 * @param {string|Uint8Array} ciphertext - Ciphertext with tag (or hex)
 * @returns {Promise<Uint8Array>} Decrypted bytes
 */
export async function decryptAESGCM(key, iv, ciphertext) {
  const ivBytes = typeof iv === 'string' ? hexToBytes(iv) : iv;
  const cipherBytes = typeof ciphertext === 'string' ? hexToBytes(ciphertext) : ciphertext;

  const plainBuffer = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes
    },
    key,
    cipherBytes
  );

  return new Uint8Array(plainBuffer);
}

/**
 * Decrypt data and decode as UTF-8 string.
 * @param {CryptoKey} key
 * @param {string|Uint8Array} iv
 * @param {string|Uint8Array} ciphertext
 * @returns {Promise<string>}
 */
export async function decryptAESGCMString(key, iv, ciphertext) {
  const bytes = await decryptAESGCM(key, iv, ciphertext);
  return utf8Decode(bytes);
}

/**
 * Safe decrypt that returns null if decryption fails (e.g. invalid key/MAC check).
 * @param {CryptoKey} key
 * @param {string|Uint8Array} iv
 * @param {string|Uint8Array} ciphertext
 * @returns {Promise<Uint8Array|null>}
 */
export async function tryDecryptAESGCM(key, iv, ciphertext) {
  try {
    return await decryptAESGCM(key, iv, ciphertext);
  } catch {
    return null;
  }
}

/**
 * Safe decrypt string that returns null if decryption fails.
 * @param {CryptoKey} key
 * @param {string|Uint8Array} iv
 * @param {string|Uint8Array} ciphertext
 * @returns {Promise<string|null>}
 */
export async function tryDecryptAESGCMString(key, iv, ciphertext) {
  try {
    return await decryptAESGCMString(key, iv, ciphertext);
  } catch {
    return null;
  }
}
