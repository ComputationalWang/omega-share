export const TYPING_RESEND_MS = 3000;

export interface TypingSender {
  input(text: string): void;
  blur(): void;
  sent(): void;
}

export function createTypingSender(_o: { now: () => number; send: (on: boolean) => boolean }): TypingSender {
  return { input: () => undefined, blur: () => undefined, sent: () => undefined };
}
