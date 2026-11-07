import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { isSafeImageDataUrl, svgDataUrl } from '../../lib/outputPreview'
import { SegmentedControl } from '../ui/SegmentedControl'

/** A raster image (data URL checked) or SVG source (shown only as an img data URL, never inline). */
export default function ImageView({
  dataUrl,
  svgText,
  output
}: {
  dataUrl?: string
  svgText?: string
  output: RunOutput
  labelledBy?: string
}): ReactElement {
  const [size, setSize] = useState<'fit' | 'actual'>('fit')
  const src = useMemo(() => {
    if (svgText !== undefined) return svgDataUrl(svgText)
    return dataUrl && isSafeImageDataUrl(dataUrl) ? dataUrl : ''
  }, [dataUrl, svgText])
  if (!src) {
    return (
      <p className="output-preview-note" data-testid="output-preview-none">
        This image could not be shown. Open the file instead.
      </p>
    )
  }
  const isSvg = svgText !== undefined
  const img = (
    <img
      src={src}
      alt={output.title}
      className="output-img"
      data-size={isSvg ? 'fit' : size}
      data-testid={isSvg ? 'output-svg-img' : 'output-image'}
    />
  )
  return (
    <div className="output-image-view">
      {!isSvg && (
        <div data-testid="output-image-size">
          <SegmentedControl
            label="Image size"
            value={size}
            onChange={setSize}
            options={[
              { value: 'fit', label: 'Fit' },
              { value: 'actual', label: 'Actual size' }
            ]}
          />
        </div>
      )}
      {!isSvg && size === 'actual' ? (
        <div className="output-image-scroll" role="region" aria-label={`${output.title} at actual size`} tabIndex={0}>
          {img}
        </div>
      ) : (
        <div className="output-image-fit">{img}</div>
      )}
    </div>
  )
}
