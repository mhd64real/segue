// Vitest runs test files through Vite, which provides import.meta.glob. Vite is only a
// transitive dependency, so its client types are not resolvable from this project. This
// declares the subset the tests use. It is not available in Next.js code.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: { eager?: false; import?: string; query?: string },
  ): Record<string, () => Promise<T>>;
}
