/**
 * F15: browser origins allowed to call Live-server (HTTP CORS, and the socket server's default in
 * production). Read from CORS_ORIGINS, ALLOWED_ORIGINS, CLIENT_URL and ADMIN_CLIENT_URL
 * (comma-separated, merged). The mobile app sends no Origin, so CORS never applies to it.
 *
 * Production must name its origins: assertProductionConfig.js refuses to boot when the list is
 * empty or contains "*".
 */
export const corsAllowedOrigins = (env = process.env) => {
    const raw = [env.CORS_ORIGINS, env.ALLOWED_ORIGINS, env.CLIENT_URL, env.ADMIN_CLIENT_URL]
        .filter(Boolean)
        .flatMap((value) => String(value).split(","))
        .map((origin) => origin.trim())
        .filter(Boolean);
    return [...new Set(raw)];
};

/** Problems with the origin list for production, or [] when it is an explicit list. */
export const corsProductionProblems = (env = process.env) => {
    const origins = corsAllowedOrigins(env);
    if (!origins.length) return ["CORS_ORIGINS is missing (no browser origin allowed)"];
    if (origins.includes("*")) return ["CORS origins contain \"*\" (set CORS_ORIGINS / CLIENT_URL to explicit origins)"];
    return [];
};
