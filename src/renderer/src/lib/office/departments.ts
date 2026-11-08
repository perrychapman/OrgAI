interface ReportingMember {
  id: string
  name: string
  parentId: string | null
  departmentContext?: string
}

/** Departments describe actual root reporting branches, independent of visual position or input order. */
export function withOfficeDepartments<T extends ReportingMember>(members: readonly T[]) {
  const lookup = new Map(members.map(member => [member.id, member]))
  const branch = (member: T): T => {
    const path: T[] = []
    const visited = new Map<string, number>()
    let current = member
    while (current.parentId !== null) {
      const repeated = visited.get(current.id)
      if (repeated !== undefined) return path.slice(repeated).sort((a, b) => a.id.localeCompare(b.id))[0]
      visited.set(current.id, path.length)
      path.push(current)
      const parent = lookup.get(current.parentId)
      if (!parent || parent.parentId === null) return current
      current = parent
    }
    return current
  }
  return members.map(member => {
    const central = member.parentId === null
    const lead = branch(member)
    return {
      ...member, central,
      departmentId: central ? 'central' : lead.id,
      departmentName: central ? 'Orchestrators' : [lead.departmentContext, lead.name].filter(Boolean).join(' · '),
      departmentLeadId: lead.id
    }
  })
}
