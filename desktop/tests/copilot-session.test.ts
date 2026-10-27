import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcEvent } from '../src/shared/ipc';
import { CopilotSession, type EmitFn } from '../src/main/services/copilot-session';

type Emitted = { channel: string; payload: unknown };

function sseResponse(...deltas: string[]): Response {
  const body = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('CopilotSession', () => {
  let dir: string;
  let emitted: Emitted[];
  let session: CopilotSession;
  const fetchMock = vi.fn<typeof fetch>();

  const emit: EmitFn = (channel, ...payload) => {
    emitted.push({ channel, payload: payload[0] });
  };
  const eventsOf = (channel: string) => emitted.filter((e) => e.channel === channel).map((e) => e.payload);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'copilot-'));
    writeFileSync(
      path.join(dir, 'api-keys.json'),
      JSON.stringify({ cerebras: 'csk-primary', groq: ['gsk-1'], gemini: ['gem-1'] }),
    );
    writeFileSync(path.join(dir, 'resume.txt'), 'Built a payments platform.');
    emitted = [];
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    session = new CopilotSession({
      emit,
      configDirs: [dir],
      captureScreen: () => Promise.resolve({ dataUrl: 'data:image/png;base64,AAAA', width: 2, height: 2 }),
    });
  });

  afterEach(() => {
    session.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never exposes API keys in the config summary', async () => {
    const summary = await session.loadConfig();
    expect(summary).toEqual({ hasAnswerKey: true, hasTranscriptionKey: true, resumeLength: 26, jobDescriptionLength: 0 });
    expect(JSON.stringify(summary)).not.toContain('csk-');
  });

  it('reports the full state on pause and resume', async () => {
    await session.startSession();
    session.pauseSession();
    session.resumeSession();
    expect(eventsOf(IpcEvent.SessionState)).toEqual([
      { active: true, paused: false },
      { active: true, paused: true },
      { active: true, paused: false },
    ]);
  });

  it('ignores transcript while paused or inactive', async () => {
    expect(session.addTranscript('hello')).toEqual({ ok: false });
    await session.startSession();
    session.pauseSession();
    expect(session.addTranscript('hello')).toEqual({ ok: false });
  });

  it('streams an answer from the primary key (a string key counts as slot 0)', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse('Hello', ' there'));
    await session.startSession();
    session.addTranscript('What is a cache?');

    await expect(session.generateAnswer()).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer csk-primary');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: 'gpt-oss-120b', reasoning_effort: 'low', max_completion_tokens: 650 });
    expect(body.messages[0].content).toContain('Built a payments platform.');
    expect(eventsOf(IpcEvent.AnswerChunk)).toEqual(['Hello', ' there']);
    expect(eventsOf(IpcEvent.AnswerDone)).toHaveLength(1);
  });

  it('falls back to the next provider when one fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'From Gemini' }] } }] })}\n\n`),
      );
    await session.startSession();

    await expect(session.generateAnswer('Explain CAP theorem')).resolves.toEqual({ ok: true });

    const [geminiUrl, geminiInit] = fetchMock.mock.calls[1]!;
    expect(String(geminiUrl)).toContain('gemini-3.5-flash-lite:streamGenerateContent');
    expect(String(geminiUrl)).not.toContain('key=');
    expect((geminiInit?.headers as Record<string, string>)['x-goog-api-key']).toBe('gem-1');
    expect(eventsOf(IpcEvent.AnswerChunk)).toEqual(['From Gemini']);
    expect(eventsOf(IpcEvent.Error)).toEqual([]);
  });

  it('surfaces an error when every provider fails', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('nope', { status: 500 })));
    await session.startSession();

    await expect(session.generateAnswer('Explain CAP theorem')).resolves.toEqual({ ok: false });
    expect(eventsOf(IpcEvent.Error)).toEqual(['Gemini HTTP 500: nope']);
  });

  it('transcribes speech, drops hallucinations and auto-answers after the debounce', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(Response.json({ text: 'Thank you.' }))
      .mockResolvedValueOnce(Response.json({ text: 'How does consistent hashing work?' }))
      .mockResolvedValueOnce(sseResponse('Answer'));
    await session.startSession();

    await session.transcribeAudio(Buffer.from('RIFF').toString('base64'));
    expect(eventsOf(IpcEvent.TranscriptUpdate)).toEqual([]);

    await session.transcribeAudio(Buffer.from('RIFF').toString('base64'));
    expect(eventsOf(IpcEvent.TranscriptUpdate)).toEqual([
      { transcript: ['How does consistent hashing work?'], livePartial: '' },
    ]);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventsOf(IpcEvent.AnswerChunk)).toEqual(['Answer']);
  });

  it('cancels a pending auto-answer when paused', async () => {
    vi.useFakeTimers();
    await session.startSession();
    session.addTranscript('Tell me about distributed transactions');
    session.pauseSession();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the two-stage screen pipeline and keeps the result as context', async () => {
    writeFileSync(path.join(dir, 'api-keys.json'), JSON.stringify({ cerebras: ['c0', 'c1'] }));
    fetchMock
      .mockResolvedValueOnce(sseResponse('Task: reverse a list'))
      .mockResolvedValueOnce(sseResponse('def rev(xs): return xs[::-1]'))
      .mockResolvedValueOnce(sseResponse('Follow-up'));
    await session.startSession();

    await expect(session.analyseScreen()).resolves.toEqual({ ok: true });
    const visionBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(visionBody.model).toBe('gemma-4-31b');
    expect(visionBody.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAAA');

    await session.generateAnswer('Make it in-place');
    const followUp = JSON.parse(fetchMock.mock.calls[2]![1]?.body as string);
    expect(JSON.stringify(followUp.messages)).toContain('def rev(xs)');
  });
});
