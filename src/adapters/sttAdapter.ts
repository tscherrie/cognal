import { createReadStream } from "node:fs";
import OpenAI from "openai";
import type { TranscriptionResult } from "../types.js";
import { classifySttError } from "../core/errors.js";
import { retryAsync } from "../core/utils.js";

export class SttAdapter {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(filePath: string): Promise<TranscriptionResult> {
    const response = await retryAsync(
      async () =>
        await this.client.audio.transcriptions.create({
          file: createReadStream(filePath),
          model: "whisper-1"
        }),
      {
        attempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 8_000,
        classifyError: classifySttError
      }
    );

    return {
      text: response.text,
      language: (response as { language?: string }).language
    };
  }
}
