/**
 * Wave 7 (cli-standalone.md round 6 item 10): an approved MCP proposal stores the values typed on its card before it
 * changes mcp-library.json or projects.json. When the secret store refuses them, McpService.applyProposal /
 * applyLibraryProposal throw this before any record changed (and every value they wrote is put back), so RunManager
 * keeps the card open waiting for secrets instead of answering it. Light on purpose: RunManager imports it.
 */
export class ProposalSecretsNotSaved extends Error {
  constructor(readonly reason: string) {
    // The store's sentences may end with a period; the caller appends its own.
    super(`The secret values could not be saved: ${reason.replace(/[.\s]+$/, '')}`)
    this.name = 'ProposalSecretsNotSaved'
  }
}
