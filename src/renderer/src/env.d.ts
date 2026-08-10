/// <reference types="vite/client" />

import type { TimerPlusApi } from '../../shared'

declare global {
  interface Window {
    timerPlus: TimerPlusApi
  }
}

export {}
