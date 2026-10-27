// Heuristics that decide when a transcribed utterance is a complete, answerable question.

/** Single-token tails that strongly imply another speech burst is coming. */
const CONTINUATION_TAIL = new Set([
  'and', 'or', 'but', 'so', 'because', 'since', 'while', 'when', 'where',
  'if', 'unless', 'though', 'although', 'as', 'than', 'that', 'which',
  'whether', 'of', 'to', 'for', 'with', 'without', 'by', 'on', 'in', 'into',
  'at', 'from', 'about', 'over', 'under', 'between', 'through', 'across',
  'after', 'before', 'during', 'the', 'a', 'an', 'this', 'these',
  'those', 'your', 'my', 'our', 'their', 'his', 'her', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'uh', 'um', 'ah', 'er', 'like', 'well', 'how',
]);

/** Two-token tails that precede more content. */
const CONTINUATION_TWO = new Set([
  'you know', 'kind of', 'sort of', 'i mean', 'you see',
  'for example', 'such as', 'in other words', 'as in',
  'let me', 'going to', 'want to', 'need to', 'have to',
  'how to', 'how you', 'implemented it',
]);

/** Phrases Whisper tends to invent from silence or background noise. */
const WHISPER_HALLUCINATIONS = new Set([
  'thank you', 'thank you very much', 'thank you thank you',
  'subtitles by', 'subtitles by amaraorg', 'thanks for watching', 'bye',
]);

const FILLERS = new Set(['uh', 'um', 'yeah', 'okay', 'ok', 'so', 'like', 'right', 'ah']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** True when the utterance appears to stop mid-sentence. */
export function looksIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[.!?][)\]"”']?\s*$/.test(trimmed)) return false;
  if (/[,;:—-]\s*$/.test(trimmed)) return true;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return false;
  const last1 = tokens[tokens.length - 1] ?? '';
  const last2 = tokens.slice(-2).join(' ');
  return CONTINUATION_TAIL.has(last1) || CONTINUATION_TWO.has(last2);
}

export function isWhisperHallucination(text: string): boolean {
  const normalized = text.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  if (!normalized) return true;
  if (WHISPER_HALLUCINATIONS.has(normalized)) return true;
  return /^(thank you\s*)+$/.test(normalized) || /^(thanks\s*)+$/.test(normalized) || /^subtitles by/.test(normalized);
}

/** True when the text is substantial enough to auto-answer. */
export function isValidQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isWhisperHallucination(trimmed)) return false;
  if (/\?\s*$/.test(trimmed)) return true;

  const tokens = tokenize(trimmed);
  if (tokens.length < 4) return false;
  return tokens.filter((t) => !FILLERS.has(t)).length >= 3;
}
