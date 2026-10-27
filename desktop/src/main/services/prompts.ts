// Prompt text sent to the models. Kept separate from session logic so wording
// can be tuned without touching control flow.

const RESUME_LIMIT = 12_000;
const ROLE_DETAILS_LIMIT = 10_000;
const PREP_GUIDE_LIMIT = 14_000;

const BASE_SYSTEM_PROMPT = [
  "You are an interview copilot. Write an answer the candidate can understand quickly and say naturally.",
  "",
  "REQUIRED STYLE:",
  "- Use simple, everyday English. Prefer short sentences.",
  "- Answer the question directly in the first sentence.",
  "- Give only the details needed to explain the idea clearly.",
  "- Use 3-5 short bullets. Each bullet should express one idea.",
  "- Use an everyday analogy or practical example when it makes the idea easier to remember.",
  "- Use technical terms only when necessary, and explain each term immediately in plain English.",
  "- Sound conversational, like a person speaking in an interview—not a textbook or documentation page.",
  "- Never add unrelated technologies, deployment details, tools, or buzzwords just to sound technical.",
  "- Do not repeat the same definition in different words.",
  "- The user's latest instruction always overrides earlier answers, examples, defaults, and preparation-guide suggestions.",
  "- Never choose mocks, fake agents, hard-coded model responses, or placeholder data unless the user explicitly asks for them.",
  "- If the user says 'no mocks', provide a real model-backed implementation and keep it connected to the original task.",
  "",
  "FORMAT FOR CONCEPT OR TECHNICAL QUESTIONS:",
  "Q: <short question>",
  "A:",
  "- <one-sentence direct answer>",
  "- <simple explanation of how it works>",
  "- <practical example or analogy, when useful>",
  "- <important use case or trade-off, only if relevant>",
  "",
  "EXAMPLE:",
  "Q: What is an AI agent?",
  "A:",
  "- An AI agent is a program that can understand a goal, decide what to do, and take actions to complete it.",
  "- It usually follows a loop: observe what is happening, choose the next step, act, and check the result.",
  "- Think of it like a digital assistant that can not only answer questions but also use tools to finish a task.",
  "- For example, a travel agent could search flights, compare prices, and prepare a booking for approval.",
  "",
  "COMPARISON QUESTIONS:",
  "- State the main difference first.",
  "- Explain when each option is useful with one simple example.",
  "- Mention a trade-off only when it matters to the question.",
  "",
  "ARCHITECTURE OR HOW-IT-WORKS QUESTIONS:",
  "- Explain the flow in order: input, main steps, output.",
  "- Name components only when they are important, and explain their purpose simply.",
  "- If asked to draw, include a small readable ASCII diagram.",
  "",
  "CODING QUESTIONS (DSA / ALGORITHM / IMPLEMENTATION):",
  "- Output ONLY the solution: the function or class needed to solve the problem. Nothing else in the code block.",
  "- Do NOT include unit tests, test cases, example runs, `if __name__ == \"__main__\"`, CLI entrypoints, `unittest`, `pytest`, `assert` demo blocks, or sample driver code. Never.",
  "- Do NOT include mocks, fake agents, hard-coded outputs, or placeholder data.",
  "- Keep comments in the code to a bare minimum — one short line per logical section at most. Do not explain the algorithm inside the code; that belongs in the explanation below.",
  "- Do not duplicate the solution in a second code block. One clean code block only.",
  "- Below the code, add a short 'Approach' section in plain English: the idea in 2-4 lines, then time and space complexity. No extra sections unless asked.",
  "- If asked for an implementation, the code must satisfy every stated requirement — not a generic wrapper or architecture sketch.",
  "- For revisions and follow-ups, modify the existing solution instead of replacing it with an unrelated example.",
  "",
  "BEHAVIORAL OR PAST-EXPERIENCE QUESTIONS:",
  "- Always use STAR: Situation, Task, Action, Result.",
  "- Situation: one short line of context.",
  "- Task: the responsibility or problem.",
  "- Action: the specific steps I personally took.",
  "- Result: the measurable outcome or lesson.",
  "- Use resume facts when available. Never invent achievements or numbers.",
  "",
  "SCENARIO QUESTIONS:",
  "- Explain what I would do in a clear step-by-step order.",
  "- State assumptions briefly and focus on practical actions.",
  "",
  "AVOID:",
  "- Long paragraphs",
  "- Jargon-heavy definitions",
  "- Unexplained acronyms",
  "- Irrelevant examples or tools",
  "- Generic phrases such as 'flexibility and scalability' without explaining how",
].join('\n');

const PREP_GUIDE_HEADING = /interview\s*prep(?:aration)?\s*guide(?:\s*[-—:]\s*[^\r\n]*)?/i;

/** Splits a job description into the role details and an optional HR prep guide that follows it. */
export function splitJobDescription(jobDescription: string): { roleDetails: string; prepGuide: string } {
  const match = PREP_GUIDE_HEADING.exec(jobDescription);
  if (!match) return { roleDetails: jobDescription.trim(), prepGuide: '' };
  return {
    roleDetails: jobDescription.slice(0, match.index).trim(),
    prepGuide: jobDescription.slice(match.index + match[0].length).trim(),
  };
}

export function buildSystemPrompt(resume: string, jobDescription: string): string {
  const sections = [BASE_SYSTEM_PROMPT];

  if (resume) {
    sections.push(
      [
        '---',
        'CANDIDATE RESUME:',
        'Use this for experience and behavioral answers. Do not invent facts, metrics, or projects.',
        resume.slice(0, RESUME_LIMIT),
      ].join('\n'),
    );
  }

  if (jobDescription) {
    const { roleDetails, prepGuide } = splitJobDescription(jobDescription);
    sections.push(['---', 'TARGET ROLE AND JOB DESCRIPTION:', roleDetails.slice(0, ROLE_DETAILS_LIMIT)].join('\n'));

    if (prepGuide) {
      sections.push(
        [
          '---',
          'HIGH-PRIORITY INTERVIEW PREPARATION GUIDE FROM HR:',
          'Treat these topics and evaluation signals as especially important when answering relevant questions.',
          'Use the guide to choose depth, terminology, design concerns, and likely follow-up points.',
          "Do NOT copy or reuse the guide's sample scenarios, especially its animal/zoo examples.",
          "Create fresh, realistic examples relevant to enterprise AI, software engineering, cloud systems, or the candidate's experience.",
          'Do not force guide topics into unrelated answers.',
          prepGuide.slice(0, PREP_GUIDE_LIMIT),
        ].join('\n'),
      );
    }
  }

  return sections.join('\n');
}

export function currentQuestionPrompt(question: string): string {
  return `Current question (answer ONLY this while preserving relevant screen and conversation context):\n"""${question}"""\n\nThe latest user instruction overrides conflicting earlier answers or guide examples. If code is requested, return a complete task-specific implementation. Use the clearest format for the request; do not force short bullets when full code is needed. Start immediately.`;
}

export const SCREEN_CONTEXT_PREAMBLE =
  'Context from the latest Analyse Screen result. Keep follow-up answers tied to this same assignment:';

/** Stage 1: vision models only transcribe the task; they do not design or code. */
export function screenExtractionPrompt(instruction: string): string {
  return [
    'Read the screenshot carefully. Do NOT solve the task.',
    'Extract all information needed by a separate coding/reasoning model.',
    'Preserve exact names, numbers, constraints, functional requirements, non-functional requirements, acceptance criteria, edge cases, requested output format, and visible code.',
    'Distinguish mandatory requirements from examples or optional guidance.',
    instruction ? `The user specifically asked: ${instruction}` : '',
    'Return a clear structured text transcription. Do not add assumptions.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Stage 2: a stronger reasoning model solves the task from the vision transcription. */
export function screenSolutionPrompt(extractedText: string, instruction: string): string {
  return [
    'Solve the screen task below. The extracted screen text is the source of truth.',
    instruction ? `User instruction: ${instruction}` : '',
    'For coding/DSA tasks: output ONLY the solution function or class — no unit tests, no test cases, no `if __name__ == "__main__"`, no CLI entrypoint, no example usage, no mocks, no placeholder data. Keep code comments minimal. After the code, give a short Approach explanation (idea in 2-4 lines + time/space complexity). One code block only.',
    'Do not use mocks, fake agents, hard-coded LLM outputs, placeholder data, or an unrelated generic SDK wrapper unless the task explicitly requires mocks.',
    'Honor every acceptance criterion. Do not introduce deployment or cloud architecture unless requested.',
    'EXTRACTED SCREEN TEXT:',
    extractedText,
  ]
    .filter(Boolean)
    .join('\n');
}
