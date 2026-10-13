import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'experiments', 'results');
await mkdir(destination, { recursive: true });
const reports = {};
for (const name of ['learning', 'synthesis', 'planning', 'performance']) {
  process.stderr.write(`NERVA: ${name}\n`);
  const result = spawnSync(process.execPath, [join(root, 'experiments', `${name}.mjs`),
    '--out', join(destination, `${name}.json`)], {
    cwd: root, encoding: 'utf8', timeout: 150_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || 'Experiment failed\n');
    process.exit(1);
  }
  reports[name] = JSON.parse(await readFile(join(destination, `${name}.json`), 'utf8'));
}
assert(reports.learning.runs.every(run => run.status === 'ok'), 'All learning runs must execute');
const summary = {
  learning: reports.learning.summaries.map(row => ({
    configuration: row.configuration, heldoutMseMean: row.heldout_loss.mean,
    thresholdReached: row.threshold_reached_runs,
    stepsToThreshold: row.first_step_at_threshold,
  })),
  synthesis: reports.synthesis.tasks.map(task => ({
    task: task.name, candidates: task.synthesis.candidates,
    expression: task.synthesis.selected?.expression,
    heldoutMse: task.heldOut.mse, stopped: task.synthesis.stopReason,
  })),
  planning: reports.planning.summary,
  performance: {
    decoder: reports.performance.decoder.results.map(row => ({
      vocabularySize: row.vocabularySize,
      prototypeSpeedup: row.measurements.cache_ast_records_only.speedupVsOriginal,
    })),
    inferenceOnlyFusion: reports.performance.fusion.results.map(row => ({
      elements: row.elements, prototypeSpeedup: row.speedup,
    })),
  },
  note: 'Small explicit experiments, not general programming/conversation acceptance. Performance uses temporary prototypes with the limitations in each report.',
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
