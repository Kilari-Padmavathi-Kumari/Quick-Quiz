"use client";

import { useState } from "react";

import { API_URL, DEFAULT_ORGANIZATION_ID } from "../lib/config";

type LoginCardProps = {
  targetHref?: string;
  adminShortcut?: boolean;
};

export function LoginCard({ targetHref = "/dashboard" }: LoginCardProps) {
  const [isPending, setIsPending] = useState(false);

  function continueWithGoogle() {
    setIsPending(true);
    const googleUrl = new URL(`${API_URL}/auth/google`);
    googleUrl.searchParams.set("redirect_to", targetHref);
    googleUrl.searchParams.set("organization_id", DEFAULT_ORGANIZATION_ID);
    window.location.assign(googleUrl.toString());
  }

  return (
    <div className="auth-card auth-card--premium">
      <div className="auth-card__top">
        <span className="chip">Secure Access</span>
        <span className="auth-card__spark">Fast login</span>
      </div>

      <h2 className="card-title">Enter the arena in seconds</h2>
      <p className="auth-card__copy">
        Continue with Google to access contests, wallet history, leaderboard results, and admin
        tools.
      </p>

      <div className="auth-google-block">
        <div className="auth-google-block__label">Continue with Google</div>
        <button
          className="ghost-button auth-card__ghost auth-card__google-cta"
          type="button"
          disabled={isPending}
          onClick={continueWithGoogle}
          style={{ width: "100%" }}
        >
          {isPending ? (
            "Redirecting to Google..."
          ) : (
            <>
              <span className="auth-card__google-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" className="auth-card__google-svg" focusable="false" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M12.24 10.285v3.821h5.445c-.24 1.285-.96 2.373-2.045 3.101l3.307 2.565c1.928-1.777 3.043-4.395 3.043-7.487 0-.728-.066-1.429-.188-2.108H12.24z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 22c2.76 0 5.077-.913 6.769-2.47l-3.307-2.565c-.913.613-2.08.975-3.462.975-2.661 0-4.917-1.797-5.723-4.215H2.86v2.644A9.997 9.997 0 0 0 12 22z"
                  />
                  <path
                    fill="#4A90E2"
                    d="M6.277 13.725A5.997 5.997 0 0 1 5.957 12c0-.6.108-1.183.32-1.725V7.631H2.86A9.997 9.997 0 0 0 2 12c0 1.61.385 3.135 1.06 4.369l3.217-2.644z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M12 6.06c1.5 0 2.847.517 3.909 1.533l2.933-2.933C17.072 3.01 14.755 2 12 2A9.997 9.997 0 0 0 2.86 7.631l3.417 2.644C7.083 7.857 9.339 6.06 12 6.06z"
                  />
                </svg>
              </span>
              <span>Continue with Google</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
