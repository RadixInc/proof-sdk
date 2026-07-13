import { formatActivityActor } from '../editor/actor';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    formatActivityActor('human:pat.example@example.com', null) === 'Pat Example',
    'human actor should format via deriveDisplayNameFromEmail',
  );

  assert(
    formatActivityActor('ai:claude-code', null) === 'Claude Code',
    'bare agent actor should format via deriveAgentNameFromId',
  );

  assert(
    formatActivityActor('ai:claude-code', 'pat.example@example.com') === 'Claude Code (via Pat Example)',
    'delegated agent actor should append "(via <Operator>)"',
  );

  assert(formatActivityActor(null, null) === 'Unknown', 'null actor should format as Unknown');

  console.log('ok: actor-activity-format');
}

run();
