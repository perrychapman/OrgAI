import type { ReactElement } from 'react'
import { useState } from 'react'
import { isSafeImageDataUrl } from '../../lib/outputPreview'
import { SegmentedControl } from '../ui/SegmentedControl'

type Size = 'fit' | 'actual'

/** A raster image from a checked data URL, fitted or at its own size. */
export default function ImagePreview({ dataUrl, title }: { dataUrl: string; title: string }): ReactElement {
  const [size, setSize] = useState<Size>('fit')
  if (!isSafeImageDataUrl(dataUrl)) {
    return (
      <p className="output-preview-none" data-testid="output-preview-none">
        This image could not be shown. Open the file instead.
      </p>
    )
  }
  const img = <img className="output-image" data-size={size} data-testid="output-image" src={dataUrl} alt={title} />
  return (
    <div className="output-image-wrap">
      <div data-testid="output-image-size" data-value={size}>
        <SegmentedControl<Size>
          label="Size"
          value={size}
          onChange={setSize}
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'actual', label: 'Actual size' }
          ]}
        />
      </div>
      {size === 'actual' ? (
        <div className="output-scroll output-image-scroll" role="region" aria-label={`${title}, actual size`} tabIndex={0}>
          {img}
        </div>
      ) : (
        <div className="output-image-fit">{img}</div>
      )}
    </div>
  )
}
