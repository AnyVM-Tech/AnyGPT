export function extractTextFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find((part: any) =>
      part && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string'
    );
    if (textPart?.text) return textPart.text;
  }
  return '';
}

export function extractInputAudioFromContent(content: any): { data: string; format: string } | null {
  if (!Array.isArray(content)) return null;
  const audioPart = content.find((part: any) =>
    part && part.type === 'input_audio' && part.input_audio
    && typeof part.input_audio.data === 'string'
    && typeof part.input_audio.format === 'string'
  );
  if (!audioPart) return null;
  return { data: audioPart.input_audio.data, format: audioPart.input_audio.format };
}

export function extractImageUrlFromContent(content: any): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type || '').toLowerCase();
    if (type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
    if (type === 'input_image') {
      const url = typeof (part as any).image_url === 'string' ? (part as any).image_url : (part as any).image_url?.url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  return null;
}

export function extractTextFromMessages(rawMessages: any[]): string {
  if (!Array.isArray(rawMessages)) return '';
  const lastUser = rawMessages.filter(m => m?.role === 'user').pop();
  if (!lastUser) return '';
  return extractTextFromContent(lastUser.content);
}

export function extractInputAudioFromMessages(rawMessages: any[]): { data: string; format: string } | null {
  if (!Array.isArray(rawMessages)) return null;
  for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
    const msg = rawMessages[i];
    const audio = extractInputAudioFromContent(msg?.content);
    if (audio) return audio;
  }
  return null;
}

export function extractImageUrlFromMessages(rawMessages: any[]): string | null {
  if (!Array.isArray(rawMessages)) return null;
  for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
    const msg = rawMessages[i];
    const url = extractImageUrlFromContent(msg?.content);
    if (url) return url;
  }
  return null;
}

export function extractTextFromResponsesInput(input: any): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      const content = item?.content ?? item;
      const text = extractTextFromContent(content);
      if (text) return text;
    }
  }
  return '';
}

export function extractInputAudioFromResponsesInput(input: any): { data: string; format: string } | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const content = item?.content ?? item;
      const audio = extractInputAudioFromContent(content);
      if (audio) return audio;
    }
  }
  return null;
}

export function extractImageUrlFromResponsesInput(input: any): string | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const content = item?.content ?? item;
      const url = extractImageUrlFromContent(content);
      if (url) return url;
    }
  }
  return null;
}
