// The one Vite feature the reference service uses in the main process: import.meta.glob with ?raw, eager. The node
// tsconfig has types ["node"] only (no vite/client, which would drag DOM types in), so the overload is declared here.
interface ImportMeta {
  glob(
    pattern: string | readonly string[],
    options: { query: '?raw'; import: 'default'; eager: true }
  ): Record<string, string>
  // Lazy form (docs.ts): one loader per file, nothing is parsed until it is called.
  glob(
    pattern: string | readonly string[],
    options: { query: '?raw'; import: 'default' }
  ): Record<string, () => Promise<string>>
}
