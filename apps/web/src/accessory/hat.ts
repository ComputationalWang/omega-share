export const ACCESSORY_IDS: readonly string[] = [];
export function wornHat<T>(_accessory: number, _frame: string, _accessories: { hat(a: number, f: string): T | undefined } | null, _theme: { hat(f: string): T | undefined } | null): T | undefined {
  return undefined;
}
