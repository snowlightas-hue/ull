// Type declarations for speech-text.js (plain browser ES module).
export interface SpeakableQuestion {
  text?: string;
  speech?: string;
}
export function stripDiacritics(s: string | null | undefined): string;
export function skeleton(input: string | null | undefined): string;
export function sameLetters(a: string, b: string): boolean;
export function addPauses(text: string | null | undefined): string;
export function pickSpeech(question: SpeakableQuestion | string | null | undefined): {
  text: string;
  source: 'speech' | 'text' | 'none';
  reason: 'no_question' | 'plain_string' | 'empty_text' | 'no_speech_variant' | 'speech_changes_words' | 'same_letters';
};
export function speakableText(question: SpeakableQuestion | string | null | undefined, opts?: { pauses?: boolean }): string;
