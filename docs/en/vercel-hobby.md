# Vercel Hobby deployment

This fork exposes six Vercel Functions. Eighteen public API handlers are loaded
by `api/[route].ts` at their existing `/api/<name>` URLs. Their implementation
files have an underscore prefix so Vercel bundles them as dependencies rather
than creating additional Functions. Authentication, ownership checks, CORS and
HTTP method validation remain in each handler.

The three fal upload/video endpoints stay separate to preserve their body-parser
settings. The queue worker and cron sweep also stay separate; the dispatcher
does not expose either of them. The worker's private queue trigger is unchanged.

The dispatcher has a 300-second maximum duration for long-running generation
requests. It selects handlers from a fixed allowlist using the URL path, not a
query parameter. It does not import arbitrary filenames supplied by callers.

The recovery sweep runs once per day at 03:00 UTC (06:00 Turkey time), subject
to Vercel scheduling precision. Recovery that relies on the sweep may therefore
wait until the next daily run; normal queue processing is independent of it.

Run `npm test`, `npm run typecheck`, `npm run build` and `npm run audit` before
publishing. After deployment, verify workspace configuration, sign-in and an
authenticated generation request; a local build alone does not verify cloud
credentials or queue availability.
