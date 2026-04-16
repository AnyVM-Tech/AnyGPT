function joinUniqueTextBlocks(blocks: Array<string | null | undefined>): string {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const text = typeof block === 'string' ? block.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized.join('\n\n');
}

export function extractTextFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part: any) =>
        part && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string'
      )
      .map((part: any) => part.text)
      .filter((text: string) => text.length > 0);
    if (textParts.length > 0) return textParts.join('\n');
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

export function extractInstructionTextFromMessages(rawMessages: any[]): string {
  if (!Array.isArray(rawMessages)) return '';
  return joinUniqueTextBlocks(
    rawMessages
      .filter((message: any) => {
        const role = typeof message?.role === 'string' ? message.role.toLowerCase() : '';
        return role === 'system' || role === 'developer';
      })
      .map((message: any) => extractTextFromContent(message?.content))
  );
}

export function extractInstructionTextFromResponsesInput(input: any): string {
  if (!Array.isArray(input)) return '';
  return joinUniqueTextBlocks(
    input
      .filter((item: any) => {
        const role = typeof item?.role === 'string' ? item.role.toLowerCase() : '';
        return role === 'system' || role === 'developer';
      })
      .map((item: any) => extractTextFromContent(item?.content ?? item))
  );
}

export function extractInstructionTextFromRequestBody(requestBody: any): string {
  const systemTexts = Array.isArray(requestBody?.system)
    ? requestBody.system.filter((value: any) => typeof value === 'string')
    : (typeof requestBody?.system === 'string' ? [requestBody.system] : []);
  const instructions = typeof requestBody?.instructions === 'string' ? requestBody.instructions : '';
  return joinUniqueTextBlocks([...systemTexts, instructions]);
}

export function mergeInstructionTextWithPrompt(prompt: string, instructionText: string): string {
  const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  const normalizedInstruction = typeof instructionText === 'string' ? instructionText.trim() : '';
  if (!normalizedPrompt) return '';
  if (!normalizedInstruction) return normalizedPrompt;
  return `Instructions:\n${normalizedInstruction}\n\nPrompt:\n${normalizedPrompt}`;
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
