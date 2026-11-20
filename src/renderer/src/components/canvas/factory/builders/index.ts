// The Technical Artist's kits for the Factory Floor engine (docs/design/factory-floor.md section 4, slice 2).
import { FACTORY_PALETTE } from '../../../../lib/factory/palette'
import { board, boardLamp, boardLampColour } from './board'
import { booth } from './booth'
import { dock } from './dock'
import { hall } from './hall'
import { createLighting } from './lighting'
import { machine } from './machines'
import { createMaterials } from './materials'
import { props } from './props'
import { robot } from './robot'
import { stackLight } from './stackLight'
import { station } from './station'
import { barrier, crate, fence, holdPad, shutter } from './stateProps'
import type { FactoryKitSource } from './types'

export { GANTRY_TOP } from './common'
export { KEY_DIRECTION } from './lighting'
export { MATERIAL_ROLES } from './materials'
export type { FactoryKitSource, ObjectKit, PartSpec, Anchor } from './types'

export const factoryKits: FactoryKitSource = {
  createMaterials,
  createLighting,
  clearColour: (theme) => FACTORY_PALETTE[theme].clear,
  lampOffColour: (theme) => FACTORY_PALETTE[theme].lampOff,
  hall,
  booth,
  dock,
  board,
  station,
  machine,
  stackLight,
  robot,
  props,
  shutter,
  barrier,
  fence,
  crate,
  holdPad,
  boardLamp,
  boardLampColour
}
