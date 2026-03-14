import HyperExpress from '../lib/uws-compat.js';
import openapiSpec from '../openapi.json' with { type: 'json' };
import { RequestTimestampStore } from '../modules/rateLimit.js';
import { readTierRateLimitsFromEnv, runIpRateLimitMiddleware } from '../modules/middlewareFactory.js';

const router = new HyperExpress.Router();
const openapiRequestStore: RequestTimestampStore = {};
const openapiRateLimits = readTierRateLimitsFromEnv('PUBLIC_OPENAPI', { rps: 5, rpm: 60, rpd: 2000 });

async function openapiRateLimitMiddleware(request: any, response: any, next: () => void) {
  return runIpRateLimitMiddleware(request, response, next, openapiRequestStore, openapiRateLimits, {
    onDenied: async (_req, details) => ({
      status: 429,
      body: {
        error: 'Rate limit exceeded',
        message: `OpenAPI spec limit exceeded (${details.limit} ${details.window.toUpperCase()}).`,
        retry_after_seconds: details.retryAfterSeconds,
        timestamp: new Date().toISOString(),
      }
    }),
  });
}

router.get('/openapi.json', openapiRateLimitMiddleware, (_request, response) => {
  response.setHeader('Cache-Control', 'public, max-age=60');
  response.json(openapiSpec);
});

const openapiRouter = router;
export default openapiRouter;
