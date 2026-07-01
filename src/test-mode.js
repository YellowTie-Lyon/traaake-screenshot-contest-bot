// Test mode configuration — driven by .env variables
// Set TEST_MODE=true on the VPS to activate, remove when done

export const TEST_MODE = process.env.TEST_MODE === 'true';

// Duration of one contest in minutes (default: until next Wednesday 18h)
export const TEST_CONTEST_DURATION_MINUTES = parseInt(process.env.TEST_CONTEST_DURATION_MINUTES ?? '60', 10);

// Delay in minutes before auto-reopening after close (default: 2)
export const TEST_REOPEN_DELAY_MINUTES = parseInt(process.env.TEST_REOPEN_DELAY_MINUTES ?? '2', 10);

// Tiebreak extension in minutes (default: 30)
export const TEST_TIEBREAK_DURATION_MINUTES = parseInt(process.env.TEST_TIEBREAK_DURATION_MINUTES ?? '30', 10);

// Tiebreak check interval in seconds (default: 30)
export const TEST_TIEBREAK_CHECK_SECONDS = parseInt(process.env.TEST_TIEBREAK_CHECK_SECONDS ?? '30', 10);

if (TEST_MODE) {
  console.log('[TEST MODE] Active —', {
    contestDuration: `${TEST_CONTEST_DURATION_MINUTES}min`,
    reopenDelay: `${TEST_REOPEN_DELAY_MINUTES}min`,
    tiebreakDuration: `${TEST_TIEBREAK_DURATION_MINUTES}min`,
    tiebreakCheck: `${TEST_TIEBREAK_CHECK_SECONDS}s`,
  });
}
