// A dev's own sealed rules. Everything here runs on the dev's machine, in a browser or in node: the
// rules are made here and encrypted here, for OutLayer's keystore, which only opens them inside its
// enclave. Our server is never asked, and OutLayer's API only ever hands out the public key.
//
// OutLayer's own CLI sends the plain secret along when it fetches that key. This doesn't: the key
// doesn't depend on it, so the rules never leave this machine unencrypted. In a browser OutLayer's API
// doesn't accept calls from our page, so the key comes through the one rewrite in web/public/_redirects.
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export const OUTLAYER_API = 'https://testnet-api.outlayer.ai';
const HKDF_INFO = utf8ToBytes('outlayer-keystore-v1');
const b64 = (bytes) => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };

/** New rules with a fresh salt. `maxPerRelease` is in the token's smallest unit, as a string. */
export function makeRules({ maxPerRelease, earliest = 0, minGapSecs }) {
  return { max_per_release: String(maxPerRelease), earliest: Number(earliest), min_gap_secs: Number(minGapSecs), salt: bytesToHex(randomBytes(32)) };
}

/** The same hash the judge and the plan contract work out. */
export function commitmentOf(r) {
  return bytesToHex(sha256(utf8ToBytes(`chok-sealed-v1|${r.max_per_release}|${r.earliest}|${r.min_gap_secs}|${r.salt}`)));
}

/** ECIES v1, as OutLayer's keystore expects: [0x01 | ephemeral public | nonce | ciphertext and tag]. */
export function encryptFor(pubkeyHex, plaintext) {
  const ephemeral = x25519.utils.randomPrivateKey();
  const key = hkdf(sha256, x25519.getSharedSecret(ephemeral, hexToBytes(pubkeyHex)), undefined, HKDF_INFO, 32);
  const nonce = randomBytes(12);
  const sealed = chacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
  const out = new Uint8Array(1 + 32 + 12 + sealed.length);
  out[0] = 1;
  out.set(x25519.getPublicKey(ephemeral), 1);
  out.set(nonce, 33);
  out.set(sealed, 45);
  return b64(out);
}

/** The arguments for outlayer's store_secrets: readable only by this judge, only through this plan contract. */
export async function storeSecretArgs({ rules, planId, judgeHash, planContract, owner, profile, api = OUTLAYER_API }) {
  const res = await fetch(`${api}/secrets/pubkey`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessor: { type: 'WasmHash', hash: judgeHash }, owner, profile, secrets_json: '{}' }) });
  if (!res.ok) throw new Error(`OutLayer's key service said ${res.status}`);
  const { pubkey } = await res.json();
  // the rules name their plan, so nobody can point another plan at this secret and probe it
  const secrets = JSON.stringify({ RULES: JSON.stringify({ ...rules, plan_id: planId }) });
  return {
    accessor: { WasmHash: { hash: judgeHash } },
    profile,
    encrypted_secrets_base64: encryptFor(pubkey, secrets),
    access: { Predecessor: { condition: { Whitelist: { accounts: [planContract] } } } },
    vault_id: null,
  };
}

export const newProfile = () => `own-${bytesToHex(randomBytes(6))}`;
