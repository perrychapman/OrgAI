/**
 * Redacts exact secret values from streamed text without emitting a prefix before the value is complete.
 * Provider callbacks may split arbitrary strings across chunks, so each stream keeps only a possible secret
 * prefix between calls. The retained text is bounded by the longest secret seen.
 */
export class StreamingSecretRedactor {
  private pending = ''
  private pendingCoverage = new Uint8Array(0)
  private redactionOpen = false
  private readonly knownSecrets = new Set<string>()

  constructor(
    private readonly replacement = '[redacted]',
    private readonly minimumSecretLength = 1
  ) {}

  /** Add the current secrets and return only text that can no longer become part of a secret. */
  push(chunk: string, secrets: Iterable<string>, final = false): string {
    for (const secret of secrets) {
      if (secret.length >= this.minimumSecretLength) this.knownSecrets.add(secret)
    }
    const ordered = [...this.knownSecrets].sort((a, b) => b.length - a.length)
    const source = this.pending + chunk
    const coverage = new Uint8Array(source.length)
    coverage.set(this.pendingCoverage)

    // Mark every occurrence, including overlapping occurrences such as `abca` in `abcabca`.
    for (const secret of ordered) {
      let from = 0
      while (from <= source.length - secret.length) {
        const at = source.indexOf(secret, from)
        if (at < 0) break
        coverage.fill(1, at, at + secret.length)
        from = at + 1
      }
    }

    if (final) {
      // Avoid writing a trailing prefix of a known secret when a stream ends mid-value.
      for (const secret of ordered) {
        const minFragment = Math.min(4, secret.length - 1)
        for (let length = Math.min(secret.length - 1, source.length); length >= minFragment && length > 0; length--) {
          if (source.endsWith(secret.slice(0, length))) {
            coverage.fill(1, source.length - length)
            break
          }
        }
      }
    }

    let heldSuffix = 0
    if (!final) {
      for (const secret of ordered) {
        for (let length = Math.min(secret.length - 1, source.length); length > heldSuffix; length--) {
          if (source.endsWith(secret.slice(0, length))) {
            heldSuffix = length
            break
          }
        }
      }
    }
    const stableEnd = source.length - heldSuffix
    const output: string[] = []
    let coveredRun = this.redactionOpen
    let plainStart = -1
    for (let i = 0; i < stableEnd; i++) {
      if (coverage[i]) {
        if (plainStart >= 0) {
          output.push(source.slice(plainStart, i))
          plainStart = -1
        }
        if (!coveredRun) output.push(this.replacement)
        coveredRun = true
      } else {
        if (coveredRun) coveredRun = false
        if (plainStart < 0) plainStart = i
      }
    }
    if (plainStart >= 0) output.push(source.slice(plainStart, stableEnd))

    this.pending = source.slice(stableEnd)
    this.pendingCoverage = coverage.slice(stableEnd)
    this.redactionOpen = coveredRun
    if (final) {
      this.pending = ''
      this.pendingCoverage = new Uint8Array(0)
      this.redactionOpen = false
    }
    return output.join('')
  }
}
