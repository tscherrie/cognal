import { createReadStream } from "node:fs";
import OpenAI from "openai";
import type { TranscriptionResult } from "../types.js";

export class SttAdapter {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(filePath: string): Promise<TranscriptionResult> {
    const response = await this.client.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: "whisper-1"
    });

    return {
      text: response.text,
      language: (response as { language?: string }).language
    };
  }
}
