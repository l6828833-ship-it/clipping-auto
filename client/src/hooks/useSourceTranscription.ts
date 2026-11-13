import { trpc } from "@/lib/trpc";

export type SourceTranscriptionStage = "fetching-info" | "checking-captions" | "downloading" | "transcribing";

type SourceTranscriptionResult = {
  source: "youtube" | "whisper" | "none";
  transcript: string;
  words: { word: string; start: number; end: number }[];
  wordCount: number;
  title: string;
  duration: number;
  uploader: string;
  note: string;
  language?: string;
  heatmap?: { start: number; end: number; value: number }[];
  chapters?: { start: number; end: number; title: string }[];
};

export function useSourceTranscription() {
  // The precompiled backend does not expose a generated router type.
  const sourceTrpc = trpc as any;
  const start = sourceTrpc.extract.startTranscription.useMutation();
  const { client } = sourceTrpc.useUtils();

  return async function transcribe(
    input: { url: string; language: string; allowSpeechToText: boolean },
    onStage?: (stage: SourceTranscriptionStage) => void,
  ): Promise<SourceTranscriptionResult> {
    const { id } = await start.mutateAsync(input);
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const status = await client.extract.transcriptionStatus.query({ id, wait: true });
      if (status.error) throw new Error(status.error);
      if (status.result) return status.result;
      onStage?.(status.stage);
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
    throw new Error("Video analysis timed out. Try a shorter video.");
  };
}
