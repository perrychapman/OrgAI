import type { ReactElement, ReactNode } from 'react'

/** Glass group card holding `SettingRow`s (hairline between rows, 56px minimum row height). Also takes `.field` blocks. */
export function SettingsCard({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }): ReactElement {
  return (
    <div className={className ? `settings-card ${className}` : 'settings-card'} data-testid={testId}>
      {children}
    </div>
  )
}
