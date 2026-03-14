export function normalizeInputAudio(audio: { data: string; format: string }): { buffer: Buffer; mimeType: string; extension: string } | null {
  let { data, format } = audio;
  let mimeType = format;

  if (typeof data === 'string' && data.startsWith('data:')) {
    const match = data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      data = match[2];
    }
  }

  if (!mimeType) mimeType = 'audio/wav';
  if (!mimeType.includes('/')) mimeType = `audio/${mimeType}`;
  const extension = mimeType.split('/')[1] || 'wav';

  try {
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) return null;
    return { buffer, mimeType, extension };
  } catch {
    return null;
  }
}

export function detectMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 2) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (buffer.length > 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';
  return null;
}

export function detectMimeTypeFromBase64(base64: string): string | null {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return null;
}

export function isLikelyBase64(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const len = Math.min(buffer.length, 100);
  for (let i = 0; i < len; i++) {
    const byte = buffer[i];
    const isBase64Char =
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      (byte >= 48 && byte <= 57) ||
      byte === 43 || byte === 47 || byte === 61 ||
      byte === 10 || byte === 13 || byte === 32;
    if (!isBase64Char) return false;
  }
  return true;
}

export function parseMultipartBody(buffer: Buffer, boundary: string): { fields: Record<string, string>; files: { name: string; type: string; data: Buffer }[] } {
  const result = { fields: {} as Record<string, string>, files: [] as { name: string; type: string; data: Buffer }[] };
  const delimiter = Buffer.from(`--${boundary}`);
  let start = 0;

  let idx = buffer.indexOf(delimiter, start);
  if (idx === -1) return result;

  while (idx !== -1) {
    start = idx + delimiter.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;

    const nextIdx = buffer.indexOf(delimiter, start);
    const end = (nextIdx === -1) ? buffer.length : nextIdx;

    const partBuffer = buffer.subarray(start, end);
    let headerStart = 0;
    if (partBuffer[0] === 13 && partBuffer[1] === 10) headerStart = 2;
    else if (partBuffer[0] === 10) headerStart = 1;

    const headerEnd = partBuffer.indexOf('\r\n\r\n', headerStart);
    if (headerEnd !== -1) {
      const headers = partBuffer.subarray(headerStart, headerEnd).toString('utf8');
      let bodyEnd = partBuffer.length;
      if (partBuffer.length >= 2 && partBuffer[bodyEnd - 2] === 13 && partBuffer[bodyEnd - 1] === 10) {
        bodyEnd -= 2;
      } else if (partBuffer.length >= 1 && partBuffer[bodyEnd - 1] === 10) {
        bodyEnd -= 1;
      }

      const body = partBuffer.subarray(headerEnd + 4, bodyEnd);

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type: (.+)/i);
      const transferEncodingMatch = headers.match(/Content-Transfer-Encoding: (.+)/i);

      if (filenameMatch) {
        let contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
        let fileData = body;

        if (transferEncodingMatch && transferEncodingMatch[1].trim().toLowerCase() === 'base64') {
          const text = body.toString('utf8').replace(/\s+/g, '');
          fileData = Buffer.from(text, 'base64');
        }

        if (contentType === 'application/octet-stream') {
          contentType = detectMimeTypeFromBuffer(fileData) || 'application/octet-stream';
        }

        result.files.push({
          name: filenameMatch[1],
          type: contentType,
          data: fileData,
        });
      } else if (nameMatch) {
        result.fields[nameMatch[1]] = body.toString('utf8');
      }
    }

    idx = nextIdx;
  }

  return result;
}
