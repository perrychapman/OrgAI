import type { ReactElement, ReactNode } from 'react'

/** Surface-2 card holding `SettingRow`s (hairline between rows, 56px minimum row height). Also takes `.field` blocks. */
export function SettingsCard({ children, testId }: { children: ReactNode; testId?: string }): ReactElement {
  return (
    <div className="settings-card" data-testid={testId}>
      {children}
    </div>
  )
}
