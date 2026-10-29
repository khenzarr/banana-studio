import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, createUserScopedClient, requireUser } from './_lib/auth.js';
import { startOpenAIRequest } from './_lib/openaiGuard.js';
import { createTaskDeadline, waitForTask } from '../src/lib/shared/asyncTask.js';
import { DEFAULT_OPENAI_REASONING, isOpenAIReasoningEffort } from '../src/lib/prompts/openaiText.js';
import { brainstormOutputInstruction, isBrainstormCount, normalizeBrainstormOutput } from './_lib/textOutputFormats.js';

export const config = { maxDuration: 300 };
const ENDPOINT = 'https://co.agentrouter.org/v1/chat/completions';
const MODELS = new Set(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
const ACTIONS = new Set(['enhance', 'video_enhance', 'brainstorm', 'variation']);

const agentRouterErrorMessage = (status?: number): string => {
  if (status === 401 || status === 403) return 'AgentRouter anahtarı geçersiz veya bu modele erişimi yok.';
  if (status === 402) return 'AgentRouter hesabında yeterli kredi yok.';
  if (status === 429) return 'AgentRouter şu anda istek sınırına ulaştı. Biraz bekleyip yeniden dene.';
  if (status === 400 || status === 422) return 'AgentRouter bu model veya istek biçimini kabul etmedi.';
  if (status === 503) return 'AgentRouter geçici olarak kullanılamıyor. Biraz sonra yeniden dene.';
  return 'AgentRouter isteği tamamlanamadı. Biraz sonra yeniden dene.';
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(res); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = createTaskDeadline(15_000);
  const user = await requireUser(req, res, auth.signal).finally(() => auth.dispose());
  if (!user) return;
  const key = process.env.AGENTROUTER_API_KEY?.trim();
  if (!key) return res.status(503).json({ error: 'AGENTROUTER_API_KEY sunucuda tanımlı değil. Yönetici AgentRouter anahtarını eklemeli.' });

  let body: any;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  const model = body?.model;
  const parts = body?.contents?.parts;
  const usageContext = body?.usageContext;
  const effort = body?.reasoningEffort ?? DEFAULT_OPENAI_REASONING;
  if (!MODELS.has(model)) return res.status(400).json({ error: 'Unsupported AgentRouter text model' });
  if (!isOpenAIReasoningEffort(effort)) return res.status(400).json({ error: 'Unsupported reasoning effort.' });
  if (!ACTIONS.has(usageContext?.action) || typeof usageContext?.prompt !== 'string') return res.status(400).json({ error: 'Invalid text feature.' });
  if (!Array.isArray(parts) || !parts.length || parts.length > 256 || !parts.some(part => typeof part?.text === 'string' && part.text.trim())) {
    return res.status(400).json({ error: 'Provide text and optional image references.' });
  }
  if (body.brainstormFormat != null && (body.brainstormFormat !== 'wardrobe' || usageContext.action !== 'brainstorm')) return res.status(400).json({ error: 'Invalid Brainstorm output format.' });
  if (body.brainstormCount != null && (usageContext.action !== 'brainstorm' || !isBrainstormCount(body.brainstormCount))) return res.status(400).json({ error: 'Invalid Brainstorm idea count.' });
  if (body.outputFormat != null && (body.outputFormat !== 'youtube_analysis' || usageContext.action !== 'enhance' || body.brainstormFormat != null)) return res.status(400).json({ error: 'Invalid analysis output format.' });
  if (Buffer.byteLength(JSON.stringify(parts), 'utf8') > 4_100_000) return res.status(413).json({ error: 'Reference images are too large. Use fewer or smaller images.' });

  const content: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (typeof part?.text === 'string' && !part.inlineData && !part.fileData) content.push({ type: 'text', text: part.text });
    else if (part?.text == null && !part.fileData && ['image/jpeg', 'image/png', 'image/webp'].includes(part?.inlineData?.mimeType)
      && typeof part.inlineData.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(part.inlineData.data)) {
      content.push({ type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } });
    } else return res.status(400).json({ error: 'AgentRouter models accept text and image references here. YouTube footage is read by Gemini first.' });
  }

  const guard = await startOpenAIRequest(req, res, user, 'text', undefined, 'AgentRouter');
  if (!guard) return;
  const streaming = String(req.headers?.accept || req.headers?.Accept || '').includes('application/x-ndjson');
  let disconnected = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let requestId: string | null = null;
  let providerStatus: number | undefined;
  let outcome: 'completed' | 'failed' = 'failed';
  const send = (event: unknown) => { if (!disconnected && !res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
  const close = () => { disconnected = true; clearInterval(heartbeat); };
  const fail = async (status: number, error: string) => {
    await guard.finish('failed', requestId, providerStatus);
    if (streaming) { send({ type: 'error', error }); return res.end(); }
    return res.status(status).json({ error });
  };
  if (streaming) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); res.setHeader('X-Accel-Buffering', 'no');
    res.on('close', close); send({ type: 'status', stage: 'generating' });
    heartbeat = setInterval(() => send({ type: 'heartbeat' }), 10_000);
  }

  const deadline = createTaskDeadline(250_000);
  const wardrobe = body.brainstormFormat === 'wardrobe';
  const analysis = body.outputFormat === 'youtube_analysis';
  try {
    const response = await waitForTask(fetch(ENDPOINT, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Client-Request-Id': guard.id },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: analysis
          ? 'Prepare the requested factual episode analysis using only the supplied verified observations. Report unavailable footage honestly; never invent events, identities, prices, outcomes or timestamps. Return exactly the requested JSON object.'
          : 'Complete the requested prompt-writing task using the supplied brief and references. Make reasonable creative decisions without follow-up questions. Return only the finished deliverable.' + (usageContext.action === 'brainstorm' ? brainstormOutputInstruction(wardrobe, body.brainstormCount) : '') },
          { role: 'user', content }],
        reasoning_effort: effort,
        max_completion_tokens: 32768,
        user: user.id,
      }),
      signal: deadline.signal,
    }), deadline.signal);
    providerStatus = response.status; requestId = response.headers.get('x-request-id');
    const data = await waitForTask(response.json(), deadline.signal);
    deadline.dispose();
    if (!response.ok) return fail(response.status, agentRouterErrorMessage(response.status));
    requestId = typeof data?.id === 'string' ? data.id : requestId;

    let usageLogged = false;
    let usageLoggingPending = false;
    const accounting = createTaskDeadline(5_000);
    if (streaming) send({ type: 'status', stage: 'finishing' });
    try {
      const { error } = await waitForTask(createUserScopedClient(req).from('usage_logs').insert({
        user_id: user.id, action: usageContext.action, model,
        prompt: usageContext.prompt.slice(0, 500), image_count: 0, estimated_cost: null,
      }).abortSignal(accounting.signal), accounting.signal);
      usageLogged = !error;
    } catch { usageLoggingPending = true; }
    finally { accounting.dispose(); }

    const choice = data?.choices?.[0];
    if (choice?.finish_reason !== 'stop') return fail(502, 'Model yanıtı tamamlanamadı. İsteği kısaltıp yeniden dene.');
    if (choice?.message?.refusal) return fail(422, 'Model bu isteği yanıtlayamadı.');
    let text = choice?.message?.role === 'assistant' && typeof choice.message.content === 'string' ? choice.message.content : '';
    if (!text.trim()) return fail(502, 'Model boş yanıt döndürdü. Yeniden dene.');
    if (usageContext.action === 'brainstorm') {
      const normalized = normalizeBrainstormOutput(text, wardrobe, body.brainstormCount);
      console.info(`[agentrouter-brainstorm] id=${guard.id} expected=${body.brainstormCount ?? 'legacy'} accepted=${normalized ? JSON.parse(normalized).length : 0} reasoning=${effort}`);
      if (!normalized) return fail(502, 'Model fikirleri beklenen biçimde döndürmedi. Yeniden dene.');
      text = normalized;
    }
    if (analysis) {
      let value: any;
      try { value = JSON.parse(text); } catch { /* checked below */ }
      if (typeof value?.videoAvailable !== 'boolean' || typeof value.brief !== 'string' || typeof value.premise !== 'string'
        || typeof value.limitation !== 'string' || !Array.isArray(value.evidence)) return fail(502, 'Model video analizini beklenen biçimde döndürmedi.');
    }
    const result = { text, candidates: null, provider: 'agentrouter', providerModel: model,
      usageMetadata: { provider: 'agentrouter', agentrouterUsage: data?.usage ?? null, usageLogged, usageLoggingPending }, requestId: guard.id };
    outcome = 'completed'; await guard.finish('completed', requestId, providerStatus);
    if (streaming) { send({ type: 'result', result }); return res.end(); }
    return res.status(200).json(result);
  } catch (error: any) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return fail(timeout ? 504 : 502, timeout ? 'Model yanıt süresi aşıldı. İsteği kısaltıp yeniden dene.' : agentRouterErrorMessage());
  } finally {
    deadline.dispose(); clearInterval(heartbeat); res.off?.('close', close);
    await guard.finish(outcome, requestId, providerStatus);
  }
}
