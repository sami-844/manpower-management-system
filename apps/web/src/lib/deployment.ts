/**
 * The Cloudflare client demo (DECISIONS A32): the real sign-in, API and database, but fictional data
 * only. Its build sets VITE_CLIENT_DEMO=true; the screens then say so wherever someone could type.
 * Read at call time (not at import) so tests can switch it.
 */
export const isClientDemo = (): boolean => import.meta.env.MODE !== "demo" && import.meta.env.VITE_CLIENT_DEMO === "true";

export const CLIENT_DEMO_NOTICE = "Client demo: every person and figure here is fictional. Don't enter real personal data.";
