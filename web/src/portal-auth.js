// SPDX-License-Identifier: BUSL-1.1
// Sign-in through Firebase Authentication for the portal (bundled by scripts/build-auth.mjs into web/portal-auth.js).
// Firebase only proves who the person is; the portal turns the ID token into its own session (POST /api/v1/portal/session),
// so nothing is kept in this browser by Firebase (in-memory persistence).
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signOut,
} from 'firebase/auth';

const MESSAGES = {
  'auth/email-already-in-use': 'An account with this e-mail already exists. Sign in instead.',
  'auth/invalid-credential': 'E-mail or password is wrong.',
  'auth/wrong-password': 'E-mail or password is wrong.',
  'auth/user-not-found': 'E-mail or password is wrong.',
  'auth/invalid-email': 'Enter a valid e-mail address.',
  'auth/weak-password': 'Use at least 8 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection to the sign-in service. Check your network and try again.',
  'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for onehuman.ai and try again.',
  'auth/user-disabled': 'This account is turned off. Write to arif@onehuman.ai.',
  'auth/account-exists-with-different-credential': 'This e-mail signs in with a password. Use it, or reset it below.',
};
/** a person closing the Google window is not an error */
const QUIET = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

function friendly(e) {
  const code = e && e.code;
  if (QUIET.has(code)) return Object.assign(new Error(''), { quiet: true });
  return new Error(MESSAGES[code] || 'The sign-in did not work. Try again.');
}

function start(config) {
  const app = initializeApp(config);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  const token = async (p) => { try { const c = await p; const t = await c.user.getIdToken(); signOut(auth).catch(() => {}); return t; } catch (e) { throw friendly(e); } };
  return {
    google: () => { const g = new GoogleAuthProvider(); g.setCustomParameters({ prompt: 'select_account' }); return token(signInWithPopup(auth, g)); },
    signup: (email, password) => token(createUserWithEmailAndPassword(auth, email, password)),
    login: (email, password) => token(signInWithEmailAndPassword(auth, email, password)),
    reset: async (email) => { try { await sendPasswordResetEmail(auth, email, { url: `${location.origin}/portal` }); } catch (e) { if (e && e.code === 'auth/user-not-found') return; throw friendly(e); } },
  };
}

window.OneHumanAuth = { start };
