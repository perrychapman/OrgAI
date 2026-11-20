// Hall lighting (Factory Floor section 4.2): a hemisphere fill, one shadowed directional key from the north-west and a
// low ambient level. No per-station point lights; lamps are unlit materials.
import { AmbientLight, DirectionalLight, HemisphereLight, Vector3 } from 'three'
import { FACTORY_PALETTE } from '../../../../lib/factory/palette'
import type { FactoryLighting, FactoryTheme } from './types'

/**
 * Direction the key light travels: from the north-west, down and to the south-east. Section 4.2's vector
 * (-0.45, -1, 0.35) points south-west, so its x sign is taken as a typo (as in slice 1). The engine places the light
 * at `target - KEY_DIRECTION * distance` and fits the shadow camera to the hall.
 */
export const KEY_DIRECTION = new Vector3(0.45, -1, 0.35).normalize()

export function createLighting(theme: FactoryTheme): FactoryLighting {
  const hemi = new HemisphereLight()
  const key = new DirectionalLight()
  const ambient = new AmbientLight('#ffffff')
  key.castShadow = true
  // Mid-size defaults; the engine sets the map size from its quality step.
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.02

  const applyTheme = (next: FactoryTheme, dim: 'on' | 'paused' | 'ended'): void => {
    const l = FACTORY_PALETTE[next].light
    const k = dim === 'on' ? 1 : dim === 'paused' ? l.dimPaused : l.dimEnded
    hemi.color.set(l.sky)
    hemi.groundColor.set(l.ground)
    hemi.intensity = l.hemisphere * k
    key.color.set(l.key)
    key.intensity = l.keyIntensity * k
    ambient.intensity = l.ambient * k
  }
  applyTheme(theme, 'on')

  return {
    lights: [hemi, key, ambient],
    key,
    applyTheme,
    dispose(): void {
      key.shadow.map?.dispose()
      key.dispose()
      hemi.dispose()
      ambient.dispose()
    }
  }
}
