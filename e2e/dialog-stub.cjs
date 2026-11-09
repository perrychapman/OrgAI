// Electron `-r` module for separation.mjs: records dialog.showErrorBox text into the file named by ORGAI_E2E_DIALOG_LOG
// and returns, so an app launch that refuses its folder never opens a blocking native dialog.
const electron = require('electron')
const fs = require('node:fs')
if (electron && electron.dialog && process.env.ORGAI_E2E_DIALOG_LOG) {
  electron.dialog.showErrorBox = (title, content) => {
    fs.appendFileSync(process.env.ORGAI_E2E_DIALOG_LOG, `${title}\n${content}\n`)
  }
}
