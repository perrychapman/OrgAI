/**
 * Opens the run side panel when it is a rail (its "Show run panel" button, the only way in from outside SidePanel) and,
 * after the user's own action, moves focus to the Outputs tab. Call it after `openRunOutput`.
 */
export function revealOutputsTab(): void {
  document.querySelector<HTMLElement>('aside.side-panel[data-collapsed="true"] .side-rail button')?.click()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      // A shown item's heading is the better landing; otherwise the tab itself.
      const target = document.querySelector<HTMLElement>('[data-testid=output-detail-heading]') ?? document.querySelector<HTMLElement>('[data-testid=side-tab-outputs]')
      target?.focus({ preventScroll: true })
    })
  )
}
