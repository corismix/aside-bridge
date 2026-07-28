/**
 * Provider and turn failures, classified the way Aside classifies them.
 *
 * The desktop app does not print a raw provider error. It runs the message
 * through a small ladder of predicates and renders a titled alert card:
 * a bold title, one plain-English sentence, and the raw message behind a
 * `Details` toggle. The mini app showed nothing at all for these turns --
 * a blank response where the browser shows "Request rate limited" -- so the
 * same ladder is reproduced here and the classified result travels to the
 * client as a structured item rather than a string.
 *
 * The predicates and copy are transcribed from the shipped bundle
 * (`error-alert-*.js`). Two shapes matter and both are handled:
 *
 *  - a bare sentence ("Request timed out.")
 *  - a sentence with a JSON blob appended, which is how providers report
 *    themselves ({"error":{"type":"rate_limit_error","message":…}}). The
 *    JSON's `type` / `code` / `status` are what the ladder actually tests,
 *    so it is parsed out rather than pattern-matched inside the envelope.
 */

/** The card the client draws. `detail` is what sits behind `Details`. */
export interface ErrorAlert {
  title: string;
  description: string;
  /** The raw provider message, shown when the reader expands the card. */
  detail: string;
  /** Drives the card's tint: destructive is red, muted is the neutral card. */
  tone: 'muted' | 'destructive';
}

/** Rate limiting, quota exhaustion, 429. */
const RATE_LIMIT =
  /(?:rate|usage)[\s_-]*limit|too many requests|limit has been reached|insufficient[\s_-]*quota|quota exceeded|429/i;

/** Provider-side failure types, as the provider names them. */
const SERVER_TYPE =
  /^(?:api_error|overloaded_error|server_error|server_is_overloaded|slow_down|timeout_error)$/i;

/** Provider-side failure, as it reads in prose. */
const SERVER_TEXT =
  /overloaded|5\d\d|service[\s_-]*unavailable|server[\s_-]*error|internal[\s_-]*error|an error occurred while processing your request|the server had an error while processing your request|you can retry your request|currently experiencing high demand|selected model is at capacity|response\.failed event received|^slow down$/i;

/** Expired or rejected credentials. */
const AUTH =
  /(?:unauthorized|invalid[\s_-]*(?:api[\s_-]*key|token|credential|credentials|grant)|authentication[\s_-]*error|auth(?:entication)?[\s_-]*(?:token[\s_-]*)?(?:expired|invalid|invalidated|reused|failed|error)|token[\s_-]*(?:expired|invalid|invalidated|reused)|credentials?[\s_-]*(?:expired|invalid)|credentials? (?:may have )?expired|signing in again|re-?authenticate)/i;

const UNAUTHORIZED_PREFIX = /^\s*401\b/;
const PAYMENT_REQUIRED = /(?:^\s*402\b|\bAPI error\s*\(\s*402\s*\))/i;

interface Envelope {
  type?: string;
  code?: string;
  status?: number;
  message?: string;
}

/**
 * The JSON a provider appends to its own error sentence, if there is one.
 *
 * Providers write `429 status code (no body)` on one line and
 * `Error: {"error":{"type":"rate_limit_error",…}}` on another, so the first
 * `{` is where the structured part starts. A parse failure is not
 * interesting: the prose predicates still run.
 */
export function parseErrorEnvelope(raw: string): Envelope | undefined {
  const at = String(raw || '').indexOf('{');
  if (at === -1) return undefined;
  try {
    const parsed = JSON.parse(String(raw).slice(at).trim()) as Record<
      string,
      unknown
    >;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const inner = (parsed.error && typeof parsed.error === 'object'
      ? (parsed.error as Record<string, unknown>)
      : parsed) as Record<string, unknown>;
    return {
      type: typeof inner.type === 'string' ? inner.type : undefined,
      code:
        typeof inner.code === 'string'
          ? inner.code
          : typeof inner.code === 'number'
            ? String(inner.code)
            : undefined,
      status: Number.isFinite(Number(inner.status))
        ? Number(inner.status)
        : undefined,
      message: typeof inner.message === 'string' ? inner.message : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * The human-readable part of an error.
 *
 * A wrapped provider error carries its own `message`, which reads far
 * better than the JSON around it; that is what goes behind `Details`.
 */
export function errorText(raw: string): string {
  const envelope = parseErrorEnvelope(raw);
  return (envelope?.message || String(raw || '')).trim();
}

/**
 * `<system-message>` blocks are injected context, not conversation, and are
 * stripped everywhere else in this app. An error that quotes one should not
 * put it on screen either.
 */
function cleaned(raw: string): string {
  return String(raw || '')
    .replace('<has_function_call>', '')
    .replace(/<system-message>[\s\S]*?<\/system-message>/gi, '')
    .trim();
}

function matches(raw: string, pattern: RegExp, statusEquals?: number): boolean {
  const envelope = parseErrorEnvelope(raw);
  const text = errorText(raw);
  if (statusEquals !== undefined && envelope?.status === statusEquals) {
    return true;
  }
  return (
    pattern.test(envelope?.type || '') ||
    pattern.test(envelope?.code || '') ||
    pattern.test(text)
  );
}

export function isRateLimited(raw: string): boolean {
  return matches(raw, RATE_LIMIT, 429);
}

export function isProviderDown(raw: string): boolean {
  const envelope = parseErrorEnvelope(raw);
  if (
    typeof envelope?.status === 'number' &&
    envelope.status >= 500 &&
    envelope.status < 600
  ) {
    return true;
  }
  return (
    SERVER_TYPE.test(envelope?.type || '') ||
    SERVER_TYPE.test(envelope?.code || '') ||
    SERVER_TEXT.test(errorText(raw))
  );
}

export function isAuthFailure(raw: string): boolean {
  if (UNAUTHORIZED_PREFIX.test(String(raw || ''))) return true;
  return matches(raw, AUTH, 401);
}

export function isOutOfCredits(raw: string): boolean {
  return PAYMENT_REQUIRED.test(String(raw || ''));
}

/**
 * Classify a failure into the card Aside would draw for it.
 *
 * `provider` refines only the auth branch, exactly as the desktop app does:
 * it is the difference between "Provider sign-in expired" (an OAuth
 * provider the user can reconnect) and "Provider authentication failed"
 * (an API key someone has to replace).
 */
export function classifyError(
  rawMessage: string,
  opts: { provider?: string; aborted?: boolean } = {},
): ErrorAlert {
  const raw = String(rawMessage || '');
  const detail = cleaned(errorText(raw));

  if (opts.aborted) {
    return {
      title: 'Task was aborted',
      description: 'The previous run was aborted before it finished.',
      detail,
      tone: 'muted',
    };
  }

  if (raw.includes('database or disk is full')) {
    return {
      title: 'Your disk is full',
      description: 'Free up disk space, then try again.',
      detail,
      tone: 'destructive',
    };
  }

  if (opts.provider && isAuthFailure(raw)) {
    const oauth =
      opts.provider === 'openai-codex' || opts.provider === 'claude-code';
    return {
      title: oauth
        ? 'Provider sign-in expired'
        : 'Provider authentication failed',
      description:
        opts.provider === 'openai-codex'
          ? 'Reconnect ChatGPT in Aside on your computer, then try the task again.'
          : opts.provider === 'claude-code'
            ? 'Reconnect Claude in Aside on your computer, then try the task again.'
            : 'Update this model provider in Aside on your computer, then try the task again.',
      detail,
      tone: 'muted',
    };
  }

  if (isRateLimited(raw)) {
    return {
      title: 'Request rate limited',
      description:
        'The model provider temporarily rate-limited this request. Try again later.',
      detail,
      tone: 'muted',
    };
  }

  if (isProviderDown(raw)) {
    return {
      title: 'The AI provider is temporarily unavailable.',
      description:
        'The task stopped because the model request failed with a provider server error. We retried automatically, but the provider did not recover in time. Try again to continue from the latest state.',
      detail,
      tone: 'muted',
    };
  }

  if (isOutOfCredits(raw)) {
    return {
      title: "You're out of credits for this task.",
      description: `${opts.provider || 'provider'}: ${detail}`,
      detail,
      tone: 'muted',
    };
  }

  return {
    title: 'There was an error while running the task',
    description: detail || 'The task stopped before it finished.',
    detail,
    tone: 'destructive',
  };
}

/**
 * The card for a CLI turn that exited non-zero.
 *
 * Distinct from a provider error: the model never refused anything, the
 * process this server spawned died. The stderr tail is the only thing that
 * explains it, so it goes behind `Details` verbatim rather than being
 * paraphrased.
 */
export function execFailureAlert(
  exitCode: number | null,
  stderrTail: string,
): ErrorAlert {
  const detail = cleaned(stderrTail);
  // A provider error can surface through the CLI's own stderr, in which
  // case the ladder above still reads it correctly.
  if (detail && (isRateLimited(detail) || isProviderDown(detail))) {
    return classifyError(detail);
  }
  return {
    title: 'The task could not be run',
    description:
      exitCode === null
        ? 'The Aside CLI stopped before the turn finished.'
        : `The Aside CLI exited with code ${exitCode}.`,
    detail,
    tone: 'destructive',
  };
}
