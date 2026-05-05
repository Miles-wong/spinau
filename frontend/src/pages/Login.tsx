/**
 * Login.tsx - Authentication entry page.
 *
 * Supports:
 * - Email / password sign-in and account creation.
 * - Microsoft OAuth (via OAuthProvider "microsoft.com") for SSO.
 *
 * On successful authentication, calls onLoginSuccess(user) to hand control
 * back to App.tsx which then fetches the Firestore role.
 */
import { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  OAuthProvider,
} from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../firebase";
import logo from "../pictures/logo.png";
import type { UserInfo } from "../types/auth";
import { useToast } from "../components/toastContext";
import { trackUxEvent } from "../services/uxTelemetry";

type LoginUser = UserInfo & {
  provider?: string;
};
type LoginProps = {
  onLoginSuccess?: (user: LoginUser) => void;
};

export default function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const { showToast } = useToast();

  const emailTrimmed = email.trim();
  const passwordTrimmed = password.trim();

  const validateCredentials = () => {
    if (!emailTrimmed) {
      setError("Please enter your email address.");
      trackUxEvent("auth_validation_failed", {
        page: "login",
        action: isSignUp ? "sign_up" : "sign_in",
        outcome: "error",
        message: "missing_email",
      });
      return false;
    }
    if (!passwordTrimmed) {
      setError("Please enter your password.");
      trackUxEvent("auth_validation_failed", {
        page: "login",
        action: isSignUp ? "sign_up" : "sign_in",
        outcome: "error",
        message: "missing_password",
      });
      return false;
    }
    return true;
  };

  const notifyAuthError = (title: string, message: string) => {
    showToast({
      type: "error",
      title,
      message,
      action: {
        label: "Try Again",
        onClick: () => setError(""),
      },
    });

    trackUxEvent("auth_failed", {
      page: "login",
      action: isSignUp ? "sign_up" : "sign_in",
      outcome: "error",
      message,
    });
  };

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!validateCredentials()) return;

    setLoading(true);

    try {
      const userCredential = await signInWithEmailAndPassword(auth, emailTrimmed, passwordTrimmed);
      const user = userCredential.user;

      onLoginSuccess?.({
        email: user.email,
        name: user.email?.split("@")[0] || "",
        uid: user.uid,
      });
      trackUxEvent("auth_success", {
        page: "login",
        action: "sign_in",
        outcome: "success",
      });
      showToast({
        type: "success",
        title: "Signed in successfully.",
        durationMs: 2500,
      });
    } catch (error) {
      console.error("Login error:", error);

      if (error && typeof error === "object" && "code" in error) {
        switch ((error as { code: string }).code) {
          case "auth/user-not-found":
            setError("User does not exist, please sign up first");
            notifyAuthError("Account not found", "No account is registered with this email. Please sign up first.");
            break;
          case "auth/wrong-password":
            setError("Wrong password, please try again");
            notifyAuthError("Incorrect password", "Your password is incorrect. Please try again or reset it.");
            break;
          case "auth/invalid-email":
            setError("Email format is invalid");
            notifyAuthError("Invalid email format", "Please enter a valid email address.");
            break;
          case "auth/user-disabled":
            setError("This account has been disabled");
            notifyAuthError("Account disabled", "This account is disabled. Please contact an administrator.");
            break;
          default:
            setError("Login failed. Please try again.");
            notifyAuthError("Sign-in failed", "We could not sign you in right now. Please try again.");
        }
      } else {
        setError("Login failed. Please try again.");
        notifyAuthError("Sign-in failed", "We could not sign you in right now. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!validateCredentials()) return;

    setLoading(true);

    if (passwordTrimmed.length < 6) {
      setError("Password must be at least 6 characters.");
      notifyAuthError("Password too short", "Use at least 6 characters for your password.");
      setLoading(false);
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, emailTrimmed, passwordTrimmed);
      const user = userCredential.user;

      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        role: "reporter",
        display_name: user.email?.split("@")[0] || "",
        email: user.email ?? "",
        is_active: true,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });

      onLoginSuccess?.({
        email: user.email,
        name: user.email?.split("@")[0] || "",
        uid: user.uid,
      });
      trackUxEvent("auth_success", {
        page: "login",
        action: "sign_up",
        outcome: "success",
      });
      showToast({
        type: "success",
        title: "Account created successfully.",
        message: "You are now signed in.",
        durationMs: 3000,
      });
    } catch (error) {
      console.error("Signup error:", error);

      if (error && typeof error === "object" && "code" in error) {
        switch ((error as { code: string }).code) {
          case "auth/email-already-in-use":
            setError("This email is already registered, please login directly");
            notifyAuthError("Email already registered", "Use Sign In to access this account.");
            break;
          case "auth/invalid-email":
            setError("Email format is invalid");
            notifyAuthError("Invalid email format", "Please enter a valid email address.");
            break;
          case "auth/weak-password":
            setError("Password is not strong enough, please use a more complex password");
            notifyAuthError("Weak password", "Use a stronger password with more characters and symbols.");
            break;
          default:
            setError("Signup failed. Please try again.");
            notifyAuthError("Sign-up failed", "We could not create your account right now. Please try again.");
        }
      } else {
        setError("Signup failed. Please try again.");
        notifyAuthError("Sign-up failed", "We could not create your account right now. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleMicrosoftLogin = async () => {
    setError("");
    setLoading(true);

    try {
      const provider = new OAuthProvider("microsoft.com");
      provider.setCustomParameters({
        prompt: "select_account",
        tenant: "common",
      });

      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      onLoginSuccess?.({
        email: user.email,
        name: user.displayName || user.email?.split("@")[0] || "User",
        uid: user.uid,
        provider: "microsoft.com",
      });
      trackUxEvent("auth_success", {
        page: "login",
        action: "microsoft_sign_in",
        outcome: "success",
      });
      showToast({
        type: "success",
        title: "Signed in with Microsoft.",
        durationMs: 2500,
      });
    } catch (error) {
      console.error("Microsoft login error:", error);

      if (error && typeof error === "object" && "code" in error) {
        switch ((error as { code: string }).code) {
          case "auth/popup-blocked":
            setError("Popup was blocked by browser, please allow popups and try again");
            notifyAuthError("Popup blocked", "Allow popups for this site, then click Microsoft sign-in again.");
            break;
          case "auth/popup-closed-by-user":
            setError("Login window was closed");
            notifyAuthError("Sign-in window closed", "Reopen Microsoft sign-in and complete authentication.");
            break;
          case "auth/cancelled-popup-request":
            setError("Login request was cancelled");
            notifyAuthError("Sign-in cancelled", "Please start Microsoft sign-in again.");
            break;
          case "auth/account-exists-with-different-credential":
            setError("This email is registered with another method, please use the original method to login");
            notifyAuthError("Different sign-in method required", "Use your original login method for this email account.");
            break;
          default:
            setError("Microsoft login failed. Please try again.");
            notifyAuthError("Microsoft sign-in failed", "We could not complete Microsoft sign-in. Please try again.");
        }
      } else {
        setError("Microsoft login failed. Please try again.");
        notifyAuthError("Microsoft sign-in failed", "We could not complete Microsoft sign-in. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#dde3ea] px-4 py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 lg:flex-row lg:items-stretch">
        <div className="flex h-[66vh] min-h-[360px] w-full max-w-md flex-col rounded-2xl bg-[#f8fafc] p-10 shadow-[0_18px_48px_-24px_rgba(15,23,42,0.35)] ring-1 ring-slate-200">
          <div className="flex h-full flex-col">
            <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-white">
              <span>SPIN</span>
              <span className="opacity-70">x</span>
              <span>Cyber</span>
            </div>
            <div className="mb-2 text-xs text-slate-500">Collaborative build by both contributors</div>
            <div className="mb-4 flex h-2/5 items-start justify-center pt-2">
              <img src={logo} alt="Logo" className="max-h-full max-w-[65%] object-contain" />
            </div>

            <button
              type="button"
              onClick={handleMicrosoftLogin}
              disabled={loading}
              className="mx-auto mt-auto flex w-full max-w-[280px] items-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-100">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 21 21"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect width="10" height="10" fill="#F25022" />
                  <rect x="11" width="10" height="10" fill="#7FBA00" />
                  <rect y="11" width="10" height="10" fill="#00A4EF" />
                  <rect x="11" y="11" width="10" height="10" fill="#FFB900" />
                </svg>
              </span>
              <span className="h-5 w-px bg-slate-200" />
              <span className="leading-snug">Sign in with Microsoft</span>
            </button>
          </div>
        </div>

        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_12px_32px_-24px_rgba(15,23,42,0.35)]">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-900">Test Login</div>
              <div className="text-xs text-slate-500">Email/password for role testing</div>
            </div>
            <button
              type="button"
              onClick={() => setIsSignUp((prev) => !prev)}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              {isSignUp ? "Use Sign In" : "Use Sign Up"}
            </button>
          </div>

          <form onSubmit={isSignUp ? handleSignUp : handleLogin} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
                placeholder="tester@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
                placeholder="At least 6 characters"
                autoComplete={isSignUp ? "new-password" : "current-password"}
              />
            </div>
            {error && <div className="text-xs text-red-600">{error}</div>}
            <button
              type="submit"
              disabled={loading || !emailTrimmed || !passwordTrimmed}
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading
                ? isSignUp
                  ? "Creating account..."
                  : "Signing in..."
                : isSignUp
                ? "Create Test Account"
                : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
