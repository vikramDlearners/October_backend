// All settings come from the environment. Secrets are read here and never logged or returned.
const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  dataDir: env.DATA_DIR || './data',
  checkEveryHours: Number(env.CHECK_EVERY_HOURS) > 0 ? Number(env.CHECK_EVERY_HOURS) : 12,
  geminiKey: env.GEMINI_API_KEY?.trim() || '',
  gemmaModel: env.GEMMA_MODEL?.trim() || 'gemma-4-31b-it',
  flashModel: env.GEMINI_FLASH_MODEL?.trim() || 'gemini-3.8-flash',
  serpapiKey: env.SERPAPI_KEY?.trim() || '',
  telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || '',
  telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || '',
  itineraryApiUrl: env.ITINERARY_API_URL?.trim() || '',
  corsOrigin: env.CORS_ORIGIN?.trim() || '*',
};

export const telegramConfigured = () => Boolean(config.telegramToken && config.telegramChatId);

export function health() {
  return {
    gemma: config.geminiKey ? config.gemmaModel : false,
    serpapi: Boolean(config.serpapiKey),
    telegram: telegramConfigured(),
    itineraryApi: Boolean(config.itineraryApiUrl),
    checkEveryHours: config.checkEveryHours,
  };
}

// Problems worth shouting about at startup. Messages describe the problem, never the value.
export function configWarnings() {
  const warnings = [];
  const { telegramToken, telegramChatId } = config;
  if (telegramToken && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(telegramToken)) {
    warnings.push('TELEGRAM_BOT_TOKEN does not look like a BotFather token (<digits>:<~35 chars>). Paste the FULL token, including the number before the colon.');
  }
  if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) {
    warnings.push('TELEGRAM_CHAT_ID should be numeric (negative for groups).');
  }
  if (Boolean(telegramToken) !== Boolean(telegramChatId)) {
    warnings.push('Telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; alerts are off.');
  }
  if (!config.geminiKey) warnings.push('GEMINI_API_KEY not set; decisions use the simple rules fallback and plans are not priced.');
  if (config.itineraryApiUrl && !URL.canParse(config.itineraryApiUrl)) {
    warnings.push('ITINERARY_API_URL is not a valid URL; emailing itineraries will fail.');
  }
  if (!config.serpapiKey) warnings.push('SERPAPI_KEY not set; Gemma plans from its own knowledge of each place.');
  return warnings;
}
