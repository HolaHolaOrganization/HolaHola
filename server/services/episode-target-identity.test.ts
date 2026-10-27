import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeFilenameFromTitle, selectEpisodeTarget } from './episode-target-identity';

test('rolling subtitled title round-trips without changing its title or ID', () => {
  const row = { id: 'synthetic-35', title: "Episode 35: Alden's Entry into the Record" };
  const filename = episodeFilenameFromTitle(row.title);
  assert.equal(filename, 'episode-35-aldens-entry-into-the-record.md');
  assert.equal(selectEpisodeTarget(filename, [row]), row);
  assert.equal(selectEpisodeTarget('episode-35.md', [row]), row);
});

test('plain numbered episodes and nonnumbered legacy slugs still round-trip', () => {
  for (const title of ['Episode 27', 'An Earlier Conversation']) {
    const row = { id: title, title };
    assert.equal(selectEpisodeTarget(episodeFilenameFromTitle(title), [row]), row);
  }
});

test('missing, unsafe, numbered-prefix collisions and ambiguous rows fail closed', () => {
  const row = { id: 'one', title: 'Episode 35: A title' };
  assert.equal(selectEpisodeTarget('episode-3.md', [row]), null);
  assert.equal(selectEpisodeTarget('episode-35.md', [{ id: 'wrong', title: 'Episode 350' }]), null);
  assert.throws(() => selectEpisodeTarget('../episode-35.md', [row]), /invalid_episode/);
  assert.throws(() => selectEpisodeTarget('episode-35.md', [
    row, { id: 'two', title: 'Episode 35' },
  ]), /ambiguous_episode_target/);
  assert.throws(() => selectEpisodeTarget('episode-35-a-title.md', [
    row, { id: 'two', title: 'Episode 35: A title!' },
  ]), /ambiguous_episode_target/);
});
