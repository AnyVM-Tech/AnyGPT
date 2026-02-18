import fs from 'fs';
import path from 'path';
import { dataManager, LoadedProviders, KeysFile, ModelsFileStructure } from '../modules/dataManager.js';

type DataType = 'models' | 'providers' | 'keys';

const args = new Set(process.argv.slice(2));
const explicitTypes: DataType[] = [];
if (args.has('--models')) explicitTypes.push('models');
if (args.has('--providers')) explicitTypes.push('providers');
if (args.has('--keys')) explicitTypes.push('keys');

const types: DataType[] = explicitTypes.length > 0 ? explicitTypes : ['models', 'providers', 'keys'];

function readJson<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function updateRedisFromDisk(type: DataType) {
  const filePath = path.resolve(`${type}.json`);
  if (!fs.existsSync(filePath)) {
    console.warn(`[updateRedisTemp] Skipping ${type}: ${filePath} not found`);
    return;
  }

  switch (type) {
    case 'models': {
      const data = readJson<ModelsFileStructure>(filePath);
      await dataManager.save('models', data);
      console.log(`[updateRedisTemp] Updated redis for models (${data.data?.length ?? 0} entries).`);
      return;
    }
    case 'providers': {
      const data = readJson<LoadedProviders>(filePath);
      await dataManager.save('providers', data);
      console.log(`[updateRedisTemp] Updated redis for providers (${Array.isArray(data) ? data.length : 0} entries).`);
      return;
    }
    case 'keys': {
      const data = readJson<KeysFile>(filePath);
      await dataManager.save('keys', data);
      console.log(`[updateRedisTemp] Updated redis for keys (${Object.keys(data || {}).length} entries).`);
      return;
    }
  }
}

async function main() {
  await dataManager.waitForRedisReadyAndBackfill();
  for (const type of types) {
    await updateRedisFromDisk(type);
  }
  console.log('[updateRedisTemp] Done.');
}

main().catch((err) => {
  console.error('[updateRedisTemp] Failed:', err);
  process.exit(1);
});
