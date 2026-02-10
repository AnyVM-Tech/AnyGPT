import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Lightweight capability audit for models.json. Heuristic-based; does not call providers.
// Run with: pnpm tsx ./dev/checkModelCapabilities.ts

type ModelCapability = 'text' | 'image_input' | 'image_output' | 'audio_input' | 'audio_output';
interface ModelDefinition {
  id: string;
  capabilities?: ModelCapability[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modelsPath = path.resolve(__dirname, '..', 'models.json');

const patterns = {
  imageInput: [/vision/, /gpt-4o/, /gpt-4-vision/, /vl/, /multi_modal/],
  imageOutput: [/image/, /imagen/, /dall-e/, /veo/, /sora/, /imagine/],
  audioInput: [/whisper/, /asr/, /transcribe/, /audio\-input/],
  audioOutput: [/tts/, /audio/],
};

function loadModels(): ModelDefinition[] {
  const raw = fs.readFileSync(modelsPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed?.data ?? [];
}

function inferRequiredCaps(id: string): Set<ModelCapability> {
  const lower = id.toLowerCase();
  const required: Set<ModelCapability> = new Set(['text']);

  if (patterns.imageInput.some((p) => p.test(lower))) required.add('image_input');
  if (patterns.imageOutput.some((p) => p.test(lower))) required.add('image_output');
  if (patterns.audioInput.some((p) => p.test(lower))) required.add('audio_input');
  if (patterns.audioOutput.some((p) => p.test(lower))) required.add('audio_output');

  return required;
}

function main() {
  const models = loadModels();
  const missing: Array<{ id: string; required: ModelCapability[]; actual: ModelCapability[] }> = [];

  for (const model of models) {
    const actual = Array.isArray(model.capabilities) && model.capabilities.length > 0
      ? (model.capabilities as ModelCapability[])
      : (['text'] as ModelCapability[]);
    const required = Array.from(inferRequiredCaps(model.id));

    const missingCaps = required.filter((cap) => !actual.includes(cap));
    if (missingCaps.length > 0) {
      missing.push({ id: model.id, required: missingCaps, actual });
    }
  }

  if (missing.length === 0) {
    console.log('✅ All models satisfy inferred capability requirements.');
    return;
  }

  console.log(`⚠️  ${missing.length} model(s) appear to be missing capabilities:`);
  for (const entry of missing) {
    console.log(`- ${entry.id}: missing ${entry.required.join(', ')} (has: ${entry.actual.join(', ')})`);
  }
}

main();
