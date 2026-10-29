export const missingProviderMessage = (provider: string, variable: string): string => process.env.BANANA_RUNTIME === 'local'
  ? `Open Provider keys and add your ${provider} API key before using this feature.`
  : `${provider} is not configured. The workspace owner must add ${variable} to the server environment.`;
import { resolveProvider, type ProviderAvailability } from '../../src/lib/providers.js';

// Keep environment accesses explicit. Serverless bundlers can omit variables
// that are referenced only through a computed process.env property name.
export const providerAvailability = (): ProviderAvailability => ({
  openai: Boolean(process.env.OPENAI_API_KEY?.trim()) && process.env.OPENAI_ENABLED !== 'false',
  openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()) && process.env.OPENROUTER_ENABLED !== 'false',
  agentrouter: Boolean(process.env.AGENTROUTER_API_KEY?.trim()) && process.env.AGENTROUTER_ENABLED !== 'false',
  gemini: Boolean(process.env.GEMINI_API_KEY?.trim()) && process.env.GEMINI_ENABLED !== 'false',
  fal: Boolean(process.env.FAL_KEY?.trim()) && process.env.FAL_ENABLED !== 'false',
  evolink: Boolean(process.env.EVOLINK_API_KEY?.trim()) && process.env.EVOLINK_ENABLED !== 'false',
});
export const chooseProvider = (model: string, preference?: unknown) => resolveProvider(model, preference, providerAvailability());
