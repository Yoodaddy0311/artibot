/**
 * Child process for tests/learning/kill-switch-concurrency.test.js: records ONE
 * kill-switch failure and prints the result as JSON on stdout.
 *
 * argv[2] is the JSON config handed to recordFailure; argv[3] the plugin root
 * (the test's temp dir, so setMasterEnabled never touches the real config).
 */

import { recordFailure } from '../../lib/learning/kill-switch.js';

const config = JSON.parse(process.argv[2]);
const pluginRoot = process.argv[3];
const result = await recordFailure(
  { feature: 'concurrent-feature', error: `pid ${process.pid}` },
  config,
  { pluginRoot },
);
process.stdout.write(JSON.stringify(result));
