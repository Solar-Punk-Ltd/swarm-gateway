import { logger } from './logger'

interface SharedAnswersOptions<T> {
  /** Names the answers in the log line written when a stale one is served. */
  label: string
  /** Milliseconds an answer is served before the next request reads it again. */
  freshFor: number
  /** Milliseconds a good answer is still served, counted from when it was read, while every refresh fails. */
  staleFor: number
  /** Whether an answer is worth serving again when a later refresh fails. */
  isGood: (value: T) => boolean
}

interface DatedAnswer<T> {
  value: T
  at: number
}

const SWEEP_SIZE = 1000

/**
 * Answers per key that concurrent callers share: while a key is being read, every caller waits on that
 * one read. When a refresh throws, the last good answer is served for up to `staleFor` after it was
 * read, and the failure is logged. Past that, or with no good answer yet, the refresh's error is thrown.
 */
export class SharedAnswers<T> {
  private static readonly all = new Set<SharedAnswers<unknown>>()

  private readonly fresh = new Map<string, DatedAnswer<T>>()
  private readonly pending = new Map<string, Promise<T>>()
  private readonly good = new Map<string, DatedAnswer<T>>()

  constructor(private readonly options: SharedAnswersOptions<T>) {
    SharedAnswers.all.add(this as SharedAnswers<unknown>)
  }

  /** Forgets every answer of every instance, the good ones included. */
  static forgetAll() {
    for (const answers of SharedAnswers.all) {
      answers.fresh.clear()
      answers.pending.clear()
      answers.good.clear()
    }
  }

  get(key: string, read: () => Promise<T>): Promise<T> {
    const fresh = this.fresh.get(key)
    if (fresh && Date.now() - fresh.at < this.options.freshFor) {
      return Promise.resolve(fresh.value)
    }
    const pending = this.pending.get(key)
    if (pending) {
      return pending
    }
    const refresh = this.refresh(key, read).finally(() => this.pending.delete(key))
    this.pending.set(key, refresh)
    return refresh
  }

  private async refresh(key: string, read: () => Promise<T>): Promise<T> {
    try {
      const value = await read()
      const now = Date.now()
      this.sweep(now)
      this.fresh.set(key, { value, at: now })
      if (this.options.isGood(value)) {
        this.good.set(key, { value, at: now })
      }
      return value
    } catch (error) {
      const now = Date.now()
      const good = this.good.get(key)
      if (!good || now - good.at > this.options.staleFor) {
        this.good.delete(key)
        throw error
      }
      logger.warn(`${this.options.label} refresh failed, serving the last good answer`, {
        key,
        ageSeconds: Math.round((now - good.at) / 1000),
        error,
      })
      this.fresh.set(key, { value: good.value, at: now })
      return good.value
    }
  }

  private sweep(now: number) {
    if (this.fresh.size >= SWEEP_SIZE) {
      for (const [key, answer] of this.fresh) {
        if (now - answer.at >= this.options.freshFor) {
          this.fresh.delete(key)
        }
      }
    }
    if (this.good.size >= SWEEP_SIZE) {
      for (const [key, answer] of this.good) {
        if (now - answer.at > this.options.staleFor) {
          this.good.delete(key)
        }
      }
    }
  }
}
