"use client";

type SearchParamSource = {
  get(name: string): string | null;
};

const UUID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

const TENANT_STORAGE_KEY = "quiz-app-organization-id";
const TENANT_SLUG_STORAGE_KEY = "quiz-app-organization-slug";
const TENANT_NAME_STORAGE_KEY = "quiz-app-organization-name";

export function isValidOrganizationId(value: string | null | undefined) {
  return Boolean(value && UUID_PATTERN.test(value.trim()));
}

export function normalizeOrganizationId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return isValidOrganizationId(trimmed) ? trimmed : null;
}

export function getOrganizationStorageKey() {
  return TENANT_STORAGE_KEY;
}

export function readStoredOrganizationId() {
  if (typeof window === "undefined") {
    return null;
  }

  return normalizeOrganizationId(window.localStorage.getItem(TENANT_STORAGE_KEY));
}

export function readStoredOrganizationSlug() {
  if (typeof window === "undefined") {
    return null;
  }

  const value = window.localStorage.getItem(TENANT_SLUG_STORAGE_KEY)?.trim() ?? "";
  return value || null;
}

export function readStoredOrganizationName() {
  if (typeof window === "undefined") {
    return null;
  }

  const value = window.localStorage.getItem(TENANT_NAME_STORAGE_KEY)?.trim() ?? "";
  return value || null;
}

export function storeOrganizationId(organizationId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = normalizeOrganizationId(organizationId);
  if (!normalized) {
    throw new Error("Organization ID must be a valid UUID.");
  }

  window.localStorage.setItem(TENANT_STORAGE_KEY, normalized);
}

export function storeOrganizationSlug(slug: string) {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = slug.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Organization slug is required.");
  }

  window.localStorage.setItem(TENANT_SLUG_STORAGE_KEY, normalized);
}

export function normalizeOrganizationSlugInput(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function formatOrganizationNameForDisplay(value: string | null | undefined) {
  const cleaned = (value ?? "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

  if (!cleaned) {
    return "";
  }

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function storeOrganizationIdentity(input: { id: string; slug?: string | null; name?: string | null }) {
  storeOrganizationId(input.id);

  if (typeof window === "undefined") {
    return;
  }

  if (input.slug?.trim()) {
    storeOrganizationSlug(input.slug);
  }

  if (input.name?.trim()) {
    window.localStorage.setItem(TENANT_NAME_STORAGE_KEY, input.name.trim());
  }
}

export function getOrganizationIdFromSearchParams(searchParams: SearchParamSource) {
  return normalizeOrganizationId(
    searchParams.get("organization_id") ??
      searchParams.get("tenant") ??
      searchParams.get("org")
  );
}

export function getOrganizationSlugFromSearchParams(searchParams: SearchParamSource) {
  const value =
    searchParams.get("organization") ??
    searchParams.get("organization_slug") ??
    searchParams.get("tenant_slug");
  const normalized = normalizeOrganizationSlugInput(value);
  return normalized || null;
}

export function resolveOrganizationId(options?: { fallback?: string | null; searchParams?: SearchParamSource }) {
  const fromSearch = options?.searchParams ? getOrganizationIdFromSearchParams(options.searchParams) : null;
  if (fromSearch) {
    return fromSearch;
  }

  const fromStorage = readStoredOrganizationId();
  if (fromStorage) {
    return fromStorage;
  }

  return normalizeOrganizationId(options?.fallback ?? null);
}

export function appendOrganizationIdToPath(path: string, organizationId?: string | null) {
  const normalized = normalizeOrganizationId(organizationId);
  if (!normalized) {
    return path;
  }

  const target = new URL(path, "http://localhost");
  target.searchParams.set("organization_id", normalized);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function appendOrganizationSlugToPath(path: string, organizationSlug?: string | null) {
  const slug = organizationSlug?.trim();
  if (!slug) {
    return path;
  }

  const target = new URL(path, "http://localhost");
  target.searchParams.set("organization", slug);
  return `${target.pathname}${target.search}${target.hash}`;
}
