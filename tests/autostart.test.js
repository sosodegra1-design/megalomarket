import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgents, SERVER_LABEL, WATCHER_LABEL, REPORT_LABEL } from '../src/services/autostart.js';

test('the hourly report agent runs every 3600 s, is not kept alive and pushes the report', () => {
  const agents = buildAgents({ nodePath: '/usr/bin/node', projectDir: '/p', logDir: '/l' });
  const report = agents.find((a) => a.label === REPORT_LABEL);
  assert.match(report.plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.match(report.plist, /scripts\/report\.mjs<\/string>\s*<string>--push<\/string>/);
  assert.ok(!report.plist.includes('KeepAlive'));
});

test('two launchd agents are built, restarted on exit, with absolute paths', () => {
  const all = buildAgents({ nodePath: '/opt/homebrew/bin/node', projectDir: '/Users/hobb/megalomarket', logDir: '/Users/hobb/Library/Logs/Megalomarket' });
  assert.deepEqual(all.map((a) => a.label), [SERVER_LABEL, WATCHER_LABEL, REPORT_LABEL]);
  const agents = all.slice(0, 2);
  const [server, watcher] = agents;
  assert.match(server.plist, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/hobb\/megalomarket\/src\/server\.js<\/string>/);
  assert.match(watcher.plist, /scripts\/watch-bookmarks\.mjs/);
  for (const agent of agents) {
    assert.match(agent.plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(agent.plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(agent.plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/hobb\/megalomarket<\/string>/);
    assert.match(agent.plist, /\/opt\/homebrew\/bin:/, 'node est trouvable par launchd (PATH explicite)');
  }
});

test('paths with special characters are XML-escaped', () => {
  const [server] = buildAgents({ nodePath: '/usr/bin/node', projectDir: '/Users/a&b/<x>', logDir: '/tmp' });
  assert.ok(server.plist.includes('/Users/a&amp;b/&lt;x&gt;'));
  assert.ok(!server.plist.includes('a&b'));
});
