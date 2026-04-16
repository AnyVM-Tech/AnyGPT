export type VeoAudioVariant = 'with_audio' | 'without_audio';
export type VeoVideoResolution = '720p' | '1080p' | '4k';

type VeoVariantPricingSpec = {
  defaultPerSecond: number;
  resolutions: Partial<Record<VeoVideoResolution, number>>;
};

type VeoModelPricingSpec = {
  defaultVariant: VeoAudioVariant;
  variants: Record<VeoAudioVariant, VeoVariantPricingSpec>;
};

const VIDEO_SPECIAL_DISCOUNT_FACTOR = 0.20;

const VEO_MODEL_PRICING: Record<string, VeoModelPricingSpec> = {
  'veo-3.0-generate-001': {
    defaultVariant: 'with_audio',
    variants: {
      with_audio: {
        defaultPerSecond: 0.40,
        resolutions: {
          '720p': 0.40,
          '1080p': 0.40,
        },
      },
      without_audio: {
        defaultPerSecond: 0.20,
        resolutions: {
          '720p': 0.20,
          '1080p': 0.20,
        },
      },
    },
  },
  'veo-3.0-fast-generate-001': {
    defaultVariant: 'with_audio',
    variants: {
      with_audio: {
        defaultPerSecond: 0.10,
        resolutions: {
          '720p': 0.10,
          '1080p': 0.12,
          '4k': 0.30,
        },
      },
      without_audio: {
        defaultPerSecond: 0.08,
        resolutions: {
          '720p': 0.08,
          '1080p': 0.10,
          '4k': 0.25,
        },
      },
    },
  },
  'veo-3.1-generate-preview': {
    defaultVariant: 'with_audio',
    variants: {
      with_audio: {
        defaultPerSecond: 0.40,
        resolutions: {
          '720p': 0.40,
          '1080p': 0.40,
          '4k': 0.60,
        },
      },
      without_audio: {
        defaultPerSecond: 0.20,
        resolutions: {
          '720p': 0.20,
          '1080p': 0.20,
          '4k': 0.40,
        },
      },
    },
  },
  'veo-3.1-fast-generate-preview': {
    defaultVariant: 'with_audio',
    variants: {
      with_audio: {
        defaultPerSecond: 0.10,
        resolutions: {
          '720p': 0.10,
          '1080p': 0.12,
          '4k': 0.30,
        },
      },
      without_audio: {
        defaultPerSecond: 0.08,
        resolutions: {
          '720p': 0.08,
          '1080p': 0.10,
          '4k': 0.25,
        },
      },
    },
  },
};

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getAliasedFieldValue(source: any, aliases: string[]): any {
  if (!source || typeof source !== 'object') return undefined;
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) {
      const value = source[alias];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function normalizeVideoModelId(modelId: string): string {
  const trimmed = String(modelId || '').trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
}

function resolveVeoModelPricingSpec(modelId: string): VeoModelPricingSpec | null {
  const normalized = normalizeVideoModelId(modelId);
  return VEO_MODEL_PRICING[normalized] || null;
}

function normalizeResolutionValue(value: unknown): VeoVideoResolution | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '720p') return '720p';
  if (normalized === '1080p') return '1080p';
  if (normalized === '4k') return '4k';
  return null;
}

function normalizeResolutionFromSize(value: unknown): VeoVideoResolution | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === '1280x720' ||
    normalized === '720x1280'
  ) {
    return '720p';
  }
  if (
    normalized === '1920x1080' ||
    normalized === '1080x1920'
  ) {
    return '1080p';
  }
  if (
    normalized === '3840x2160' ||
    normalized === '2160x3840'
  ) {
    return '4k';
  }
  return null;
}

export function resolveVeoRequestedResolution(
  modelId: string,
  requestBody: any
): VeoVideoResolution | null {
  if (!resolveVeoModelPricingSpec(modelId)) return null;
  const explicitResolution = normalizeResolutionValue(
    getAliasedFieldValue(requestBody, ['resolution'])
  );
  if (explicitResolution) return explicitResolution;
  return normalizeResolutionFromSize(
    getAliasedFieldValue(requestBody, ['size'])
  );
}

function normalizeVariantToken(value: unknown): VeoAudioVariant | null {
  if (typeof value === 'boolean') {
    return value ? 'with_audio' : 'without_audio';
  }

  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!normalized) return null;

  if (
    normalized === 'with_audio' ||
    normalized === 'audio' ||
    normalized === 'withaudio' ||
    normalized === 'audio_on' ||
    normalized === 'audio_enabled' ||
    normalized === 'enabled' ||
    normalized === 'true'
  ) {
    return 'with_audio';
  }

  if (
    normalized === 'without_audio' ||
    normalized === 'no_audio' ||
    normalized === 'withoutaudio' ||
    normalized === 'mute' ||
    normalized === 'muted' ||
    normalized === 'silent' ||
    normalized === 'audio_off' ||
    normalized === 'audio_disabled' ||
    normalized === 'disabled' ||
    normalized === 'false'
  ) {
    return 'without_audio';
  }

  return null;
}

export function resolveVeoRequestedAudioVariant(
  modelId: string,
  requestBody: any
): VeoAudioVariant | null {
  if (!resolveVeoModelPricingSpec(modelId)) return null;

  for (const field of [
    'model_variant',
    'modelVariant',
    'variant',
    'video_variant',
    'videoVariant',
    'audio_variant',
    'audioVariant',
  ]) {
    const variant = normalizeVariantToken(getAliasedFieldValue(requestBody, [field]));
    if (variant) return variant;
  }

  const explicitAudioEnabled = getAliasedFieldValue(requestBody, [
    'generateAudio',
    'generate_audio',
    'with_audio',
    'withAudio',
    'includeAudio',
    'include_audio',
    'audioEnabled',
    'audio_enabled',
  ]);
  if (typeof explicitAudioEnabled === 'boolean') {
    return explicitAudioEnabled ? 'with_audio' : 'without_audio';
  }

  const explicitNoAudio = getAliasedFieldValue(requestBody, [
    'without_audio',
    'withoutAudio',
    'mute',
    'muted',
  ]);
  if (typeof explicitNoAudio === 'boolean') {
    return explicitNoAudio ? 'without_audio' : 'with_audio';
  }

  const audioField = getAliasedFieldValue(requestBody, ['audio']);
  if (typeof audioField === 'boolean') {
    return audioField ? 'with_audio' : 'without_audio';
  }
  if (audioField && typeof audioField === 'object') {
    const nestedEnabled = getAliasedFieldValue(audioField, ['enabled', 'generateAudio', 'generate_audio']);
    if (typeof nestedEnabled === 'boolean') {
      return nestedEnabled ? 'with_audio' : 'without_audio';
    }
  }

  return null;
}

function resolveVariantPerSecond(
  spec: VeoModelPricingSpec,
  variant: VeoAudioVariant,
  resolution: VeoVideoResolution | null
): number {
  const variantSpec = spec.variants[variant];
  if (!variantSpec) return 0;
  if (resolution && typeof variantSpec.resolutions[resolution] === 'number') {
    return variantSpec.resolutions[resolution]!;
  }
  return variantSpec.defaultPerSecond;
}

export function resolveVideoPricingUnitRateOverride(
  modelId: string,
  requestBody: any
): number | null {
  const spec = resolveVeoModelPricingSpec(modelId);
  if (!spec) return null;

  const resolution = resolveVeoRequestedResolution(modelId, requestBody);
  const variant = resolveVeoRequestedAudioVariant(modelId, requestBody)
    || spec.defaultVariant;
  const basePerSecond = resolveVariantPerSecond(spec, variant, resolution);
  if (!(basePerSecond > 0)) return null;

  return roundTo(basePerSecond * VIDEO_SPECIAL_DISCOUNT_FACTOR, 8);
}

function buildVariantPricingDescriptor(
  spec: VeoModelPricingSpec,
  variant: VeoAudioVariant
): Record<string, any> {
  const variantSpec = spec.variants[variant];
  const defaultPerSecond = roundTo(
    variantSpec.defaultPerSecond * VIDEO_SPECIAL_DISCOUNT_FACTOR,
    8
  );

  const resolutions: Record<string, any> = {};
  for (const [resolution, price] of Object.entries(variantSpec.resolutions)) {
    if (!(typeof price === 'number' && price > 0)) continue;
    const discounted = roundTo(price * VIDEO_SPECIAL_DISCOUNT_FACTOR, 8);
    resolutions[resolution] = {
      per_image: discounted,
      per_second: discounted,
      billing_unit: 'second',
    };
  }

  return {
    per_image: defaultPerSecond,
    per_second: defaultPerSecond,
    billing_unit: 'second',
    ...(Object.keys(resolutions).length > 0 ? { resolutions } : {}),
  };
}

export function buildVideoPricingMetadata(modelId: string): Record<string, any> | null {
  const spec = resolveVeoModelPricingSpec(modelId);
  if (!spec) return null;

  const defaultPricing = buildVariantPricingDescriptor(spec, spec.defaultVariant);
  return {
    billing_unit: 'second',
    per_second: defaultPricing.per_second,
    default_variant: spec.defaultVariant,
    video_variants: {
      with_audio: buildVariantPricingDescriptor(spec, 'with_audio'),
      without_audio: buildVariantPricingDescriptor(spec, 'without_audio'),
    },
  };
}
