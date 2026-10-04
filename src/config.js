export function loadConfig(env = process.env) {
  const port = Number(env.PORT);
  return {
    port: Number.isInteger(port) && port > 0 ? port : 3000,
    nodeEnv: env.NODE_ENV || "development",
    sessionSecret: env.SESSION_SECRET || "",
    linkedin: {
      clientId: env.LINKEDIN_CLIENT_ID || "",
      clientSecret: env.LINKEDIN_CLIENT_SECRET || "",
      callbackUrl: env.LINKEDIN_CALLBACK_URL || "",
    },
    xai: {
      apiKey: env.XAI_API_KEY || "",
      model: env.XAI_MODEL || "grok-4.7",
      baseUrl: (env.XAI_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, ""),
    },
    braveSearchApiKey: env.BRAVE_SEARCH_API_KEY || "",
  };
}

export function linkedinConfigured(config) {
  return Boolean(
    config.linkedin.clientId &&
      config.linkedin.clientSecret &&
      config.linkedin.callbackUrl,
  );
}

export function xaiConfigured(config) {
  return Boolean(config.xai.apiKey);
}
