/**
 * FSM — Finite State Machine for Error Recovery
 *
 * Centralizes all error handling into a state machine with transitions.
 * Each state has defined recovery actions, retry limits, and escalation paths.
 *
 * States:
 *   IDLE        → Waiting for next trading iteration
 *   TRADING     → Active GPT decision + execution cycle
 *   RECOVERING  → Retrying after a recoverable error
 *   RATE_LIMITED → Exchange rate limit hit, backing off
 *   DEGRADED    → Partial failure (e.g. DB down but trading ok)
 *   HALTED      → Unrecoverable error, trading stopped
 *
 * Usage:
 *   const fsm = new FSM();
 *   fsm.transition('TRADING');
 *   fsm.handleError('RATE_LIMIT', { pair: 'LTCUSDT' });
 *   if (fsm.canTrade()) { ... }
 */

const Settings = require('./Settings.js');

// ─── State Definitions ──────────────────────────────────────────────────────

const STATES = {
  IDLE:         'IDLE',
  TRADING:      'TRADING',
  RECOVERING:   'RECOVERING',
  RATE_LIMITED: 'RATE_LIMITED',
  DEGRADED:     'DEGRADED',
  HALTED:       'HALTED',
};

// ─── Error Classification Table ─────────────────────────────────────────────
// Maps error codes/patterns to recovery strategies

const ERROR_TABLE = {
  // ── Exchange Errors ──
  RATE_LIMIT: {
    severity: 'warning',
    nextState: STATES.RATE_LIMITED,
    retryable: true,
    maxRetries: 5,
    backoffMs: 60000,       // 1 minute initial backoff
    backoffMultiplier: 2,   // Exponential: 1m, 2m, 4m, 8m, 16m
    maxBackoffMs: 900000,   // 15 minute cap
    recovery: 'Wait for rate limit window to reset.',
  },
  INSUFFICIENT_BALANCE: {
    severity: 'info',
    nextState: STATES.IDLE,
    retryable: false,
    recovery: 'Insufficient funds. Wait for sells to complete or deposit more.',
  },
  NOTIONAL: {
    severity: 'warning',
    nextState: STATES.RECOVERING,
    retryable: true,
    maxRetries: 1,
    backoffMs: 0,
    recovery: 'Order below minimum notional. AutoTrader handles bump internally.',
  },
  LOT_SIZE: {
    severity: 'warning',
    nextState: STATES.IDLE,
    retryable: false,
    recovery: 'Quantity does not match LOT_SIZE filter. Needs stepSize correction.',
  },
  MARKET_LOT_SIZE: {
    severity: 'warning',
    nextState: STATES.IDLE,
    retryable: false,
    recovery: 'Quantity outside MARKET_LOT_SIZE range.',
  },
  PERCENT_PRICE: {
    severity: 'warning',
    nextState: STATES.IDLE,
    retryable: false,
    recovery: 'Price filter rejection — market too volatile for limit order.',
  },
  PRICE_FILTER: {
    severity: 'warning',
    nextState: STATES.IDLE,
    retryable: false,
    recovery: 'Price outside allowed range.',
  },
  MAX_ORDERS: {
    severity: 'warning',
    nextState: STATES.RATE_LIMITED,
    retryable: true,
    maxRetries: 3,
    backoffMs: 30000,
    recovery: 'Too many open orders. Wait for fills.',
  },
  TIMESTAMP: {
    severity: 'error',
    nextState: STATES.RECOVERING,
    retryable: true,
    maxRetries: 3,
    backoffMs: 5000,
    recovery: 'Clock sync error. Retry with fresh timestamp.',
  },

  // ── Network / Infrastructure ──
  NETWORK_ERROR: {
    severity: 'error',
    nextState: STATES.RECOVERING,
    retryable: true,
    maxRetries: 5,
    backoffMs: 10000,
    backoffMultiplier: 2,
    maxBackoffMs: 300000,
    recovery: 'Network failure. Retry with exponential backoff.',
  },
  TIMEOUT: {
    severity: 'warning',
    nextState: STATES.RECOVERING,
    retryable: true,
    maxRetries: 3,
    backoffMs: 15000,
    recovery: 'Request timed out. Retry.',
  },
  DB_ERROR: {
    severity: 'warning',
    nextState: STATES.DEGRADED,
    retryable: true,
    maxRetries: 3,
    backoffMs: 5000,
    recovery: 'Database error. Trading continues, logging degraded.',
  },
  GPT_ERROR: {
    severity: 'error',
    nextState: STATES.RECOVERING,
    retryable: true,
    maxRetries: 3,
    backoffMs: 30000,
    recovery: 'GPT API failure. Retry after delay.',
  },

  // ── Safety / Critical ──
  EXTERNAL_MODIFICATION: {
    severity: 'critical',
    nextState: STATES.HALTED,
    retryable: false,
    recovery: 'Account modified externally. All trading halted. Manual review required.',
  },
  ACCOUNT_DRAIN: {
    severity: 'critical',
    nextState: STATES.HALTED,
    retryable: false,
    recovery: 'Account drain detected. All trading halted immediately.',
  },
  EXCESSIVE_LOSS: {
    severity: 'critical',
    nextState: STATES.HALTED,
    retryable: false,
    recovery: 'Excessive loss detected. Trading halted for safety.',
  },

  // ── Catch-all ──
  UNKNOWN: {
    severity: 'error',
    nextState: STATES.RECOVERING,
    retryable: true,
    maxRetries: 2,
    backoffMs: 30000,
    recovery: 'Unknown error. Retry cautiously.',
  },
};

// ─── FSM Class ──────────────────────────────────────────────────────────────

class FSM {
  constructor() {
    this.state = STATES.IDLE;
    this.previousState = null;
    this.retryCounters = new Map(); // errorCode → { count, lastAttempt }
    this.history = [];              // Last 100 state transitions
    this.errorLog = [];             // Last 100 errors
    this.haltReason = null;
    this.rateLimitUntil = 0;        // Timestamp when rate limit expires
  }

  // ─── State Management ───────────────────────────────────────────────────

  /**
   * Transition to a new state
   * @param {string} newState - Target state from STATES
   * @param {string} [reason] - Why the transition happened
   */
  transition(newState, reason = '') {
    if (!STATES[newState]) {
      console.error(`[FSM] Invalid state: ${newState}`);
      return;
    }

    this.previousState = this.state;
    this.state = newState;

    const entry = {
      from: this.previousState,
      to: newState,
      reason,
      timestamp: new Date().toISOString(),
    };
    this.history.push(entry);
    if (this.history.length > 100) this.history.shift();

    console.log(`[FSM] ${this.previousState} → ${newState}${reason ? ` (${reason})` : ''}`);
  }

  /**
   * Can we trade right now?
   * @returns {boolean}
   */
  canTrade() {
    if (this.state === STATES.HALTED) return false;
    if (this.state === STATES.RATE_LIMITED && Date.now() < this.rateLimitUntil) return false;

    // Auto-recover from rate limit if timer expired
    if (this.state === STATES.RATE_LIMITED && Date.now() >= this.rateLimitUntil) {
      this.transition(STATES.IDLE, 'Rate limit expired');
    }

    return [STATES.IDLE, STATES.TRADING, STATES.DEGRADED].includes(this.state);
  }

  // ─── Error Handling ─────────────────────────────────────────────────────

  /**
   * Classify a raw error into an FSM error code
   * @param {Error|Object|string} error - The error to classify
   * @returns {string} FSM error code
   */
  classifyError(error) {
    const msg = typeof error === 'string' ? error : (error?.message || error?.error || '');
    const code = error?.errorCode || error?.code || '';

    // Direct code match
    if (ERROR_TABLE[code]) return code;

    // Pattern matching
    const lower = msg.toLowerCase();
    if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many')) return 'RATE_LIMIT';
    if (lower.includes('insufficient') || lower.includes('not enough')) return 'INSUFFICIENT_BALANCE';
    if (lower.includes('notional')) return 'NOTIONAL';
    if (lower.includes('lot_size')) return 'LOT_SIZE';
    if (lower.includes('percent_price')) return 'PERCENT_PRICE';
    if (lower.includes('timestamp')) return 'TIMESTAMP';
    if (lower.includes('external') || lower.includes('drain')) return 'EXTERNAL_MODIFICATION';
    if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) return 'NETWORK_ERROR';
    if (lower.includes('timeout') || lower.includes('etimedout')) return 'TIMEOUT';
    if (lower.includes('gpt') || lower.includes('openai')) return 'GPT_ERROR';
    if (lower.includes('mysql') || lower.includes('er_') || lower.includes('connection lost')) return 'DB_ERROR';

    return 'UNKNOWN';
  }

  /**
   * Handle an error through the FSM pipeline.
   * Returns recovery instructions for the caller.
   *
   * @param {string|Error|Object} error - Raw error or pre-classified code
   * @param {Object} [context={}] - Extra context (pair, action, etc.)
   * @returns {{ retry: boolean, waitMs: number, errorCode: string, recovery: string, halted: boolean }}
   */
  handleError(error, context = {}) {
    const errorCode = typeof error === 'string' && ERROR_TABLE[error]
      ? error
      : this.classifyError(error);

    const rule = ERROR_TABLE[errorCode] || ERROR_TABLE.UNKNOWN;

    // Log the error
    const entry = {
      errorCode,
      severity: rule.severity,
      context,
      message: typeof error === 'string' ? error : (error?.message || JSON.stringify(error)),
      timestamp: new Date().toISOString(),
    };
    this.errorLog.push(entry);
    if (this.errorLog.length > 100) this.errorLog.shift();

    const logPrefix = `[FSM] [${rule.severity.toUpperCase()}]`;
    const logMsg = `${logPrefix} ${errorCode}: ${entry.message}`;
    if (rule.severity === 'critical') console.error(logMsg);
    else if (rule.severity === 'error') console.error(logMsg);
    else console.warn(logMsg);

    // Non-retryable → transition immediately
    if (!rule.retryable) {
      this.transition(rule.nextState, `${errorCode} — ${rule.recovery}`);
      if (rule.nextState === STATES.HALTED) {
        this.haltReason = `${errorCode}: ${rule.recovery}`;
        // Notify Discord
        try { process.discord?.Warn(`🛑 **Trading HALTED** — ${rule.recovery}`); } catch (_) {}
      }
      return { retry: false, waitMs: 0, errorCode, recovery: rule.recovery, halted: rule.nextState === STATES.HALTED };
    }

    // Retryable — check retry counter
    const counter = this.retryCounters.get(errorCode) || { count: 0, lastAttempt: 0 };
    counter.count++;
    counter.lastAttempt = Date.now();
    this.retryCounters.set(errorCode, counter);

    if (counter.count > (rule.maxRetries || 3)) {
      // Exceeded retries → escalate
      console.error(`${logPrefix} ${errorCode} exceeded ${rule.maxRetries} retries. Escalating.`);
      this.transition(STATES.HALTED, `${errorCode} — max retries exceeded`);
      this.haltReason = `${errorCode}: Max retries (${rule.maxRetries}) exceeded`;
      try { process.discord?.Warn(`🛑 **Trading HALTED** — ${errorCode} failed ${counter.count} times. ${rule.recovery}`); } catch (_) {}
      return { retry: false, waitMs: 0, errorCode, recovery: rule.recovery, halted: true };
    }

    // Calculate backoff
    const baseBackoff = rule.backoffMs || 10000;
    const multiplier = rule.backoffMultiplier || 1;
    const maxBackoff = rule.maxBackoffMs || 600000;
    const waitMs = Math.min(baseBackoff * Math.pow(multiplier, counter.count - 1), maxBackoff);

    // Transition to appropriate state
    this.transition(rule.nextState, `${errorCode} — retry ${counter.count}/${rule.maxRetries}`);

    // Set rate limit timer if applicable
    if (rule.nextState === STATES.RATE_LIMITED) {
      this.rateLimitUntil = Date.now() + waitMs;
    }

    return { retry: true, waitMs, errorCode, recovery: rule.recovery, halted: false };
  }

  // ─── Recovery ───────────────────────────────────────────────────────────

  /**
   * Reset retry counter for a specific error (call after successful operation)
   * @param {string} errorCode
   */
  clearError(errorCode) {
    this.retryCounters.delete(errorCode);
  }

  /**
   * Reset all retry counters (call after a fully successful trading cycle)
   */
  clearAllErrors() {
    this.retryCounters.clear();
    if (this.state === STATES.RECOVERING || this.state === STATES.DEGRADED) {
      this.transition(STATES.IDLE, 'All errors cleared');
    }
  }

  /**
   * Manually resume from HALTED state (admin action via Discord /start)
   * @param {string} [reason='Manual resume']
   */
  resume(reason = 'Manual resume') {
    if (this.state !== STATES.HALTED) return;
    this.haltReason = null;
    this.retryCounters.clear();
    this.transition(STATES.IDLE, reason);
    console.log(`[FSM] Resumed trading: ${reason}`);
  }

  // ─── Reporting ──────────────────────────────────────────────────────────

  /**
   * Get current FSM status for /status command or API
   * @returns {Object}
   */
  getStatus() {
    return {
      state: this.state,
      previousState: this.previousState,
      haltReason: this.haltReason,
      rateLimitUntil: this.rateLimitUntil > Date.now() ? new Date(this.rateLimitUntil).toISOString() : null,
      activeRetries: Object.fromEntries(
        [...this.retryCounters.entries()].map(([k, v]) => [k, { count: v.count, last: new Date(v.lastAttempt).toISOString() }])
      ),
      recentErrors: this.errorLog.slice(-10),
      recentTransitions: this.history.slice(-10),
    };
  }
}

// Export singleton + constants
FSM.STATES = STATES;
FSM.ERROR_TABLE = ERROR_TABLE;

module.exports = new FSM();
