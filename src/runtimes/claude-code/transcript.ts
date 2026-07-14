import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

interface TranscriptTextBlock {
  type: string;
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: TranscriptTextBlock[] | string;
  };
}

/**
 * Last assistant message text from a Claude Code session transcript (JSONL).
 * Reads the whole file line-by-line and keeps the last match — transcripts are
 * append-only and modest in size.
 */
export async function readLastAssistantMessage(transcriptPath: string): Promise<string | null> {
  let last: string | null = null;
  const rl = createInterface({ input: createReadStream(transcriptPath, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      if (typeof content === 'string') {
        if (content.trim().length > 0) last = content;
        continue;
      }
      if (Array.isArray(content)) {
        const text = content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text.length > 0) last = text;
      }
    }
  } finally {
    rl.close();
  }
  return last;
}
