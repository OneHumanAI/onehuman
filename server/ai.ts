// SPDX-License-Identifier: BUSL-1.1
/**
 * The language models behind the site's own AI features: the rules agent in the portal and the website chat.
 *
 * Azure OpenAI (OneHuman's own resource) when it is configured, OpenRouter otherwise:
 *   AZURE_OPENAI_ENDPOINT      https://<resource>.openai.azure.com/openai/v1   (the v1 API, OpenAI-compatible)
 *   AZURE_OPENAI_API_KEY       the resource's key (a Vercel secret; never in the repo)
 *   AZURE_OPENAI_RULES_MODEL   the deployment the rules agent uses
 *   AZURE_OPENAI_CHAT_MODEL    the deployment the website chat uses
 *   OPENROUTER_API_KEY, ONEHUMAN_ASSIST_MODEL, ONEHUMAN_CHAT_MODEL   the fallback
 *   ONEHUMAN_ASSIST_URL        tests: a stand-in for the model
 *
 * Reasoning models (o-series, gpt-5 and later) take no temperature and count their output as max_completion_tokens;
 * the request is shaped for whichever kind the deployment is.
 */
export type AiUse = 'rules' | 'chat';
export type AiTarget = { provider: 'azure' | 'openrouter'; url: string; headers: Record<string, string>; model: string; reasoning: boolean };

// the newest model deployed on the resource (2026-10): the best answers in every language we tried, 2–4 s to the first words
const DEFAULTS: Record<AiUse, { azure: string; openrouter: string }> = {
  rules: { azure: 'gpt-6.1-sol', openrouter: 'openai/gpt-6-luna' },
  chat: { azure: 'gpt-6.1-sol', openrouter: 'openai/gpt-6-luna' },
};
/** models that reason before answering: no temperature, max_completion_tokens, reasoning_effort */
export const isReasoning = (model: string) => /(^|\/)(o\d|gpt-5|gpt-6)/i.test(model) && !/-chat($|-)/i.test(model);

export function aiTarget(use: AiUse, env: NodeJS.ProcessEnv = process.env): AiTarget | null {
  return aiTargets(use, env)[0] ?? null;
}
/** Every configured model for this use, best first: when one fails, the next answers. */
export function aiTargets(use: AiUse, env: NodeJS.ProcessEnv = process.env): AiTarget[] {
  return [azureTarget(use, env), openRouterTarget(use, env)].filter((t): t is AiTarget => !!t);
}
function azureTarget(use: AiUse, env: NodeJS.ProcessEnv): AiTarget | null {
  if (env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT) {
    const model = (use === 'rules' ? env.AZURE_OPENAI_RULES_MODEL : env.AZURE_OPENAI_CHAT_MODEL) || DEFAULTS[use].azure;
    return {
      provider: 'azure', model, reasoning: isReasoning(model),
      url: env.ONEHUMAN_ASSIST_URL || `${env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/chat/completions`,
      headers: { 'api-key': env.AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
    };
  }
  return null;
}
function openRouterTarget(use: AiUse, env: NodeJS.ProcessEnv): AiTarget | null {
  if (env.OPENROUTER_API_KEY) {
    const model = (use === 'rules' ? env.ONEHUMAN_ASSIST_MODEL : env.ONEHUMAN_CHAT_MODEL) || DEFAULTS[use].openrouter;
    return {
      provider: 'openrouter', model, reasoning: false,
      url: env.ONEHUMAN_ASSIST_URL || 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://onehuman.ai', 'X-Title': use === 'rules' ? 'OneHuman portal' : 'OneHuman website chat' },
    };
  }
  return null;
}

/** A chat-completions request body for this target. */
export function aiBody(t: AiTarget, o: { messages: { role: string; content: string }[]; maxTokens: number; temperature?: number; json?: boolean; stream?: boolean; effort?: 'minimal' | 'low' | 'medium' | 'high' }) {
  return {
    model: t.model,
    messages: o.messages,
    ...(o.stream ? { stream: true } : {}),
    ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    // a reasoning model spends part of its budget thinking: give it room, and say how hard to think
    ...(t.reasoning
      ? { max_completion_tokens: o.maxTokens * 4, ...(o.effort ? { reasoning_effort: o.effort } : {}) }
      : { max_tokens: o.maxTokens, ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) }),
  };
}

/** The language of a short message, from its letters and a few common words; null when it cannot be told. */
export function languageOf(text: string): string | null {
  const t = ` ${text.toLowerCase()} `;
  if (/[ə]/.test(t)) return 'Azerbaijani';
  if (/[а-яё]/.test(t)) return /[әғқңөұүһі]/.test(t) ? 'Kazakh' : /[їєґ]/.test(t) ? 'Ukrainian' : 'Russian';
  // Azerbaijani and Turkish share most letters: q and some everyday words tell them apart (x comes in loanwords like
  // "export" too); when nothing does, the model is told to use the message's own language
  // whole words, letters beyond ASCII included (\b would not see "şifre" or "aynı" as words)
  const word = (list: string) => new RegExp(`(?<!\\p{L})(${list})(?!\\p{L})`, 'u').test(t);
  const turkic = /[ğışçöü]/.test(t);
  const az = word('eyni|edin|elə|isə|yox|deyil|nə|necə|olaraq|görə|qayda|qaydalar|bütün|hamısı|həm') || (turkic && /q/.test(t));
  const tr = word('aynı|için|değil|gibi|bir|ve|ile|olarak|şifre|kural|kurallar|tüm|hepsi|yapamasın|lütfen|yap');
  if (turkic || az || tr) { if (az && !tr) return 'Azerbaijani'; if (tr && !az) return 'Turkish'; if (/[ğış]/.test(t)) return null; }
  if (/[؀-ۿ]/.test(t)) return 'Arabic';
  if (/[一-鿿]/.test(t)) return 'Chinese';
  if (/[ñ¿¡]|\b(el|los|las|que|para|con|una|agentes|reglas)\b/.test(t)) return 'Spanish';
  if (/[ß]|\b(und|nicht|die|der|das|für|mit|keine)\b/.test(t)) return 'German';
  if (/\b(les|des|pour|avec|une|pas|règles)\b|[àâçèêëîôœù]/.test(t)) return 'French';
  if (/\b(the|and|to|for|never|let|hide|make|turn|all|agents?|rules?|show|ask|block|allow|people|please|what|can|should|on|off)\b/.test(t)) return 'English';
  return null;
}
