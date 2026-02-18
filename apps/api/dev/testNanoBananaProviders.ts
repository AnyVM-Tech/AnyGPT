import { dataManager, LoadedProviders, LoadedProviderData } from '../modules/dataManager.js';
import redis from '../modules/db.js';
import { ImagenAI } from '../providers/imagen.js';
import type { IMessage } from '../providers/interfaces.js';

const MODEL_ID = 'nano-banana-pro-preview';
const IMAGE_PROMPT = 'Generate a simple image of a blue square on a white background.';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const includeDisabled = args.includes('--include-disabled');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const delayArg = args.find((arg) => arg.startsWith('--delay-ms='));
const delayMs = delayArg ? Number(delayArg.split('=')[1]) : 250;
const providerFilterArg = args.find((arg) => arg.startsWith('--provider='));
const providerFilter = providerFilterArg ? providerFilterArg.split('=')[1].trim().toLowerCase() : '';
const removeMissingKey = args.includes('--remove-missing-key');
const waitRedis = !args.includes('--no-wait-redis');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGoogleFamilyProvider(providerId: string): boolean {
  const id = providerId.toLowerCase();
  return id.includes('gemini') || id === 'google' || id.includes('imagen');
}

async function testNanoBanana(provider: LoadedProviderData): Promise<{ ok: boolean; reason?: string }> {
  if (!provider.apiKey) {
    return { ok: false, reason: 'missing api key' };
  }
  if (!isGoogleFamilyProvider(provider.id)) {
    return { ok: false, reason: 'unsupported provider family' };
  }

  const client = new ImagenAI(provider.apiKey, MODEL_ID);
  const message: IMessage = {
    model: { id: MODEL_ID },
    content: [{ type: 'text', text: IMAGE_PROMPT }],
    modalities: ['image'],
    max_output_tokens: 128,
  };

  const res = await client.sendMessage(message);
  const responseText = typeof res?.response === 'string' ? res.response : '';
  if (!responseText) {
    return { ok: false, reason: 'empty response' };
  }
  return { ok: true };
}

async function main() {
  if (waitRedis) {
    await dataManager.waitForRedisReadyAndBackfill();
  }
  const providers = await dataManager.load<LoadedProviders>('providers');
  let candidates = providers.filter((p) => p.models && MODEL_ID in p.models);

  if (!includeDisabled) {
    candidates = candidates.filter((p) => !p.disabled);
  }
  if (providerFilter) {
    candidates = candidates.filter((p) => p.id.toLowerCase().includes(providerFilter));
  }
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    candidates = candidates.slice(0, limit);
  }

  console.log(`Testing ${candidates.length} provider(s) for ${MODEL_ID}...`);

  const removed: string[] = [];
  const kept: string[] = [];

  for (const provider of candidates) {
    const hasKey = Boolean(provider.apiKey);
    if (!hasKey && !removeMissingKey) {
      console.warn(`skip: ${provider.id} missing api key (use --remove-missing-key to drop model)`);
      continue;
    }

    try {
      const result = await testNanoBanana(provider);
      if (result.ok) {
        kept.push(provider.id);
        console.log(`ok: ${provider.id} -> ${MODEL_ID}`);
      } else {
        if (provider.models && provider.models[MODEL_ID]) {
          delete provider.models[MODEL_ID];
        }
        removed.push(provider.id);
        console.warn(`removed: ${provider.id} -> ${MODEL_ID} (${result.reason || 'unknown'})`);
      }
    } catch (err: any) {
      const reason = err?.message || String(err);
      if (provider.models && provider.models[MODEL_ID]) {
        delete provider.models[MODEL_ID];
      }
      removed.push(provider.id);
      console.warn(`removed: ${provider.id} -> ${MODEL_ID} (${reason})`);
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Would keep ${kept.length} provider(s), remove ${removed.length} provider(s).`);
    return;
  }

  await dataManager.save<LoadedProviders>('providers', providers);
  console.log(`Saved providers.json. Kept ${kept.length}, removed ${removed.length}.`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
}).finally(async () => {
  if (redis) {
    try { await redis.quit(); } catch {}
  }
});
