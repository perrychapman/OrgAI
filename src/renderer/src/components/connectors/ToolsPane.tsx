import type { ReactElement } from 'react'
import { ConnectorGallery } from './ConnectorGallery'
import PresetsSection from './PresetsSection'
import McpLibrarySection from '../mcp/McpLibrarySection'

/** App settings > Tools and services: everything under the pane heading (Tools board). */
export default function ToolsPane(): ReactElement {
  return (
    <>
      <ConnectorGallery />
      <PresetsSection />
      <McpLibrarySection />
    </>
  )
}
