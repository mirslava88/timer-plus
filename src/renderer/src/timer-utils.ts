import type { TimerState } from '../../shared'

export function formatTimer(totalSeconds: number): string {
  const negative = totalSeconds < 0
  const absolute = Math.abs(Math.trunc(totalSeconds))
  const hours = Math.floor(absolute / 3600)
  const minutes = Math.floor((absolute % 3600) / 60)
  const seconds = absolute % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${negative ? '−' : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function nextTimerTick(timer: TimerState): TimerState {
  const remaining = timer.remaining - 1
  const overtimeIncrement = remaining < 0 && timer.costPerMinute > 0
    ? timer.costPerMinute / 60
    : 0
  return {
    ...timer,
    remaining,
    overtimeCostTotal: Math.max(0, timer.overtimeCostTotal + overtimeIncrement)
  }
}

export function secondsUntilTime(now: Date, time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return 0
  const target = new Date(now)
  target.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return Math.round((target.getTime() - now.getTime()) / 1000)
}

export function timePartsFromSeconds(totalSeconds: number): Record<'hours' | 'minutes' | 'seconds', string> {
  const absolute = Math.abs(Math.trunc(totalSeconds))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    hours: pad(Math.min(99, Math.floor(absolute / 3600))),
    minutes: pad(Math.floor((absolute % 3600) / 60)),
    seconds: pad(absolute % 60)
  }
}

export function secondsFromTimeParts(parts: Record<'hours' | 'minutes' | 'seconds', string>): number {
  return Math.min(99, Number(parts.hours) || 0) * 3600
    + Math.min(59, Number(parts.minutes) || 0) * 60
    + Math.min(59, Number(parts.seconds) || 0)
}

export function normalizeTimePart(part: 'hours' | 'minutes' | 'seconds', value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 2)
  if (!digits) return ''
  const maximum = part === 'hours' ? 99 : 59
  return String(Math.min(maximum, Number(digits))).padStart(digits.length, '0')
}
