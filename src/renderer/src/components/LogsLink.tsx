import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Button } from './ui/Button'

/** Ghost button that opens the main-process logs folder. About in App settings also lists the path. */
export default function LogsLink(): ReactElement {
  const [path, setPath] = useState<string>()

  useEffect(() => {
    void window.orgai.app
      .logPath()
      .then(setPath)
      .catch(() => {})
  }, [])

  return (
    <Button size="sm" variant="ghost" title={path ? `Open logs folder (${path})` : 'Open logs folder'} onClick={() => void window.orgai.app.openLogs()}>
      Logs
    </Button>
  )
}
