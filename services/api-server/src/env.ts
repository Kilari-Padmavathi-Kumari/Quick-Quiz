const toNumber = (value: string | undefined, fallback: number) =>
  value ? Number(value) : fallback;

const parseOrigins = (...values: Array<string | undefined>) =>
  values
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);

const parseEmails = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

const normalizeCookieDomain = (value: string | undefined) => {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "localhost" || trimmed === "127.0.0.1") {
    return undefined;
  }

  return trimmed;
};

export const config = {
  apiPort: toNumber(process.env.API_PORT, 4000),
  apiBaseUrl: process.env.API_BASE_URL ?? `http://localhost:${toNumber(process.env.API_PORT, 4000)}`,
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
  frontendUrls: [
    ...new Set(
      parseOrigins(
        process.env.FRONTEND_URL,
        process.env.FRONTEND_URLS,
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001"
      )
    )
  ],
  jwtSecret: process.env.JWT_SECRET ?? "replace_me",
  jwtIssuer: process.env.JWT_ISSUER ?? "quiz-app",
  jwtAudience: process.env.JWT_AUDIENCE ?? "quiz-app-users",
  accessTokenTtlMinutes: toNumber(process.env.ACCESS_TOKEN_TTL_MINUTES, 15),
  refreshTokenTtlDays: toNumber(process.env.REFRESH_TOKEN_TTL_DAYS, 30),
  cookieDomain: normalizeCookieDomain(process.env.COOKIE_DOMAIN),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  adminEmail: (process.env.ADMIN_EMAIL ?? "padmavathi.kilari@fissionlabs.com").toLowerCase(),
  authCodeTtlMinutes: toNumber(process.env.AUTH_CODE_TTL_MINUTES, 10),
  defaultOrganizationId: process.env.DEFAULT_ORGANIZATION_ID ?? "",
  defaultCompanyId: process.env.DEFAULT_COMPANY_ID?.trim() ?? "",
  superAdminEmails: parseEmails(process.env.SUPER_ADMIN_EMAILS),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? `http://localhost:${toNumber(process.env.API_PORT, 4000)}`}/auth/google/callback`
};
