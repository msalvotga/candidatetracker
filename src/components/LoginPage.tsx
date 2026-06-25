import { useState } from "react";
import { loginUser } from "../api";

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      setError("Email and password are required.");
      return;
    }

    setSubmitting(true);
    try {
      await loginUser(normalizedEmail, password, rememberMe);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1>Texas Candidate Lookup</h1>
          <p>Sign in to view races, counties, and campaign data.</p>
        </div>

        <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label className="login-field">
            <span>Email address</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </label>

          <label className="login-remember filter-check-item">
            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
            <span>Stay logged in for 30 days</span>
          </label>

          {error ? <div className="banner error">{error}</div> : null}

          <button type="submit" className="login-submit" disabled={submitting}>
            {submitting ? "Please wait…" : "Sign in"}
          </button>
        </form>

        <p className="login-footnote">Use the email address on your account.</p>
      </div>
    </div>
  );
}
