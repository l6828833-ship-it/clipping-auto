import { useState } from "react";
import { trpc } from "@/lib/trpc";

export type SourceTranscriptionStage = "queued" | "fetching-info" | "checking-captions" | "downloading" | "transcribing";
export type AnalysisRange = { start: number; end: number };

type SourceTranscriptionResult = {
  source: "youtube" | "whisper" | "none";
  transcript: string;
  words: { word: string; start: number; end: number }[];
  wordCount: number;
  title: string;
  duration: number;
  uploader: string;
  note: string;
  skipped?: boolean;
  language?: string;
  analysisRange?: AnalysisRange;
  heatmap?: { start: number; end: number; value: number }[];
  chapters?: { start: number; end: number; title: string }[];
};

export function useSourceTranscription() {
  // The precompiled backend does not expose a generated router type.
  const sourceTrpc = trpc as any;
  const [progress, setProgress] = useState(0);
  const start = sourceTrpc.extract.startTranscription.useMutation();
  const skip = sourceTrpc.extract.skipTranscription.useMutation();
  const { client } = sourceTrpc.useUtils();

  async function transcribe(
    input: { url: string; language: string; allowSpeechToText: boolean; quickImport?: boolean; analysisRange?: AnalysisRange },
    onStage?: (stage: SourceTranscriptionStage) => void,
    onJob?: (id: string) => void,
  ): Promise<SourceTranscriptionResult> {
    setProgress(0);
    const { id } = await start.mutateAsync(input);
    onJob?.(id);
    // The server owns job timeouts. Leave polling active through its two-hour
    // limit so longer sources can return progress or the actual failure.
    const deadline = Date.now() + 125 * 60_000;
    let retries = 0;
    while (Date.now() < deadline) {
      let status;
      try {
        status = await client.extract.transcriptionStatus.query({ id, wait: true });
        retries = 0;
      } catch (error) {
        const failure = error as { cause?: { status?: number }; data?: { httpStatus?: number } };
        const httpStatus = failure?.data?.httpStatus ?? failure?.cause?.status;
        /* A poll can land on a different instance, catch a brief restart, or
         * find the server too busy to answer (429). Keep asking about this
         * job for about two minutes, so a busy moment does not end it. */
        const busy = httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504;
        if ((busy && retries < 8) || (httpStatus === 404 && retries < 3)) {
          retries++;
          await new Promise(resolve => window.setTimeout(resolve, Math.min(15_000, retries * 2000)));
          continue;
        }
        throw error;
      }
      if (status.error) throw new Error(status.error);
      if (status.result) return status.result;
      setProgress(Number(status.progress) || 0);
      onStage?.(status.stage);
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
    throw new Error("Video analysis timed out. Try a shorter video.");
  }
  return { transcribe, skip, progress };
}
