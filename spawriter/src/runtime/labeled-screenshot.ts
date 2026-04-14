export interface ImageProfile {
  maxBytes: number;
  maxLongEdge: number;
  format: 'png' | 'webp' | 'jpeg';
  quality: number;
}

const MODEL_PROFILES: Record<string, ImageProfile> = {
  'claude-opus-4.6':    { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-sonnet-4.6':  { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-opus':        { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-sonnet':      { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude':             { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'gpt-5.4':            { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
  'gpt-5.4-mini':       { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
  'gpt-5.3-codex':      { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
  'codex':              { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
  'gemini-3':           { maxBytes: 15_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
  'gemini':             { maxBytes: 15_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
};

const DEFAULT_IMAGE_PROFILE: ImageProfile = { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 };

const TIER_LIMITS = { high: 5_000_000, medium: 5_000_000, low: 1_000_000 } as const;

export function resolveImageProfile(tier: string, modelHint?: string): ImageProfile & { effectiveLimit: number } {
  const tierLimit = TIER_LIMITS[tier as keyof typeof TIER_LIMITS] ?? TIER_LIMITS.medium;

  if (modelHint) {
    const key = modelHint.toLowerCase().trim();
    const profile = MODEL_PROFILES[key]
      ?? Object.entries(MODEL_PROFILES).find(([k]) => key.includes(k))?.[1];
    if (profile) {
      return { ...profile, effectiveLimit: Math.min(profile.maxBytes, tierLimit) };
    }
  }

  switch (tier) {
    case 'high':
      return { ...DEFAULT_IMAGE_PROFILE, format: 'png', quality: 100, effectiveLimit: tierLimit };
    case 'low':
      return { maxBytes: 1_000_000, maxLongEdge: 1280, format: 'webp', quality: 40, effectiveLimit: tierLimit };
    default:
      return { ...DEFAULT_IMAGE_PROFILE, effectiveLimit: tierLimit };
  }
}

export const MAX_COMPRESS_RETRIES = 3;

export type CdpSender = (method: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>;

export async function captureWithSizeGuarantee(
  sendCdp: CdpSender,
  profile: ImageProfile & { effectiveLimit: number },
  commandTimeout = 30000,
): Promise<{ data: string; mimeType: string; originalSize: number; finalSize: number; compressed: boolean }> {
  const captureParams: Record<string, unknown> = { format: profile.format };
  if (profile.format !== 'png') {
    captureParams.quality = profile.quality;
  }

  let result = await sendCdp('Page.captureScreenshot', captureParams, commandTimeout) as { data: string };
  const originalSize = Math.ceil(result.data.length * 3 / 4);

  if (originalSize <= profile.effectiveLimit) {
    return {
      data: result.data,
      mimeType: profile.format === 'png' ? 'image/png' : 'image/webp',
      originalSize,
      finalSize: originalSize,
      compressed: false,
    };
  }

  let quality = profile.format === 'png'
    ? Math.min(90, Math.floor(80 * (profile.effectiveLimit / originalSize) * 0.8))
    : Math.floor(profile.quality * (profile.effectiveLimit / originalSize) * 0.8);
  quality = Math.max(10, quality);

  for (let i = 0; i < MAX_COMPRESS_RETRIES; i++) {
    result = await sendCdp('Page.captureScreenshot',
      { format: 'webp', quality, optimizeForSpeed: true }, commandTimeout) as { data: string };
    const size = Math.ceil(result.data.length * 3 / 4);

    if (size <= profile.effectiveLimit) {
      return { data: result.data, mimeType: 'image/webp', originalSize, finalSize: size, compressed: true };
    }
    quality = Math.max(10, Math.floor(quality * 0.5));
  }

  result = await sendCdp('Page.captureScreenshot',
    { format: 'webp', quality: 10, optimizeForSpeed: true }, commandTimeout) as { data: string };
  return {
    data: result.data,
    mimeType: 'image/webp',
    originalSize,
    finalSize: Math.ceil(result.data.length * 3 / 4),
    compressed: true,
  };
}
