import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { DisplayInfo, TimerSettings, TimerState } from '../shared'

// Electron 43 can crash while starting its GPU process on some Intel Macs
// running macOS 15. Keep hardware acceleration everywhere else, but use the
// stable software-rendering path on Intel macOS before Electron becomes ready.
if (process.platform === 'darwin' && process.arch === 'x64') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

let controlWindow: BrowserWindow | null = null
const outputWindows = new Map<number, BrowserWindow>()
let liveTimer: TimerState | null = null
let liveDisplayIds: number[] = []
let pendingSettings: TimerSettings | null = null
let settingsWriteTimer: NodeJS.Timeout | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'timer-plus-settings.json')
}

function flushSettings(): void {
  if (!pendingSettings) return
  try {
    writeFileSync(settingsPath(), JSON.stringify(pendingSettings, null, 2), 'utf8')
  } catch (error) {
    console.error('[settings] save failed', error)
  }
  pendingSettings = null
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer)
  settingsWriteTimer = null
}

function queueSettings(settings: TimerSettings): void {
  pendingSettings = settings
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer)
  settingsWriteTimer = setTimeout(flushSettings, 700)
}

function loadSettings(): unknown {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')) as unknown
  } catch {
    return null
  }
}

function displayList(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: display.label?.trim() || `Дисплей ${index}`,
    isPrimary: display.id === primaryId,
    width: display.bounds.width,
    height: display.bounds.height,
    scaleFactor: display.scaleFactor
  }))
}

function loadRenderer(window: BrowserWindow, query?: Record<string, string>): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(devUrl)
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value)
    void window.loadURL(url.toString())
    return
  }
  void window.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

function bindEmergencyEscape(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape' || outputWindows.size === 0) return
    event.preventDefault()
    closeAllOutputs()
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.show()
      controlWindow.focus()
    }
  })
}

function createControlWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1110',
    title: 'Таймер+',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  controlWindow = window
  bindEmergencyEscape(window)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    controlWindow = null
    closeAllOutputs()
  })
  loadRenderer(window)
}

function createOutputWindow(displayId: number): BrowserWindow | null {
  const display = screen.getAllDisplays().find((item) => item.id === displayId)
  if (!display) return null

  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    fullscreen: process.platform !== 'darwin',
    simpleFullscreen: process.platform === 'darwin',
    show: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#000000',
    title: `Таймер+ — ${display.label || displayId}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  outputWindows.set(displayId, window)
  bindEmergencyEscape(window)
  window.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'normal')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.once('ready-to-show', () => {
    window.setBounds(display.bounds)
    window.showInactive()
  })
  window.on('closed', () => {
    if (outputWindows.get(displayId) === window) outputWindows.delete(displayId)
  })
  loadRenderer(window, { mode: 'output', displayId: String(displayId) })
  return window
}

function closeAllOutputs(): void {
  for (const window of outputWindows.values()) {
    if (!window.isDestroyed()) window.destroy()
  }
  outputWindows.clear()
  liveTimer = null
  liveDisplayIds = []
}

function reconcileOutputs(): void {
  const desired = new Set(liveDisplayIds)
  for (const [displayId, window] of outputWindows) {
    if (!desired.has(displayId)) {
      window.destroy()
      outputWindows.delete(displayId)
    }
  }
  for (const displayId of desired) {
    if (!outputWindows.has(displayId)) createOutputWindow(displayId)
  }
}

function broadcastLiveTimer(): void {
  for (const window of outputWindows.values()) {
    if (!window.isDestroyed() && !window.webContents.isLoading()) {
      window.webContents.send('live-state', liveTimer)
    }
  }
}

function sendDisplayList(): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('displays-changed', displayList())
  }
  const available = new Set(screen.getAllDisplays().map((display) => display.id))
  const filtered = liveDisplayIds.filter((id) => available.has(id))
  if (filtered.length !== liveDisplayIds.length) {
    liveDisplayIds = filtered
    reconcileOutputs()
  }
}

function registerIpc(): void {
  ipcMain.handle('displays:list', () => displayList())
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.on('settings:save', (_event, settings: TimerSettings) => queueSettings(settings))

  ipcMain.handle('background:select', async () => {
    const options: OpenDialogOptions = {
      title: 'Выберите фон таймера',
      properties: ['openFile'],
      filters: [
        { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
      ]
    }
    const result = controlWindow
      ? await dialog.showOpenDialog(controlWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const extension = extname(path).toLowerCase()
    const mime = extension === '.png'
      ? 'image/png'
      : extension === '.webp'
        ? 'image/webp'
        : extension === '.gif'
          ? 'image/gif'
          : 'image/jpeg'
    try {
      return `data:${mime};base64,${readFileSync(path).toString('base64')}`
    } catch (error) {
      console.error('[background] read failed', error)
      return null
    }
  })

  ipcMain.handle('output:go-live', (_event, displayIds: number[], timer: TimerState) => {
    liveDisplayIds = [...new Set(displayIds.map(Number).filter(Number.isFinite))]
    liveTimer = timer
    reconcileOutputs()
    broadcastLiveTimer()
  })
  ipcMain.on('output:update', (_event, timer: TimerState) => {
    liveTimer = timer
    broadcastLiveTimer()
  })
  ipcMain.handle('output:stop', () => closeAllOutputs())
  ipcMain.on('output:ready', (event, displayId: number) => {
    const window = outputWindows.get(Number(displayId))
    if (!window || window.webContents.id !== event.sender.id) return
    event.sender.send('live-state', liveTimer)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createControlWindow()
  screen.on('display-added', sendDisplayList)
  screen.on('display-removed', sendDisplayList)
  screen.on('display-metrics-changed', sendDisplayList)

  app.on('activate', () => {
    if (!controlWindow) createControlWindow()
  })
})

app.on('before-quit', flushSettings)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
