import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  reload
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBIffU2WUjF2Xmi1hemPOcpUOZPFpj1Tnk",
  authDomain: "kenji-ai-workspace.firebaseapp.com",
  projectId: "kenji-ai-workspace",
  storageBucket: "kenji-ai-workspace.firebasestorage.app",
  messagingSenderId: "647960355000",
  appId: "1:647960355000:web:c38d1248c4b22968eb944d"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const authReady = setPersistence(auth, browserLocalPersistence);

export {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  reload
};

export function friendlyAuthError(error) {
  const code = error?.code || "";
  const messages = {
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/missing-password": "Please enter your password.",
    "auth/weak-password": "Please choose a password with at least 6 characters.",
    "auth/email-already-in-use": "An account may already exist for this email. Try signing in or resetting your password.",
    "auth/too-many-requests": "Too many attempts. Please wait a while and try again.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/user-disabled": "This account is disabled. Please contact support.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/operation-not-allowed": "Email/password sign-in is not enabled in Firebase yet.",
    "auth/unauthorized-domain": "This website domain is not authorized in Firebase Authentication.",
    "auth/expired-action-code": "This email link has expired. Please request a new one.",
    "auth/invalid-action-code": "This email link is invalid or has already been used."
  };
  return messages[code] || "We could not complete that request. Please try again.";
}
