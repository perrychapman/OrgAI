/** Thrown by RuntimeSession.setPermissionMode for a refusal whose message is plain, path-free text written by OrgAI and safe to show the user. Never wrap provider, SDK or CLI error text in it. */
export class PermissionModeRefusal extends Error {
  readonly userSafe = true as const
  constructor(message: string) {
    super(message)
    this.name = 'PermissionModeRefusal'
  }
}
