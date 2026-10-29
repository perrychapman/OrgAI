import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'

/** Small ghost button that opens the main-process logs folder. */
export default function LogsLink(): ReactElement {
  const [path, setPath] = useState<string>()

  useEffect(() => {
    void window.orgai.app
      .logPath()
      .then(setPath)
      .catch(() => {})
  }, [])

  return (
    <button
      className="btn ghost sm"
      style={{ marginLeft: 6 }}
      title={path ? `Open logs folder (${path})` : 'Open logs folder'}
      onClick={() => void window.orgai.app.openLogs()}
    >
      Logs
    </button>
  )
}
