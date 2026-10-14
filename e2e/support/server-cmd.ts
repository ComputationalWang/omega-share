export function serverBackend(_env: NodeJS.ProcessEnv): "bun" | "rust" {
  return "bun";
}
export function serverProcess(_env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  return { command: "", args: [] };
}
