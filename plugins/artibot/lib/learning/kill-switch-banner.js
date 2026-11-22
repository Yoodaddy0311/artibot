/**
 * The SessionStart kill-switch banner text. Pure: no fs, no state reads, and no import of
 * `kill-switch.js`, which resolves the paths, reads the state and calls these
 * (`kill-switch.js#killSwitchBannerLines`, `#describeKillSwitchStatus`).
 *
 * Every line claims a pause ("일시 중지") ONLY when the production gate stops:
 * `self-control-gates.js#resolveSelfControlGates` stops on `masterEnabled === false` and on
 * the per-feature state (fail-closed when that file cannot be read), and never reads the
 * emergency file. Whether it should is an owner design decision, not made here. Paths are
 * wrapped in backticks so a Korean particle after them cannot blur where they end. No line
 * names a slash command: none exists for recovery (tests pin both).
 *
 * @module lib/learning/kill-switch-banner
 */

/** @param {string} p @returns {string} */
const q = (p) => `\`${p}\``;

/**
 * The emergency-switch line, or null when it is not tripped. A pause is claimed only with
 * the master switch off; an unreadable emergency file is reported as such (the gate does
 * not read it); a trip whose master write has not landed says the next failure retries it.
 *
 * @param {{tripped: boolean, failuresPast1h: number|null, statePath?: string, masterRetryPending?: true}} state
 *   a `kill-switch.js#getKillSwitchState` result
 * @param {object} [config] - the loaded artibot config, the one the gate reads
 * @param {{configPath: string, featureStatePath: string}} paths - files the recovery advice names
 * @returns {string|null}
 */
export function emergencyBannerLine(state, config, paths) {
  if (!state?.tripped) return null;
  const masterOff = config?.ago?.selfControl?.masterEnabled === false;
  if (state.failuresPast1h === null) {
    return `[artibot:kill-switch — 상태를 확인할 수 없습니다: ${q(state.statePath)} (파일 잠금·권한을 확인하세요)`
      + `${masterOff ? '. 마스터 스위치가 꺼져 있어 자가 통제는 일시 중지 상태입니다' : ''}]`;
  }
  if (masterOff) {
    return `[artibot:kill-switch-tripped — 연속 실패로 자가 통제가 일시 중지됐습니다. 다시 켜려면 ${q(paths.configPath)}`
      + `의 ago.selfControl.masterEnabled 를 true 로 되돌리세요 (스스로 트립된 기능은 ${q(paths.featureStatePath)}`
      + '에서 그 기능 항목도 지워야 다시 열립니다).]';
  }
  return state.masterRetryPending
    ? '[artibot:kill-switch-tripped — 연속 실패로 트립됐지만 마스터 스위치를 끄지 못해 자가 통제는 계속 동작합니다. 다음 실패 기록 때 다시 끕니다.]'
    : '[artibot:kill-switch-tripped — 연속 실패로 트립됐지만 마스터 스위치가 켜져 있어 자가 통제는 계속 동작합니다.]';
}

/**
 * The per-feature line: features whose own `trippedAt` keeps their gate closed — it never
 * expires and nothing in the plugin resets it, so without this line the feature simply
 * stopped with no word (lane B 2026-11-22, probe F) — or, when that state could not be
 * read, the fail-closed answer: the gate then stops EVERY feature. Null when none tripped.
 *
 * @param {{names: string[], readError: Error|null, statePath: string}} features
 * @returns {string|null}
 */
export function featureBannerLine(features) {
  if (features.readError) {
    return `[artibot:kill-switch — 기능별 상태를 확인할 수 없어 모든 자가 통제 기능이 안전하게 일시 중지돼 있습니다: ${q(features.statePath)}`
      + ' (파일 잠금·권한을 확인하세요)]';
  }
  if (features.names.length === 0) return null;
  return `[artibot:kill-switch-feature — 연속 실패로 트립되어 일시 중지된 자가 통제 기능: ${features.names.join(', ')}.`
    + ` 다시 열려면 ${q(features.statePath)}에서 그 기능 항목을 지우세요]`;
}
