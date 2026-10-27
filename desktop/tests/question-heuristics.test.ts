import { describe, expect, it } from 'vitest';
import { isValidQuestion, isWhisperHallucination, looksIncomplete } from '../src/main/services/question-heuristics';

describe('looksIncomplete', () => {
  it.each([
    ['How would you design a cache?', false],
    ['Tell me about your last project.', false],
    ['Explain the difference between', true],
    ['What happens when you', false],
    ['Walk me through how you', true],
    ['First, consider the trade-offs,', true],
    ['', false],
  ])('%j -> %s', (text, expected) => {
    expect(looksIncomplete(text)).toBe(expected);
  });
});

describe('isWhisperHallucination', () => {
  it.each(['Thank you.', 'thank you thank you', 'Thanks for watching!', 'Subtitles by Amara.org', '   ', 'Bye.'])(
    'flags %j',
    (text) => expect(isWhisperHallucination(text)).toBe(true),
  );

  it('keeps real speech', () => {
    expect(isWhisperHallucination('Thank you for joining, let us start with system design')).toBe(false);
  });
});

describe('isValidQuestion', () => {
  it('accepts anything ending in a question mark', () => {
    expect(isValidQuestion('Why?')).toBe(true);
  });

  it('requires enough substantive words otherwise', () => {
    expect(isValidQuestion('uh yeah okay so')).toBe(false);
    expect(isValidQuestion('tell me about kafka')).toBe(true);
    expect(isValidQuestion('design a cache')).toBe(false);
  });

  it('rejects hallucinations even with a question mark', () => {
    expect(isValidQuestion('Thank you.')).toBe(false);
  });
});
