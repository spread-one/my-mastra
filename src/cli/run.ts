import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { CHAT_LIMITS, createChat, trimHistory, type Chat, type ChatMessage } from '../chat.js';

const HELP = `my-mastra — 공개 웹 도우미\n\n사용법:\n  npm start\n  npm start -- --prompt "질문"\n  npm start -- -p "질문"\n  npm start -- --help\n\nDEEPSEEK_API_KEY 필수, DEEPSEEK_MODEL 및 EXA_API_KEY 선택.\n대화 명령: /exit (종료), /clear (대화 초기화). Ctrl+C로 취소.\n`;
class UsageError extends Error {}

export function parseArgs(args: string[]): { help?: true; prompt?: string } {
  if (args.length === 0) return {};
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  if (args.length === 2 && ['--prompt', '-p'].includes(args[0]!)) {
    const prompt = args[1]!.trim();
    if (prompt && prompt.length <= CHAT_LIMITS.promptChars) return { prompt };
    throw new UsageError(`질문은 비어 있지 않은 ${CHAT_LIMITS.promptChars}자 이하의 문자열이어야 합니다.`);
  }
  throw new UsageError('인자를 확인하세요. 사용법: --help 또는 --prompt "질문"');
}

export interface CliOptions {
  args: string[];
  env?: NodeJS.ProcessEnv;
  input: Readable;
  output: Writable;
  error: Writable;
  interactive?: boolean;
  signal?: AbortSignal;
  chatFactory?: (config: Config) => Chat;
  deadlineMs?: number;
}

export async function runCli(options: CliOptions): Promise<number> {
  const { output, error } = options;
  let args: ReturnType<typeof parseArgs>;
  let chat: Chat;
  try {
    args = parseArgs(options.args);
    if (args.help) { output.write(HELP); return 0; }
    chat = (options.chatFactory ?? createChat)(loadConfig(options.env));
  } catch (cause) {
    // Provider errors, response bodies and credentials are never printed.
    error.write(`${cause instanceof UsageError || cause instanceof ConfigError ? cause.message : '초기화하지 못했습니다. 환경 설정을 확인하세요.'}\n`);
    return cause instanceof UsageError ? 2 : 1;
  }

  if (options.signal?.aborted) return 130;
  let history: ChatMessage[] = [];
  let failed = false;
  async function ask(prompt: string): Promise<void> {
    if (options.signal?.aborted) return;
    if (prompt.length > CHAT_LIMITS.promptChars) {
      error.write(`질문은 ${CHAT_LIMITS.promptChars}자 이하여야 합니다.\n`);
      failed = true;
      return;
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.deadlineMs ?? CHAT_LIMITS.deadlineMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    const messages: ChatMessage[] = [...history, { role: 'user', content: prompt }];
    // Bound even injected/non-cooperative model implementations. No errors escape to logs.
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('ABORTED'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const reply = await Promise.race([chat(messages, signal), aborted]);
      if (!reply.trim()) throw new Error('EMPTY_REPLY');
      const bounded = reply.slice(0, CHAT_LIMITS.replyChars);
      // Never let untrusted model/web text issue terminal control commands (e.g. OSC clipboard).
      const text = bounded.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
      output.write(`${text}\n${reply.length > bounded.length ? '[응답 길이 제한으로 잘림]\n' : ''}`);
      history = trimHistory([...messages, { role: 'assistant', content: text }]);
    } catch {
      failed = true;
      if (!options.signal?.aborted) error.write(signal.aborted
        ? '응답 시간 제한을 초과했습니다. 더 짧은 질문으로 다시 시도하세요.\n'
        : '응답을 생성하지 못했습니다. API 키·모델·네트워크·요청 한도를 확인하세요.\n');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  if (args.prompt !== undefined) {
    await ask(args.prompt);
  } else {
    const rl = createInterface({ input: options.input, crlfDelay: Infinity, terminal: false });
    const close = () => rl.close();
    options.signal?.addEventListener('abort', close, { once: true });
    try {
      if (options.interactive) output.write('my-mastra: /exit로 종료, /clear로 초기화 (저장 없음).\n> ');
      if (options.signal?.aborted) close();
      for await (const line of rl) {
        if (options.signal?.aborted) break;
        const prompt = line.trim();
        if (prompt === '/exit') break;
        if (prompt === '/clear') { history = []; output.write('대화를 초기화했습니다.\n'); }
        else if (prompt) await ask(prompt);
        if (options.signal?.aborted) break;
        if (options.interactive) output.write('> ');
      }
    } finally {
      options.signal?.removeEventListener('abort', close);
      rl.close();
    }
  }
  return options.signal?.aborted ? 130 : failed ? 1 : 0;
}
