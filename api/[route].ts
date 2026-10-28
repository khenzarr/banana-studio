import type { VercelRequest, VercelResponse } from '@vercel/node';

// Literal imports let Vercel trace every dependency without loading every
// provider SDK on requests that only need workspace configuration.
const routes = {
  'evolink-generate': () => import('./_evolink-generate.js'),
  'evolink-status': () => import('./_evolink-status.js'),
  'fal-debug': () => import('./_fal-debug.js'),
  'fal-status': () => import('./_fal-status.js'),
  'folder-share': () => import('./_folder-share.js'),
  'gemini-generate': () => import('./_gemini-generate.js'),
  'gemini-status': () => import('./_gemini-status.js'),
  'openai-image-enqueue': () => import('./_openai-image-enqueue.js'),
  'openai-image-generate': () => import('./_openai-image-generate.js'),
  'openai-image-recover': () => import('./_openai-image-recover.js'),
  'openai-text-generate': () => import('./_openai-text-generate.js'),
  'openrouter-text-generate': () => import('./_openrouter-text-generate.js'),
  'provider-usage': () => import('./_provider-usage.js'),
  'seedance-video': () => import('./_seedance-video.js'),
  'shared-folder': () => import('./_shared-folder.js'),
  'workspace-config': () => import('./_workspace-config.js'),
  'youtube-status': () => import('./_youtube-status.js'),
  'youtube': () => import('./_youtube.js'),
};

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Select only by the URL path, never by the user-controlled ?route= query.
  const route = (req.url || '').split('?')[0].match(/^\/api\/([a-z0-9-]+)\/?$/)?.[1];
  if (!route || !Object.hasOwn(routes, route)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'Not found' });
  }
  const module = await routes[route as keyof typeof routes]();
  // Each original handler retains its authentication, CORS and method checks.
  return module.default(req, res);
}
