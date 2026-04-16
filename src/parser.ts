const LENGTH_MARKER_PATTERN = /(\d+)\n/y;
const FLICKER_ESC_RE = /\\+[`*_~].*$/;

export function getCleanText(value: string): string {
  if (!value) {
    return "";
  }
  let text = value;
  if (text.endsWith("\n```")) {
    text = text.slice(0, -4);
  }
  return text.replace(FLICKER_ESC_RE, "");
}

export function getDeltaByFpLen(newRaw: string, lastSentClean: string, isFinal: boolean): { delta: string; fullText: string } {
  const newClean = isFinal ? newRaw : getCleanText(newRaw);

  if (newClean.startsWith(lastSentClean)) {
    return { delta: newClean.slice(lastSentClean.length), fullText: newClean };
  }

  let prefixLength = 0;
  const limit = Math.min(newClean.length, lastSentClean.length);
  while (prefixLength < limit && newClean[prefixLength] === lastSentClean[prefixLength]) {
    prefixLength += 1;
  }

  return { delta: newClean.slice(prefixLength), fullText: newClean };
}

function getCharCountForUtf16Units(input: string, startIndex: number, utf16Units: number): { charCount: number; unitsFound: number } {
  let count = 0;
  let units = 0;

  while (units < utf16Units && startIndex + count < input.length) {
    const codePoint = input.codePointAt(startIndex + count);
    if (codePoint === undefined) {
      break;
    }
    const isSurrogate = codePoint > 0xffff;
    const unitCount = isSurrogate ? 2 : 1;
    if (units + unitCount > utf16Units) {
      break;
    }
    units += unitCount;
    count += 1; // 代理对在 JS 字符串中也只占 1 个元素位置
  }

  return { charCount: count, unitsFound: units };
}

export function parseResponseByFrame(content: string): { frames: unknown[]; remaining: string } {
  let consumed = 0;
  const frames: unknown[] = [];

  while (consumed < content.length) {
    while (consumed < content.length && /\s/.test(content[consumed] ?? "")) {
      consumed += 1;
    }

    if (consumed >= content.length) {
      break;
    }

    LENGTH_MARKER_PATTERN.lastIndex = consumed;
    const match = LENGTH_MARKER_PATTERN.exec(content);
    if (!match) {
      break;
    }

    const lengthValue = match[1] ?? "0";
    // Google's length marker includes the trailing \n after the JSON payload.
    // Subtract 1 to get the actual data content length.
    const declaredLength = Number.parseInt(lengthValue, 10);
    const length = Math.max(0, declaredLength - 1);
    const startContent = match.index + lengthValue.length;
    const { charCount, unitsFound } = getCharCountForUtf16Units(content, startContent, length);
    if (unitsFound < length) {
      break;
    }

    const endPosition = startContent + charCount;
    const chunk = content.slice(startContent, endPosition).trim();
    consumed = endPosition;

    if (!chunk) {
      continue;
    }

    try {
      const parsed = JSON.parse(chunk) as unknown;
      if (Array.isArray(parsed)) {
        frames.push(...parsed);
      } else {
        frames.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return { frames, remaining: content.slice(consumed) };
}
