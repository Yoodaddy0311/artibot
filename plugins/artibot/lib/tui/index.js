/**
 * TUI barrel — terminal UI renderers for Artibot.
 *
 * Keeps per-renderer modules decoupled. Consumers import from this barrel
 * instead of reaching into individual files.
 *
 * @module lib/tui
 */

export {
  renderStatusLine,
  renderFullDashboard,
  readDashboardState,
} from './dashboard.js';
