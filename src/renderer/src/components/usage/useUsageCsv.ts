import { useCallback, useRef, useState } from 'react'
import { cleanIpcError } from '../../lib/ipcError'
import { copiedText, csvRowCount } from '../../lib/trends'
import { overviewQuery, type UsageFilters } from '../../lib/usageOverview'
import { usageCsvFileName } from '../../lib/usagePage'

export interface UsageCsv {
  status: { text: string; failed: boolean } | null
  busy: boolean
  copy: () => Promise<void>
  save: () => Promise<void>
}

/**
 * Copy as CSV / Save CSV... over runs:usageOverviewCsv for the page's query (period, kinds and projects; the
 * model, role, day and connection narrowings are chips on top of it). Same handlers and wording as Trends.
 */
export function useUsageCsv(filters: UsageFilters): UsageCsv {
  const [status, setStatus] = useState<UsageCsv['status']>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef(filters)
  ref.current = filters

  const fetchCsv = useCallback(async (): Promise<{ csv: string; now: number }> => {
    const now = Date.now()
    return { csv: await window.orgai.runs.usageOverviewCsv(overviewQuery(ref.current, now)), now }
  }, [])

  const copy = useCallback(async () => {
    setBusy(true)
    try {
      const { csv } = await fetchCsv()
      // No BOM on the clipboard: pasted text would start with an invisible character.
      await navigator.clipboard.writeText(csv.replace(/^﻿/, ''))
      setStatus({ text: copiedText(csvRowCount(csv)), failed: false })
    } catch (e) {
      setStatus({ text: `Could not copy: ${cleanIpcError(e)}`, failed: true })
    } finally {
      setBusy(false)
    }
  }, [fetchCsv])

  const save = useCallback(async () => {
    setBusy(true)
    try {
      const { csv, now } = await fetchCsv()
      // Exactly one BOM (main already writes one) keeps spreadsheet apps from misreading non-ASCII titles.
      const url = URL.createObjectURL(new Blob(['﻿', csv.replace(/^﻿/, '')], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = usageCsvFileName(ref.current.period, now)
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      // The renderer cannot see where or whether the download finishes, so the notice says only what is known.
      setStatus({ text: 'Your browser is saving the CSV.', failed: false })
    } catch (e) {
      setStatus({ text: `Could not save: ${cleanIpcError(e)}`, failed: true })
    } finally {
      setBusy(false)
    }
  }, [fetchCsv])

  return { status, busy, copy, save }
}
